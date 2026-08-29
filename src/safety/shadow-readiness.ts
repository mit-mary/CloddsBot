import {
  FEE_UNKNOWN,
  quotePolymarketFee,
  simulateSequentialMultiLeg,
} from '../execution/prediction-market-economics';
import {
  KNOWN_LIVE_CAPABLE_SKILLS,
  KNOWN_LIVE_CAPABLE_AGENT_TOOLS,
  PAPER_APPROVED_AGENT_TOOLS,
  PAPER_APPROVED_SKILLS,
  PAPER_DISABLED_STRATEGIES,
  TRUSTED_TICK_REPLAY_EXECUTION_MODE,
  assertPaperOnlyEnvironment,
} from './paper-only';
import {
  REJECTED_TRUSTED_SHADOW_PNL_SOURCES,
  TRUSTED_SHADOW_PNL_SOURCES,
  isTrustedShadowPnlRecord,
} from './trusted-shadow-ledger';

export interface ShadowReadinessResult {
  ready: boolean;
  blockers: string[];
  evidence: {
    trustedEntrypoints: readonly string[];
    disabledUnmigratedStrategies: readonly string[];
    strictNoBookMode: string;
    unknownFeeStatus: string;
    temporalSecondLegVwap: number | null;
    temporalSecondLegDelayMs: number | null;
    exposedLiveCapableSkills: string[];
    exposedLiveCapableAgentTools: string[];
    trustedPnlSources: readonly string[];
    rejectedPnlSourcesAccepted: string[];
  };
}

/**
 * Explicit latch for the approved long shadow. This performs deterministic,
 * local checks only; it does not start feeds, wallets, adapters, or a shadow run.
 */
export function checkShadowReadiness(): ShadowReadinessResult {
  const blockers: string[] = [];
  const trustedEntrypoints = ['opportunity', 'tick-replay'] as const;
  const disabledUnmigratedStrategies = PAPER_DISABLED_STRATEGIES.filter(
    (name) => name === 'crypto-hft' || name === 'hft-divergence',
  );

  if (TRUSTED_TICK_REPLAY_EXECUTION_MODE !== 'trusted-orderbook') {
    blockers.push('strict no-book execution is not active');
  }
  if (disabledUnmigratedStrategies.length !== 2) {
    blockers.push('unmigrated HFT strategies are not disabled');
  }

  const fee = quotePolymarketFee({ shares: 1, price: 0.5 });
  if (fee.status !== FEE_UNKNOWN || fee.fee !== null) {
    blockers.push('unknown fees are not blocked/countable');
  }

  const temporal = simulateSequentialMultiLeg({
    detectedAtMs: 1_000,
    legs: [
      {
        id: 'yes', side: 'buy', shares: 10, latencyMs: 0,
        book: { timestamp: 1_000, bids: [[0.41, 10]], asks: [[0.42, 10]] },
        feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
      },
      {
        id: 'no', side: 'buy', shares: 10, latencyMs: 500,
        book: { timestamp: 1_500, bids: [[0.59, 10]], asks: [[0.60, 10]] },
        feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
      },
    ],
  });
  const secondVwap = temporal.executions[1]?.fill.vwap ?? null;
  if (!temporal.complete || secondVwap !== 0.60 || temporal.secondLegDelayMs !== 500) {
    blockers.push('temporal two-book fixture failed');
  }

  const exposedLiveCapableSkills = KNOWN_LIVE_CAPABLE_SKILLS.filter((name) =>
    (PAPER_APPROVED_SKILLS as readonly string[]).includes(name),
  );
  if (exposedLiveCapableSkills.length > 0) {
    blockers.push('paper skill allowlist exposes live-capable skills');
  }
  const exposedLiveCapableAgentTools = KNOWN_LIVE_CAPABLE_AGENT_TOOLS.filter((name) =>
    (PAPER_APPROVED_AGENT_TOOLS as readonly string[]).includes(name),
  );
  if (exposedLiveCapableAgentTools.length > 0) {
    blockers.push('paper agent-tool allowlist exposes live-capable tools');
  }
  const rejectedPnlSourcesAccepted = REJECTED_TRUSTED_SHADOW_PNL_SOURCES.filter((source) =>
    isTrustedShadowPnlRecord({ namespace: 'trusted-shadow', source, pnl: 0 }),
  );
  if (rejectedPnlSourcesAccepted.length > 0) {
    blockers.push('trusted shadow ledger accepts an untrusted PnL source');
  }

  return {
    ready: blockers.length === 0,
    blockers,
    evidence: {
      trustedEntrypoints,
      disabledUnmigratedStrategies,
      strictNoBookMode: TRUSTED_TICK_REPLAY_EXECUTION_MODE,
      unknownFeeStatus: fee.status,
      temporalSecondLegVwap: secondVwap,
      temporalSecondLegDelayMs: temporal.secondLegDelayMs,
      exposedLiveCapableSkills,
      exposedLiveCapableAgentTools,
      trustedPnlSources: TRUSTED_SHADOW_PNL_SOURCES,
      rejectedPnlSourcesAccepted,
    },
  };
}

export function assertShadowReady(): ShadowReadinessResult {
  assertPaperOnlyEnvironment();
  const result = checkShadowReadiness();
  if (!result.ready) {
    throw new Error(`Shadow readiness blocked: ${result.blockers.join('; ')}`);
  }
  return result;
}
