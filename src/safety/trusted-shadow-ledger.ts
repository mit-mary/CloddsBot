/**
 * Sole admission boundary for the future trusted long-shadow PnL ledger.
 * Producers outside this allowlist must use a separate namespace and cannot be
 * aggregated by trusted-shadow analytics.
 */
export const TRUSTED_SHADOW_PNL_SOURCES = [
  'opportunity-executable-economics',
  'trusted-orderbook-tick-execution',
] as const;

export const REJECTED_TRUSTED_SHADOW_PNL_SOURCES = [
  'bar-backtest',
  'legacy-tick-price-non-realistic',
  'crypto-hft',
  'hft-divergence',
  'market-making',
  'copy-trading',
  'opportunity-auto-executor',
] as const;

export type TrustedShadowPnlSource = typeof TRUSTED_SHADOW_PNL_SOURCES[number];
export type RejectedTrustedShadowPnlSource = typeof REJECTED_TRUSTED_SHADOW_PNL_SOURCES[number];
export type PnlSource = TrustedShadowPnlSource | RejectedTrustedShadowPnlSource;
export type PnlNamespace = 'trusted-shadow' | 'legacy-research';

export interface PnlRecord {
  namespace: PnlNamespace;
  source: PnlSource;
  pnl: number;
}

export interface TrustedShadowPnlRecord extends PnlRecord {
  namespace: 'trusted-shadow';
  source: TrustedShadowPnlSource;
}

export function isTrustedShadowPnlRecord(record: PnlRecord): record is TrustedShadowPnlRecord {
  return record.namespace === 'trusted-shadow' &&
    (TRUSTED_SHADOW_PNL_SOURCES as readonly string[]).includes(record.source);
}

export function assertTrustedShadowPnlRecord(record: PnlRecord): TrustedShadowPnlRecord {
  if (!isTrustedShadowPnlRecord(record)) {
    throw new Error(
      `UNTRUSTED_SHADOW_PNL_SOURCE: namespace=${record.namespace} source=${record.source}`,
    );
  }
  return record;
}
