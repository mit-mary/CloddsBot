/**
 * Smart Order Router
 *
 * Routes orders to the best platform based on:
 * - Price (best bid/ask)
 * - Liquidity (available size at price)
 * - Fees (maker/taker)
 * - Speed (execution latency)
 *
 * Supports:
 * - Polymarket
 * - Kalshi
 * - EVM DEXes (Uniswap, 1inch)
 * - Solana DEXes (Jupiter, Raydium)
 */

import { EventEmitter } from 'eventemitter3';
import { logger } from '../utils/logger';
import type { Platform, Orderbook } from '../types';
import type { FeedManager } from '../feeds/index';
import { getMarketFeatures, getLiquidityScore, getSpreadPct } from '../services/feature-engineering';
import {
  FEE_UNKNOWN,
  quotePolymarketFee,
  simulateBookFill,
  type FeeStatus,
} from './prediction-market-economics';

// =============================================================================
// TYPES
// =============================================================================

export type RoutingMode = 'best_price' | 'best_liquidity' | 'lowest_fee' | 'balanced';

export interface SmartRouterConfig {
  /** Routing optimization mode (default: 'balanced') */
  mode?: RoutingMode;
  /** Enabled platforms for routing */
  enabledPlatforms?: Platform[];
  /** Maximum acceptable slippage % (default: 1) */
  maxSlippage?: number;
  /** Prefer maker orders when possible (default: true) */
  preferMaker?: boolean;
  /** Split orders across platforms if beneficial (default: false) */
  allowSplitting?: boolean;
  /** Maximum number of platforms to split across (default: 3) */
  maxSplitPlatforms?: number;
  /** Minimum improvement % to justify split (default: 0.5) */
  minSplitImprovement?: number;
  /** Use feature-based scoring for route selection (default: true) */
  useFeatureScoring?: boolean;
  /** Weight for liquidity score in balanced mode (default: 0.2) */
  liquidityWeight?: number;
}

export interface RouteQuote {
  platform: Platform;
  price: number;
  requestedSize: number;
  availableSize: number;
  estimatedFees: number | null;
  netPrice: number | null; // price +/- fees per share
  feeStatus: FeeStatus;
  fillStatus: 'full' | 'partial' | 'none';
  executable: boolean;
  blockReason?: string;
  slippage: number;
  executionTimeMs?: number;
  isMaker: boolean;
}

export interface ExecutableRouteQuote extends RouteQuote {
  estimatedFees: number;
  netPrice: number;
  feeStatus: 'KNOWN';
  executable: true;
}

export interface RoutingResult {
  bestRoute: ExecutableRouteQuote;
  allRoutes: ExecutableRouteQuote[];
  /** Diagnostic quotes that were blocked by depth, maker uncertainty, or FEE_UNKNOWN. */
  blockedRoutes?: RouteQuote[];
  splitRoutes?: ExecutableRouteQuote[];
  totalSavings: number;
  recommendation: string;
}

export interface OrderRouteParams {
  /** Market identifier (matched across platforms) */
  marketId: string;
  /** Alternative identifiers for cross-platform matching */
  alternativeIds?: Record<Platform, string>;
  /** Order side */
  side: 'buy' | 'sell';
  /** Order size in shares (legacy field name retained for API compatibility) */
  size: number;
  /** Limit price (optional for market orders) */
  limitPrice?: number;
}

export interface SmartRouterEvents {
  routeFound: (result: RoutingResult) => void;
  routingFailed: (error: Error, params: OrderRouteParams) => void;
  priceUpdate: (platform: Platform, price: number) => void;
}

export interface SmartRouter extends EventEmitter<keyof SmartRouterEvents> {
  findBestRoute(params: OrderRouteParams): Promise<RoutingResult>;
  getQuotes(params: OrderRouteParams): Promise<RouteQuote[]>;
  compareRoutes(params: OrderRouteParams): Promise<RoutingResult>;
  updateConfig(config: Partial<SmartRouterConfig>): void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<SmartRouterConfig> = {
  mode: 'balanced',
  enabledPlatforms: ['polymarket', 'kalshi'],
  maxSlippage: 1,
  preferMaker: true,
  allowSplitting: false,
  maxSplitPlatforms: 3,
  minSplitImprovement: 0.5,
  useFeatureScoring: true,
  liquidityWeight: 0.2,
};

// Platform fee structures (in basis points)
// NOTE: These are defaults/estimates. Actual fees vary:
// - Polymarket: 0 fees on most markets; 15-min crypto markets have dynamic fees (up to ~315bps at 50/50 odds)
// - Kalshi: Formula-based fees 0.07*C*P*(1-P), averaging ~120bps, capped at ~200bps
const PLATFORM_FEES: Partial<Record<Platform, { takerBps: number | null; makerBps: number }>> = {
  // Polymarket taker fees are market/price dependent. null is deliberate: never default to zero.
  polymarket: { takerBps: null, makerBps: 0 },
  kalshi: { takerBps: 120, makerBps: 17 }, // Average ~1.2% taker, ~0.17% maker (formula-based, varies by price)
  manifold: { takerBps: 0, makerBps: 0 }, // No fees
  metaculus: { takerBps: 0, makerBps: 0 }, // No fees
  predictit: { takerBps: 500, makerBps: 500 }, // 5% on profits (10% total on winning trades)
  drift: { takerBps: 100, makerBps: -25 }, // Estimated
  betfair: { takerBps: 200, makerBps: 0 }, // Varies by market (2-5% commission on net winnings)
  smarkets: { takerBps: 200, makerBps: 0 }, // 2% commission
};

// Average execution times (ms)
const EXECUTION_TIMES: Partial<Record<Platform, number>> = {
  polymarket: 500,
  kalshi: 800,
  manifold: 300,
  metaculus: 300,
  predictit: 2000,
  drift: 400,
  betfair: 600,
  smarkets: 700,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createSmartRouter(
  feeds: FeedManager,
  config: SmartRouterConfig = {}
): SmartRouter {
  const emitter = new EventEmitter() as SmartRouter;
  let cfg = { ...DEFAULT_CONFIG, ...config };

  // ==========================================================================
  // PRICE FETCHING
  // ==========================================================================

  async function fetchOrderbook(platform: Platform, marketId: string): Promise<Orderbook | null> {
    try {
      return await feeds.getOrderbook(platform, marketId);
    } catch (error) {
      logger.debug({ platform, marketId, error }, 'Failed to fetch orderbook');
      return null;
    }
  }

  // ==========================================================================
  // FEE CALCULATION
  // ==========================================================================

  function calculateStaticFees(platform: Platform, notional: number, isMaker: boolean): number {
    const fees = PLATFORM_FEES[platform] || { takerBps: 100, makerBps: 0 };
    const bps = isMaker ? fees.makerBps : fees.takerBps;
    if (bps === null) throw new Error(`${FEE_UNKNOWN}: ${platform} requires market fee metadata`);
    return (notional * bps) / 10000;
  }

  // ==========================================================================
  // QUOTE GENERATION
  // ==========================================================================

  async function getQuoteForPlatform(
    platform: Platform,
    params: OrderRouteParams
  ): Promise<RouteQuote | null> {
    const marketId = params.alternativeIds?.[platform] || params.marketId;

    // Consume the executable side of the full book. No midpoint or last-trade fallback.
    const orderbook = await fetchOrderbook(platform, marketId);
    if (!orderbook) return null;
    const fill = simulateBookFill({
      book: orderbook,
      side: params.side,
      shares: params.size,
      limitPrice: params.limitPrice,
    });
    const price = fill.vwap ?? params.limitPrice ?? 0;

    // A non-crossing limit can be a maker order, but its future fill/capacity is unknown.
    const bestOpposite = params.side === 'buy' ? orderbook.asks[0]?.[0] : orderbook.bids[0]?.[0];
    const isMaker = cfg.preferMaker && params.limitPrice !== undefined && bestOpposite !== undefined &&
      (params.side === 'buy' ? params.limitPrice < bestOpposite : params.limitPrice > bestOpposite);

    let feeStatus: FeeStatus = 'KNOWN';
    let fees: number | null;
    let blockReason: string | undefined;
    if (platform === 'polymarket') {
      // alternativeIds may be token IDs for books; Gamma fee metadata is keyed
      // by the canonical condition/market ID, so try that first.
      const canonicalMarket = await feeds.getMarket(params.marketId, platform).catch(() => null);
      const market = canonicalMarket ?? (marketId !== params.marketId
        ? await feeds.getMarket(marketId, platform).catch(() => null)
        : null);
      const fee = quotePolymarketFee({
        shares: fill.filledSize,
        price,
        liquidityRole: isMaker ? 'maker' : 'taker',
        feesEnabled: market?.feesEnabled,
        feeSchedule: market?.feeSchedule,
      });
      feeStatus = fee.status;
      fees = fee.fee;
      if (fee.status === FEE_UNKNOWN) blockReason = `${FEE_UNKNOWN}: ${fee.reason}`;
    } else {
      fees = calculateStaticFees(platform, fill.spentOrReceived, isMaker);
    }

    if (isMaker) blockReason = 'maker fill and capacity are not executable from the current book';
    if (fill.status === 'none' && !blockReason) blockReason = 'no executable liquidity';
    const executable = !isMaker && fill.filledSize > 0 && feeStatus === 'KNOWN';
    const netPrice = executable && fees !== null && fill.filledSize > 0
      ? params.side === 'buy'
        ? price + fees / fill.filledSize
        : price - fees / fill.filledSize
      : null;

    return {
      platform,
      price,
      requestedSize: params.size,
      availableSize: fill.filledSize,
      estimatedFees: fees,
      netPrice,
      feeStatus,
      fillStatus: fill.status,
      executable,
      blockReason,
      slippage: (fill.slippage ?? 0) * 100,
      executionTimeMs: EXECUTION_TIMES[platform] || 1000,
      isMaker,
    };
  }

  // ==========================================================================
  // ROUTE SELECTION
  // ==========================================================================

  function selectBestRoute(quotes: ExecutableRouteQuote[], side: 'buy' | 'sell', params: OrderRouteParams): ExecutableRouteQuote {
    const sorted = [...quotes].sort((a, b) => {
      switch (cfg.mode) {
        case 'best_price':
          return side === 'buy' ? a.netPrice! - b.netPrice! : b.netPrice! - a.netPrice!;

        case 'best_liquidity':
          return b.availableSize - a.availableSize;

        case 'lowest_fee':
          return a.estimatedFees! - b.estimatedFees!;

        case 'balanced':
        default: {
          // Weighted score: 50% price, 30% liquidity (from orderbook), 20% fees
          let scoreA = (side === 'buy' ? -a.netPrice! : a.netPrice!) * 0.5 +
            a.availableSize / 10000 * 0.3 +
            -a.estimatedFees! / 100 * 0.2;
          let scoreB = (side === 'buy' ? -b.netPrice! : b.netPrice!) * 0.5 +
            b.availableSize / 10000 * 0.3 +
            -b.estimatedFees! / 100 * 0.2;

          // Add feature-based liquidity scoring (if enabled)
          if (cfg.useFeatureScoring) {
            const marketIdA = params.alternativeIds?.[a.platform] || params.marketId;
            const marketIdB = params.alternativeIds?.[b.platform] || params.marketId;

            const featuresA = getMarketFeatures(a.platform, marketIdA);
            const featuresB = getMarketFeatures(b.platform, marketIdB);

            // Boost score for markets with better liquidity scores
            const liquidityScoreA = getLiquidityScore(featuresA) ?? 0.5;
            const liquidityScoreB = getLiquidityScore(featuresB) ?? 0.5;

            scoreA += liquidityScoreA * cfg.liquidityWeight;
            scoreB += liquidityScoreB * cfg.liquidityWeight;

            // Penalize wide spreads
            const spreadA = getSpreadPct(featuresA) ?? 0;
            const spreadB = getSpreadPct(featuresB) ?? 0;

            scoreA -= spreadA * 0.05; // Slight penalty for spread
            scoreB -= spreadB * 0.05;
          }

          return scoreB - scoreA;
        }
      }
    });

    return sorted[0];
  }

  function calculateSplitRoutes(
    quotes: ExecutableRouteQuote[],
    params: OrderRouteParams
  ): ExecutableRouteQuote[] | undefined {
    if (!cfg.allowSplitting || quotes.length < 2) {
      return undefined;
    }

    // Sort by net price
    const sorted = [...quotes].sort((a, b) =>
      params.side === 'buy' ? a.netPrice! - b.netPrice! : b.netPrice! - a.netPrice!
    );

    // Calculate if splitting is beneficial
    const splits: ExecutableRouteQuote[] = [];
    let remainingSize = params.size;

    for (let i = 0; i < Math.min(sorted.length, cfg.maxSplitPlatforms); i++) {
      if (remainingSize <= 0) break;

      const quote = sorted[i];
      const fillSize = Math.min(remainingSize, quote.availableSize);

      if (fillSize > 0) {
        const feeScale = quote.availableSize > 0 ? fillSize / quote.availableSize : 0;
        const estimatedFees = quote.estimatedFees! * feeScale;
        const netPrice = params.side === 'buy'
          ? quote.price + estimatedFees / fillSize
          : quote.price - estimatedFees / fillSize;
        splits.push({
          ...quote,
          availableSize: fillSize,
          estimatedFees,
          netPrice,
        });
        remainingSize -= fillSize;
      }
    }

    // Check if split is better than single route
    if (splits.length <= 1) {
      return undefined;
    }

    const singleCost = sorted[0].netPrice! * params.size;
    const splitCost = splits.reduce((sum, s) => sum + s.netPrice! * s.availableSize, 0);
    const improvement = (singleCost - splitCost) / singleCost * 100;

    if (improvement < cfg.minSplitImprovement) {
      return undefined;
    }

    return splits;
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  Object.assign(emitter, {
    async findBestRoute(params: OrderRouteParams): Promise<RoutingResult> {
      const quotes = await emitter.getQuotes(params);
      const executableQuotes = quotes.filter(
        (quote): quote is ExecutableRouteQuote =>
          quote.executable && quote.netPrice !== null && quote.estimatedFees !== null && quote.feeStatus === 'KNOWN'
      );

      if (executableQuotes.length === 0) {
        const feeUnknown = quotes.some((quote) => quote.feeStatus === FEE_UNKNOWN);
        const error = new Error(feeUnknown ? `${FEE_UNKNOWN}: no fee-safe routes available` : 'No executable routes available');
        emitter.emit('routingFailed', error, params);
        throw error;
      }

      const bestRoute = selectBestRoute(executableQuotes, params.side, params);
      const splitRoutes = calculateSplitRoutes(executableQuotes, params);

      // Calculate savings compared to worst route
      const worstPrice = params.side === 'buy'
        ? Math.max(...executableQuotes.map((q) => q.netPrice!))
        : Math.min(...executableQuotes.map((q) => q.netPrice!));
      const totalSavings = Math.abs(bestRoute.netPrice! - worstPrice) * params.size;

      const result: RoutingResult = {
        bestRoute,
        allRoutes: executableQuotes,
        blockedRoutes: quotes.filter((quote) => !quote.executable),
        splitRoutes,
        totalSavings,
        recommendation: splitRoutes
          ? `Split across ${splitRoutes.length} platforms for ${cfg.minSplitImprovement}%+ improvement`
          : `Route to ${bestRoute.platform} (${bestRoute.isMaker ? 'maker' : 'taker'})`,
      };

      logger.info(
        {
          marketId: params.marketId,
          side: params.side,
          size: params.size,
          bestPlatform: bestRoute.platform,
          netPrice: bestRoute.netPrice,
          savings: totalSavings,
        },
        'Route found'
      );

      emitter.emit('routeFound', result);
      return result;
    },

    async getQuotes(params: OrderRouteParams): Promise<RouteQuote[]> {
      const quotes: RouteQuote[] = [];

      const quotePromises = cfg.enabledPlatforms.map(async (platform) => {
        try {
          const quote = await getQuoteForPlatform(platform, params);
          if (quote && quote.slippage <= cfg.maxSlippage) {
            quotes.push(quote);
            emitter.emit('priceUpdate', platform, quote.price);
          }
        } catch (error) {
          logger.debug({ platform, error }, 'Quote failed');
        }
      });

      await Promise.all(quotePromises);
      return quotes;
    },

    async compareRoutes(params: OrderRouteParams): Promise<RoutingResult> {
      return emitter.findBestRoute(params);
    },

    updateConfig(newConfig: Partial<SmartRouterConfig>): void {
      cfg = { ...cfg, ...newConfig };
      logger.info({ config: cfg }, 'Router config updated');
    },
  } as Partial<SmartRouter>);

  return emitter;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Quick comparison of prices across platforms
 */
export async function quickPriceCompare(
  feeds: FeedManager,
  marketId: string,
  platforms: Platform[] = ['polymarket', 'kalshi']
): Promise<Record<Platform, number | null>> {
  const prices: Record<Platform, number | null> = {} as Record<Platform, number | null>;

  await Promise.all(
    platforms.map(async (platform) => {
      try {
        prices[platform] = await feeds.getPrice(platform, marketId);
      } catch {
        prices[platform] = null;
      }
    })
  );

  return prices;
}

// =============================================================================
// EXPORTS
// =============================================================================

export { PLATFORM_FEES, EXECUTION_TIMES };
