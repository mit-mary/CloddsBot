/**
 * Deterministic, side-aware prediction-market execution economics.
 *
 * This module is intentionally pure: callers provide recorded/fetched books and
 * market fee metadata. It never discovers markets or submits orders.
 */

export const FEE_UNKNOWN = 'FEE_UNKNOWN' as const;
export const POLYMARKET_FEE_FORMULA =
  'shares * rate * (price * (1 - price)) ** exponent';

export type FeeStatus = 'KNOWN' | typeof FEE_UNKNOWN;
export type LiquidityRole = 'maker' | 'taker';

export interface PolymarketFeeSchedule {
  rate: number;
  exponent?: number;
  takerOnly?: boolean;
  rebateRate?: number;
}

export interface PolymarketFeeContext {
  feesEnabled?: boolean;
  feeSchedule?: PolymarketFeeSchedule | null;
}

export interface FeeQuote {
  status: FeeStatus;
  fee: number | null;
  rate: number | null;
  formula: string;
  reason?: string;
}

export interface ExecutableBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  timestamp?: number;
}

export interface DelayedSnapshotSelection {
  targetTimestampMs: number;
  book: ExecutableBook | null;
  source: 'recorded_snapshot' | 'missing_snapshot';
}

export interface ConsumedBookLevel {
  bookPrice: number;
  executionPrice: number;
  size: number;
  notional: number;
}

export interface BookFill {
  side: 'buy' | 'sell';
  requestedSize: number;
  filledSize: number;
  unfilledSize: number;
  availableCapacity: number;
  spentOrReceived: number;
  bestPrice: number | null;
  vwap: number | null;
  slippage: number | null;
  complete: boolean;
  status: 'full' | 'partial' | 'none';
  levelsConsumed: ConsumedBookLevel[];
  snapshotTimestamp?: number;
  safetySlippageBps: number;
}

export interface BookFillRequest {
  book: ExecutableBook;
  side: 'buy' | 'sell';
  shares: number;
  limitPrice?: number;
  safetySlippageBps?: number;
}

export interface SequentialLegRequest {
  id: string;
  side: 'buy' | 'sell';
  shares: number;
  book: ExecutableBook;
  latencyMs: number;
  limitPrice?: number;
  feeContext: PolymarketFeeContext;
  liquidityRole?: LiquidityRole;
}

export interface SequentialLegExecution {
  request: SequentialLegRequest;
  fill: BookFill;
  fee: FeeQuote;
  executedAtMs: number;
}

export interface SequentialMultiLegResult {
  executions: SequentialLegExecution[];
  matchedQuantity: number;
  legImbalance: number;
  unhedgedSize: number;
  secondLegDelayMs: number | null;
  combinedCost: number;
  fees: number | null;
  payout: number;
  pnl: number | null;
  complete: boolean;
  failure?: string;
}

const EPSILON = 1e-12;

function roundHalfUp(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // Add epsilon before scaling so binary representations just below an exact
  // half boundary follow Decimal ROUND_HALF_UP semantics.
  return Math.floor((value + Number.EPSILON) * factor + 0.5) / factor;
}

function validLevel(level: [number, number]): boolean {
  return Number.isFinite(level[0]) && Number.isFinite(level[1]) &&
    level[0] >= 0 && level[0] <= 1 && level[1] > 0;
}

function adversePrice(price: number, side: 'buy' | 'sell', bps: number): number {
  const bump = bps / 10_000;
  const adjusted = price * (side === 'buy' ? 1 + bump : 1 - bump);
  return Math.min(1, Math.max(0, adjusted));
}

export function quotePolymarketFee(params: {
  shares: number;
  price: number;
  liquidityRole?: LiquidityRole;
  feesEnabled?: boolean;
  feeSchedule?: PolymarketFeeSchedule | null;
}): FeeQuote {
  const { shares, price, feesEnabled, feeSchedule } = params;
  const liquidityRole = params.liquidityRole ?? 'taker';

  if (!Number.isFinite(shares) || shares < 0 || !Number.isFinite(price) || price < 0 || price > 1) {
    throw new Error('invalid shares or price');
  }
  if (liquidityRole === 'maker') {
    return { status: 'KNOWN', fee: 0, rate: 0, formula: 'maker fee = 0' };
  }
  if (liquidityRole !== 'taker') {
    throw new Error('liquidityRole must be maker or taker');
  }
  if (feesEnabled === false) {
    return { status: 'KNOWN', fee: 0, rate: 0, formula: 'feesEnabled=false' };
  }
  if (!feeSchedule || feeSchedule.rate === undefined || feeSchedule.rate === null) {
    return {
      status: FEE_UNKNOWN,
      fee: null,
      rate: null,
      formula: POLYMARKET_FEE_FORMULA,
      reason: 'market feeSchedule unavailable',
    };
  }

  const rate = Number(feeSchedule.rate);
  const exponent = Number(feeSchedule.exponent ?? 1);
  if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(exponent) || exponent < 0) {
    return {
      status: FEE_UNKNOWN,
      fee: null,
      rate: null,
      formula: POLYMARKET_FEE_FORMULA,
      reason: 'invalid market feeSchedule',
    };
  }

  const raw = shares * rate * ((price * (1 - price)) ** exponent);
  return {
    status: 'KNOWN',
    fee: roundHalfUp(raw, 5),
    rate,
    formula: POLYMARKET_FEE_FORMULA,
  };
}

/** Walk the executable side of a book and return full/partial/no-fill reality. */
export function simulateBookFill(request: BookFillRequest): BookFill {
  const safetySlippageBps = request.safetySlippageBps ?? 0;
  if (!Number.isFinite(request.shares) || request.shares <= 0) {
    throw new Error('shares must be positive');
  }
  if (!Number.isFinite(safetySlippageBps) || safetySlippageBps < 0) {
    throw new Error('safetySlippageBps must be non-negative');
  }
  if (request.limitPrice !== undefined &&
      (!Number.isFinite(request.limitPrice) || request.limitPrice < 0 || request.limitPrice > 1)) {
    throw new Error('limitPrice must be between 0 and 1');
  }

  const rawLevels = request.side === 'buy' ? request.book.asks : request.book.bids;
  const levels = rawLevels.filter(validLevel).sort((a, b) =>
    request.side === 'buy' ? a[0] - b[0] : b[0] - a[0]
  );
  const isExecutable = (price: number) => request.limitPrice === undefined ||
    (request.side === 'buy' ? price <= request.limitPrice : price >= request.limitPrice);
  const executableLevels = levels.filter(([price]) => isExecutable(price));
  const availableCapacity = executableLevels.reduce((sum, [, size]) => sum + size, 0);
  const bestPrice = executableLevels[0]?.[0] ?? null;

  let remaining = request.shares;
  let filledSize = 0;
  let spentOrReceived = 0;
  const levelsConsumed: ConsumedBookLevel[] = [];

  for (const [bookPrice, levelSize] of executableLevels) {
    const size = Math.min(remaining, levelSize);
    if (size <= 0) continue;
    const executionPrice = adversePrice(bookPrice, request.side, safetySlippageBps);
    const notional = size * executionPrice;
    levelsConsumed.push({ bookPrice, executionPrice, size, notional });
    filledSize += size;
    spentOrReceived += notional;
    remaining -= size;
    if (remaining <= EPSILON) break;
  }

  const vwap = filledSize > EPSILON ? spentOrReceived / filledSize : null;
  const slippage = vwap !== null && bestPrice !== null && bestPrice > 0
    ? request.side === 'buy'
      ? (vwap - bestPrice) / bestPrice
      : (bestPrice - vwap) / bestPrice
    : null;
  const complete = remaining <= EPSILON;
  const status = filledSize <= EPSILON ? 'none' : complete ? 'full' : 'partial';

  return {
    side: request.side,
    requestedSize: request.shares,
    filledSize,
    unfilledSize: Math.max(0, remaining),
    availableCapacity,
    spentOrReceived,
    bestPrice,
    vwap,
    slippage,
    complete,
    status,
    levelsConsumed,
    snapshotTimestamp: request.book.timestamp,
    safetySlippageBps,
  };
}

/** Select the first recorded book at/after the latency target, failing closed. */
export function selectDelayedBookSnapshot(params: {
  snapshots: ExecutableBook[];
  detectedAtMs: number;
  latencyMs: number;
  maxGapMs?: number;
}): DelayedSnapshotSelection {
  const targetTimestampMs = params.detectedAtMs + params.latencyMs;
  const candidates = params.snapshots
    .filter((snapshot) => Number.isFinite(snapshot.timestamp))
    .sort((a, b) => a.timestamp! - b.timestamp!);
  const found = candidates.find((snapshot) => snapshot.timestamp! >= targetTimestampMs);
  if (!found || (params.maxGapMs !== undefined && found.timestamp! - targetTimestampMs > params.maxGapMs)) {
    return { targetTimestampMs, book: null, source: 'missing_snapshot' };
  }
  return { targetTimestampMs, book: found, source: 'recorded_snapshot' };
}

/** Sequential, non-atomic multi-leg simulation aligned with the poly_lab oracle. */
export function simulateSequentialMultiLeg(params: {
  detectedAtMs: number;
  legs: SequentialLegRequest[];
  safetySlippageBps?: number;
  settlementPerMatchedSet?: number;
}): SequentialMultiLegResult {
  const executions: SequentialLegExecution[] = [];
  let cursorMs = params.detectedAtMs;
  let failure: string | undefined;

  for (const request of params.legs) {
    cursorMs += request.latencyMs;
    const fill = simulateBookFill({
      book: request.book,
      side: request.side,
      shares: request.shares,
      limitPrice: request.limitPrice,
      safetySlippageBps: params.safetySlippageBps,
    });
    const fee = quotePolymarketFee({
      shares: fill.filledSize,
      price: fill.vwap ?? 0,
      liquidityRole: request.liquidityRole ?? 'taker',
      ...request.feeContext,
    });
    executions.push({ request, fill, fee, executedAtMs: cursorMs });
    if (!fill.complete) {
      failure = `partial fill on ${request.id}`;
      break;
    }
  }

  const fillSizes = executions.map((execution) => execution.fill.filledSize);
  const allLegsReached = executions.length === params.legs.length;
  const matchedQuantity = allLegsReached && fillSizes.length > 0 ? Math.min(...fillSizes) : 0;
  const largestFill = fillSizes.length > 0 ? Math.max(...fillSizes) : 0;
  const smallestFill = fillSizes.length > 0 ? Math.min(...fillSizes) : 0;
  const legImbalance = largestFill - smallestFill;
  const unhedgedSize = largestFill - matchedQuantity;
  const buys = executions
    .filter((execution) => execution.request.side === 'buy')
    .reduce((sum, execution) => sum + execution.fill.spentOrReceived, 0);
  const sells = executions
    .filter((execution) => execution.request.side === 'sell')
    .reduce((sum, execution) => sum + execution.fill.spentOrReceived, 0);
  const combinedCost = buys - sells;
  const feeUnknown = executions.some((execution) => execution.fee.status === FEE_UNKNOWN);
  const fees = feeUnknown
    ? null
    : executions.reduce((sum, execution) => sum + (execution.fee.fee ?? 0), 0);
  const payout = matchedQuantity * (params.settlementPerMatchedSet ?? 1);
  const pnl = fees === null ? null : payout - combinedCost - fees;
  const complete = !failure && allLegsReached && executions.every((execution) => execution.fill.complete);
  const secondLegDelayMs = executions.length >= 2
    ? executions[1].executedAtMs - executions[0].executedAtMs
    : null;

  return {
    executions,
    matchedQuantity,
    legImbalance,
    unhedgedSize,
    secondLegDelayMs,
    combinedCost,
    fees,
    payout,
    pnl,
    complete,
    failure,
  };
}
