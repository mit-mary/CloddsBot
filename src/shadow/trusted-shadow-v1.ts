import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  FEE_UNKNOWN,
  quotePolymarketFee,
  simulateBookFill,
  simulateSequentialMultiLeg,
  type ExecutableBook,
  type PolymarketFeeContext,
} from '../execution/prediction-market-economics';
import { assertPaperOnlyEnvironment } from '../safety/paper-only';
import { assertShadowReady } from '../safety/shadow-readiness';
import { assertTrustedShadowPnlRecord } from '../safety/trusted-shadow-ledger';

export const SHADOW_V1_SIZES_USD = [10, 25, 50, 100, 250, 500, 1000] as const;
export const SHADOW_V1_LATENCIES_MS = [0, 100, 250, 500, 1000, 2000, 3000, 5000] as const;
export const SHADOW_V1_SOURCE = 'trusted-orderbook-tick-execution' as const;
export const SHADOW_V1_OPPORTUNITY_SOURCE = 'opportunity-executable-economics' as const;

const GAMMA_MARKETS = 'https://gamma-api.polymarket.com/markets';
const CLOB_BOOK = 'https://clob.polymarket.com/book';

interface GammaMarket {
  id?: string | number;
  conditionId?: string;
  condition_id?: string;
  question?: string;
  slug?: string;
  clobTokenIds?: string | string[];
  token_ids?: string | string[];
  outcomes?: string | string[];
  active?: boolean;
  closed?: boolean;
  feesEnabled?: boolean;
  fees_enabled?: boolean;
  feeSchedule?: PolymarketFeeContext['feeSchedule'] | string;
  fee_schedule?: PolymarketFeeContext['feeSchedule'] | string;
  [key: string]: unknown;
}

interface RawBook {
  market?: string;
  asset_id?: string;
  timestamp?: string | number;
  hash?: string;
  bids?: Array<{ price: string | number; size: string | number }>;
  asks?: Array<{ price: string | number; size: string | number }>;
  [key: string]: unknown;
}

export interface TrustedShadowConfig {
  runDir: string;
  reportsDir: string;
  commitSha: string;
  stage: 'A' | 'B' | 'C';
  durationSeconds: number;
  intervalMs: number;
  marketLimit: number;
  safetySlippageBps: number;
  staleAfterMs: number;
  maxPairGapMs: number;
  sizesUsd?: readonly number[];
  latenciesMs?: readonly number[];
  resume?: boolean;
  fetchTimeoutMs?: number;
}

export interface ShadowStats {
  cycles: number;
  marketFetchSuccess: number;
  marketFetchFailure: number;
  marketsSeen: number;
  booksAttempted: number;
  completeBooks: number;
  missingBooks: number;
  staleBooks: number;
  pairedBooksAvailable: number;
  pairedBooksRejected: number;
  pairedMarketsAvailable: number;
  feeKnown: number;
  feeDisabled: number;
  feeUnknown: number;
  detectedCandidate: number;
  depthAvailable: number;
  feeKnownCandidate: number;
  positiveExecutableEdge: number;
  secondLegAvailable: number;
  completeFill: number;
  partialSecondLeg: number;
  zeroSecondLegLiquidity: number;
  trustedPnlRecords: number;
  deniedPnlRecords: number;
  errors: number;
  sizeStress: Record<string, StressStats>;
  latencyStress: Record<string, StressStats>;
}

export interface StressStats {
  evaluated: number;
  positiveExecutableEdge: number;
  secondLegAvailable: number;
  completeFill: number;
  partialSecondLeg: number;
  zeroSecondLegLiquidity: number;
  trustedPnlRecords: number;
  trustedPnlSum: number;
}

interface ProcessStart {
  time: string;
  pid: number;
  stage: string;
  config: Omit<TrustedShadowConfig, 'runDir' | 'reportsDir' | 'resume'>;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  commitSha: string;
  createdAt: string;
  processStartTime: string;
  stage: 'A' | 'B' | 'C';
  status: 'running' | 'completed' | 'paused' | 'blocked';
  guards: Record<string, string>;
  trustedPnlSources: string[];
  deniedCapabilities: string[];
  config: Omit<TrustedShadowConfig, 'runDir' | 'reportsDir' | 'resume'>;
  lastSequence: number;
  lastCompletedCycle: number;
  stats: ShadowStats;
  stopReasons: string[];
  processStarts: ProcessStart[];
  recoveredIncompleteEventRanges: Array<{ fromSequence: number; toSequence: number; recoveredAt: string }>;
}

interface BookObservation {
  tokenId: string;
  sourceTimestampMs: number | null;
  receiveStartedAtMs: number;
  receiveCompletedAtMs: number;
  rawRef: string;
  raw: RawBook;
  normalized: ExecutableBook;
  complete: boolean;
  stale: boolean;
}

export interface PairEconomics {
  capitalUsd: number;
  requestedShares: number;
  yesFill: ReturnType<typeof simulateBookFill>;
  noFill: ReturnType<typeof simulateBookFill>;
  feeStatus: 'KNOWN' | typeof FEE_UNKNOWN;
  fees: number | null;
  theoreticalEdge: number;
  depthImpact: number;
  safetySlippage: number;
  executablePnl: number | null;
  positiveExecutableEdge: boolean;
  complete: boolean;
}

function emptyStats(): ShadowStats {
  return {
    cycles: 0, marketFetchSuccess: 0, marketFetchFailure: 0, marketsSeen: 0,
    booksAttempted: 0, completeBooks: 0, missingBooks: 0, staleBooks: 0,
    pairedBooksAvailable: 0, pairedBooksRejected: 0, pairedMarketsAvailable: 0,
    feeKnown: 0, feeDisabled: 0, feeUnknown: 0,
    detectedCandidate: 0, depthAvailable: 0, feeKnownCandidate: 0,
    positiveExecutableEdge: 0, secondLegAvailable: 0, completeFill: 0,
    partialSecondLeg: 0, zeroSecondLegLiquidity: 0,
    trustedPnlRecords: 0, deniedPnlRecords: 0, errors: 0,
    sizeStress: {}, latencyStress: {},
  };
}

function emptyStressStats(): StressStats {
  return {
    evaluated: 0, positiveExecutableEdge: 0, secondLegAvailable: 0,
    completeFill: 0, partialSecondLeg: 0, zeroSecondLegLiquidity: 0,
    trustedPnlRecords: 0, trustedPnlSum: 0,
  };
}

function stressBucket(target: Record<string, StressStats>, key: number): StressStats {
  const label = String(key);
  target[label] ??= emptyStressStats();
  return target[label];
}

function manifestConfig(config: TrustedShadowConfig): RunManifest['config'] {
  return {
    commitSha: config.commitSha, stage: config.stage, durationSeconds: config.durationSeconds,
    intervalMs: config.intervalMs, marketLimit: config.marketLimit,
    safetySlippageBps: config.safetySlippageBps, staleAfterMs: config.staleAfterMs,
    maxPairGapMs: config.maxPairGapMs, sizesUsd: config.sizesUsd,
    latenciesMs: config.latenciesMs, fetchTimeoutMs: config.fetchTimeoutMs,
  };
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseFeeContext(market: GammaMarket): PolymarketFeeContext {
  const feesEnabled = market.feesEnabled ?? market.fees_enabled;
  const raw = market.feeSchedule ?? market.fee_schedule;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && Number.isFinite(Number(parsed.rate))) {
      return {
        feesEnabled,
        feeSchedule: {
          rate: Number(parsed.rate),
          exponent: parsed.exponent === undefined ? 1 : Number(parsed.exponent),
          takerOnly: parsed.takerOnly,
          rebateRate: parsed.rebateRate === undefined ? undefined : Number(parsed.rebateRate),
        },
      };
    }
  } catch {
    // Invalid metadata remains unknown and must fail closed.
  }
  return { feesEnabled, feeSchedule: null };
}

function normalizeLevels(levels: RawBook['bids'], descending: boolean): Array<[number, number]> {
  return (levels ?? [])
    .map(({ price, size }) => [Number(price), Number(size)] as [number, number])
    .filter(([price, size]) => Number.isFinite(price) && price >= 0 && price <= 1 && Number.isFinite(size) && size > 0)
    .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]);
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error
    ? `${error.cause.name}: ${error.cause.message}${'code' in error.cause ? ` code=${String(error.cause.code)}` : ''}`
    : error.cause === undefined ? '' : String(error.cause);
  return cause ? `${error.name}: ${error.message}; cause=${cause}` : `${error.name}: ${error.message}`;
}

function durableAppend(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

class EventWriter {
  readonly path: string;
  private sequence = 0;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    let expected = 1;
    for (const line of lines) {
      const parsed = JSON.parse(line) as { sequence?: number };
      if (parsed.sequence !== expected) {
        throw new Error(`RESTART_PROVENANCE_CORRUPT: expected sequence ${expected}, got ${parsed.sequence}`);
      }
      expected += 1;
    }
    this.sequence = expected - 1;
  }

  append(event: Record<string, unknown>): number {
    const sequence = ++this.sequence;
    durableAppend(this.path, `${JSON.stringify({ sequence, ...event })}\n`);
    return sequence;
  }

  currentSequence(): number { return this.sequence; }
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<{ raw: T; startedAtMs: number; completedAtMs: number }> {
  const parsed = new URL(url);
  if (!['gamma-api.polymarket.com', 'clob.polymarket.com'].includes(parsed.hostname)) {
    throw new Error(`UNAPPROVED_FEED_HOST: ${parsed.hostname}`);
  }
  const startedAtMs = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'clodds-trusted-shadow-v1-paper-only' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}: ${url}`);
  const raw = await response.json() as T;
  return { raw, startedAtMs, completedAtMs: Date.now() };
}

async function fetchBook(tokenId: string, staleAfterMs: number, timeoutMs: number): Promise<BookObservation> {
  const { raw, startedAtMs, completedAtMs } = await fetchJson<RawBook>(
    `${CLOB_BOOK}?token_id=${encodeURIComponent(tokenId)}`,
    timeoutMs,
  );
  const rawTimestamp = raw.timestamp;
  const sourceTimestampMs = rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === ''
    ? null
    : Number(rawTimestamp);
  const normalized: ExecutableBook = {
    bids: normalizeLevels(raw.bids, true),
    asks: normalizeLevels(raw.asks, false),
    timestamp: Number.isFinite(sourceTimestampMs) ? sourceTimestampMs! : completedAtMs,
  };
  return {
    tokenId,
    sourceTimestampMs: Number.isFinite(sourceTimestampMs) ? sourceTimestampMs : null,
    receiveStartedAtMs: startedAtMs,
    receiveCompletedAtMs: completedAtMs,
    rawRef: hashJson(raw),
    raw,
    normalized,
    complete: normalized.bids.length > 0 && normalized.asks.length > 0,
    stale: sourceTimestampMs !== null && completedAtMs - sourceTimestampMs > staleAfterMs,
  };
}

function bestAsk(book: ExecutableBook): number | null {
  return [...book.asks].sort((a, b) => a[0] - b[0])[0]?.[0] ?? null;
}

function findSharesForCapital(
  yes: ExecutableBook,
  no: ExecutableBook,
  capitalUsd: number,
  safetySlippageBps: number,
): number {
  const top = (bestAsk(yes) ?? 1) + (bestAsk(no) ?? 1);
  let low = 0;
  let high = capitalUsd / Math.max(0.0001, top);
  for (let i = 0; i < 64; i += 1) {
    const shares = (low + high) / 2;
    const yf = simulateBookFill({ book: yes, side: 'buy', shares, safetySlippageBps });
    const nf = simulateBookFill({ book: no, side: 'buy', shares, safetySlippageBps });
    if (yf.complete && nf.complete && yf.spentOrReceived + nf.spentOrReceived <= capitalUsd) low = shares;
    else high = shares;
  }
  return low;
}

export function evaluatePairAtSize(params: {
  yes: ExecutableBook;
  no: ExecutableBook;
  capitalUsd: number;
  feeContext: PolymarketFeeContext;
  safetySlippageBps: number;
}): PairEconomics {
  const shares = findSharesForCapital(
    params.yes, params.no, params.capitalUsd, params.safetySlippageBps,
  );
  if (shares <= 1e-12) {
    const impossible = simulateBookFill({ book: params.yes, side: 'buy', shares: 1e-12 });
    return {
      capitalUsd: params.capitalUsd, requestedShares: 0,
      yesFill: impossible, noFill: { ...impossible }, feeStatus: 'KNOWN', fees: 0,
      theoreticalEdge: 0, depthImpact: 0, safetySlippage: 0,
      executablePnl: 0, positiveExecutableEdge: false, complete: false,
    };
  }
  const yesBase = simulateBookFill({ book: params.yes, side: 'buy', shares });
  const noBase = simulateBookFill({ book: params.no, side: 'buy', shares });
  const yesFill = simulateBookFill({
    book: params.yes, side: 'buy', shares, safetySlippageBps: params.safetySlippageBps,
  });
  const noFill = simulateBookFill({
    book: params.no, side: 'buy', shares, safetySlippageBps: params.safetySlippageBps,
  });
  const topCost = shares * ((bestAsk(params.yes) ?? 1) + (bestAsk(params.no) ?? 1));
  const baseCost = yesBase.spentOrReceived + noBase.spentOrReceived;
  const safeCost = yesFill.spentOrReceived + noFill.spentOrReceived;
  const yesFee = quotePolymarketFee({ shares: yesFill.filledSize, price: yesFill.vwap ?? 0, ...params.feeContext });
  const noFee = quotePolymarketFee({ shares: noFill.filledSize, price: noFill.vwap ?? 0, ...params.feeContext });
  const feeUnknown = yesFee.status === FEE_UNKNOWN || noFee.status === FEE_UNKNOWN;
  const fees = feeUnknown ? null : (yesFee.fee ?? 0) + (noFee.fee ?? 0);
  const theoreticalEdge = shares - topCost;
  const executablePnl = fees === null ? null : shares - safeCost - fees;
  const complete = yesFill.complete && noFill.complete;
  return {
    capitalUsd: params.capitalUsd,
    requestedShares: shares,
    yesFill,
    noFill,
    feeStatus: feeUnknown ? FEE_UNKNOWN : 'KNOWN',
    fees,
    theoreticalEdge,
    depthImpact: baseCost - topCost,
    safetySlippage: safeCost - baseCost,
    executablePnl,
    positiveExecutableEdge: complete && executablePnl !== null && executablePnl > 0,
    complete,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function stopReasons(stats: ShadowStats): string[] {
  const reasons: string[] = [];
  if (stats.deniedPnlRecords > 0) reasons.push('DENIED_SOURCE_ENTERED_TRUSTED_LEDGER');
  const feeUnknownRate = rate(stats.feeUnknown, stats.feeKnown + stats.feeDisabled + stats.feeUnknown);
  if (feeUnknownRate !== null && feeUnknownRate > 0.25) reasons.push('FEE_UNKNOWN_RATE_MATERIAL');
  const badBookRate = rate(stats.missingBooks + stats.staleBooks, stats.booksAttempted);
  if (badBookRate !== null && badBookRate > 0.50) reasons.push('MISSING_OR_STALE_BOOKS_DOMINATE');
  const pairRejectRate = rate(stats.pairedBooksRejected, stats.pairedMarketsAvailable + stats.pairedBooksRejected);
  if (pairRejectRate !== null && pairRejectRate > 0.20) reasons.push('BOOK_PAIRING_UNRELIABLE');
  if (stats.marketFetchSuccess === 0) reasons.push('MARKET_FEED_UNAVAILABLE');
  return reasons;
}

function markdownTable(rows: Array<[string, string | number | null]>): string {
  return ['| Metric | Value |', '|---|---:|', ...rows.map(([k, v]) => `| ${k} | ${v ?? 'N/A'} |`)].join('\n');
}

function writeReports(manifest: RunManifest, config: TrustedShadowConfig): void {
  mkdirSync(config.reportsDir, { recursive: true });
  const s = manifest.stats;
  const hours = (Date.now() - Date.parse(manifest.createdAt)) / 3_600_000;
  writeFileSync(join(config.reportsDir, 'SHADOW_RUN_MANIFEST.md'), `# Shadow Run Manifest\n\n` +
    `- Run ID: \`${manifest.runId}\`\n- Commit SHA: \`${manifest.commitSha}\`\n` +
    `- Stage: ${manifest.stage}\n- Status: ${manifest.status}\n- Created: ${manifest.createdAt}\n` +
    `- Latest process start: ${manifest.processStartTime}\n- Event sequence: ${manifest.lastSequence}\n` +
    `- Recovered incomplete event ranges: ${JSON.stringify(manifest.recoveredIncompleteEventRanges)}\n` +
    `- Data directory: \`${resolve(config.runDir)}\`\n- Trusted sources: ${manifest.trustedPnlSources.join(', ')}\n` +
    `- Guards: ${JSON.stringify(manifest.guards)}\n- Stop reasons: ${manifest.stopReasons.join(', ') || 'none'}\n`, 'utf8');
  writeFileSync(join(config.reportsDir, 'SHADOW_DATA_QUALITY.md'), `# Shadow Data Quality\n\n` + markdownTable([
    ['cycles', s.cycles], ['markets seen', s.marketsSeen],
    ['complete book rate', rate(s.completeBooks, s.booksAttempted)],
    ['missing book rate', rate(s.missingBooks, s.booksAttempted)],
    ['stale book rate', rate(s.staleBooks, s.booksAttempted)],
    ['fee known rate', rate(s.feeKnown, s.feeKnown + s.feeDisabled + s.feeUnknown)],
    ['fee disabled rate', rate(s.feeDisabled, s.feeKnown + s.feeDisabled + s.feeUnknown)],
    ['fee unknown rate', rate(s.feeUnknown, s.feeKnown + s.feeDisabled + s.feeUnknown)],
    ['pair rejection rate', rate(s.pairedBooksRejected, s.pairedMarketsAvailable + s.pairedBooksRejected)],
    ['errors', s.errors],
  ]) + `\n\nStop conditions: ${manifest.stopReasons.join(', ') || 'none'}.\n`, 'utf8');
  writeFileSync(join(config.reportsDir, 'SHADOW_EDGE_FUNNEL.md'), `# Shadow Edge Funnel\n\n` + markdownTable([
    ['detected candidate', s.detectedCandidate], ['paired books available', s.pairedBooksAvailable],
    ['depth available', s.depthAvailable], ['fee known', s.feeKnownCandidate],
    ['positive executable edge', s.positiveExecutableEdge], ['second leg available', s.secondLegAvailable],
    ['complete fill', s.completeFill],
  ]) + `\n\nUnit: market × requested-size × configured-latency scenario. Each row is conditional on all preceding rows.\n`, 'utf8');
  const sizeRows = Object.entries(s.sizeStress)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([size, value]) => `| $${size} | ${value.evaluated} | ${value.positiveExecutableEdge} | ${value.completeFill} | ${value.partialSecondLeg} | ${value.zeroSecondLegLiquidity} | ${value.trustedPnlRecords} | ${value.trustedPnlSum} |`)
    .join('\n');
  const latencyRows = Object.entries(s.latencyStress)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([latency, value]) => `| ${latency}ms | ${value.evaluated} | ${value.secondLegAvailable} | ${value.completeFill} | ${value.partialSecondLeg} | ${value.zeroSecondLegLiquidity} | ${value.trustedPnlRecords} | ${value.trustedPnlSum} |`)
    .join('\n');
  writeFileSync(join(config.reportsDir, 'SHADOW_EXECUTION_REALITY.md'), `# Shadow Execution Reality\n\n` + markdownTable([
    ['trusted PnL observations', s.trustedPnlRecords], ['denied PnL observations', s.deniedPnlRecords],
    ['complete fills', s.completeFill], ['partial second legs', s.partialSecondLeg],
    ['zero second-leg liquidity', s.zeroSecondLegLiquidity],
  ]) + `\n\n## Size stress\n\n| Size | Evaluated | Positive edge | Complete | Partial leg 2 | Zero leg 2 | Trusted records | PnL sum |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${sizeRows || '| N/A | 0 | 0 | 0 | 0 | 0 | 0 | 0 |'}\n` +
    `\n## Latency stress\n\n| Latency | Evaluated | Leg 2 available | Complete | Partial leg 2 | Zero leg 2 | Trusted records | PnL sum |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${latencyRows || '| N/A | 0 | 0 | 0 | 0 | 0 | 0 | 0 |'}\n` +
    `\nEach trusted event retains theoretical edge, depth impact, fees, safety slippage, latency decay, leg-risk residual, matched and unhedged quantity. Aggregate sums are never the sole stored record.\n`, 'utf8');
  const enough24h = hours >= 20;
  const reportStatus = manifest.stopReasons.length > 0
    ? 'BLOCKED'
    : enough24h ? 'INTERIM_READY' : 'PENDING';
  writeFileSync(join(config.reportsDir, 'SHADOW_24H_REPORT.md'), `# Shadow 24H Report\n\n` +
    `Status: ${reportStatus}\n\n` +
    `Stop reasons: ${manifest.stopReasons.join(', ') || 'none'}.\n\n` +
    `Observed hours: ${hours.toFixed(3)}. This file does not claim profitability; the sample is ` +
    `${enough24h ? 'eligible for an interim quality review' : 'not yet a 24-hour sample'}.\n`, 'utf8');
  if (hours >= 48) {
    writeFileSync(join(config.reportsDir, 'SHADOW_MULTI_DAY_REPORT.md'), `# Shadow Multi-Day Report\n\n` +
      `Observed hours: ${hours.toFixed(3)}. Evidence coverage must be reviewed before any strategy claim.\n`, 'utf8');
  }
}

export class TrustedShadowV1Runner {
  private readonly config: TrustedShadowConfig;
  private readonly writer: EventWriter;
  private readonly manifestPath: string;
  private manifest: RunManifest;

  constructor(config: TrustedShadowConfig) {
    assertPaperOnlyEnvironment();
    assertShadowReady();
    if (!/^[0-9a-f]{40}$/i.test(config.commitSha)) throw new Error('commitSha must be a full 40-character SHA');
    if (config.durationSeconds <= 0 || config.intervalMs < 0 || config.marketLimit <= 0) {
      throw new Error('invalid shadow runtime bounds');
    }
    this.config = { ...config, runDir: resolve(config.runDir), reportsDir: resolve(config.reportsDir) };
    mkdirSync(this.config.runDir, { recursive: true });
    this.manifestPath = join(this.config.runDir, 'manifest.json');
    this.writer = new EventWriter(join(this.config.runDir, 'events.jsonl'));
    const now = new Date().toISOString();
    if (existsSync(this.manifestPath)) {
      if (!config.resume) throw new Error('run directory exists; pass resume=true');
      this.manifest = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as RunManifest;
      if (this.manifest.commitSha !== config.commitSha) throw new Error('RESTART_COMMIT_SHA_MISMATCH');
      const durableSequence = this.writer.currentSequence();
      if (this.manifest.lastSequence > durableSequence) throw new Error('RESTART_PROVENANCE_SEQUENCE_ROLLBACK');
      if (this.manifest.status === 'blocked' || this.manifest.stopReasons.length > 0) {
        throw new Error('RESTART_BLOCKED_RUN_REQUIRES_REVIEW');
      }
      this.manifest.recoveredIncompleteEventRanges ??= [];
      if (durableSequence > this.manifest.lastSequence) {
        this.manifest.recoveredIncompleteEventRanges.push({
          fromSequence: this.manifest.lastSequence + 1,
          toSequence: durableSequence,
          recoveredAt: now,
        });
        this.manifest.lastSequence = durableSequence;
      }
      this.manifest.stage = config.stage;
      this.manifest.status = 'running';
      this.manifest.processStartTime = now;
      this.manifest.stopReasons = [];
      this.manifest.config = manifestConfig(config);
      this.manifest.stats.sizeStress ??= {};
      this.manifest.stats.latencyStress ??= {};
      this.manifest.stats.pairedMarketsAvailable ??= 0;
      this.manifest.processStarts.push({
        time: now, pid: process.pid, stage: config.stage, config: manifestConfig(config),
      });
    } else {
      this.manifest = {
        schemaVersion: 1,
        runId: randomUUID(),
        commitSha: config.commitSha,
        createdAt: now,
        processStartTime: now,
        stage: config.stage,
        status: 'running',
        guards: {
          NO_PRIVATE_KEY: process.env.NO_PRIVATE_KEY!,
          NO_WALLET: process.env.NO_WALLET!,
          NO_LIVE_TRADING: process.env.NO_LIVE_TRADING!,
        },
        trustedPnlSources: [SHADOW_V1_OPPORTUNITY_SOURCE, SHADOW_V1_SOURCE],
        deniedCapabilities: [
          'crypto-hft', 'hft-divergence', 'market-making', 'copy-trading',
          'opportunity-auto-executor', 'bar-backtest', 'legacy-tick-price-non-realistic',
          'DipArb', 'polybot', 'live-trading', 'wallet',
        ],
        config: manifestConfig(config),
        lastSequence: 0,
        lastCompletedCycle: 0,
        stats: emptyStats(),
        stopReasons: [],
        recoveredIncompleteEventRanges: [],
        processStarts: [{
          time: now, pid: process.pid, stage: config.stage, config: manifestConfig(config),
        }],
      };
    }
    this.persistManifest();
    this.writer.append({
      eventType: 'process_start', runId: this.manifest.runId, commitSha: config.commitSha,
      processStartTime: now, stage: config.stage, pid: process.pid,
      config: manifestConfig(config),
      recoveredIncompleteEventRanges: this.manifest.recoveredIncompleteEventRanges,
    });
    this.syncSequence();
  }

  private syncSequence(): void {
    this.manifest.lastSequence = this.writer.currentSequence();
    this.persistManifest();
  }

  private persistManifest(): void {
    atomicWriteJson(this.manifestPath, this.manifest);
    writeReports(this.manifest, this.config);
  }

  private recordBook(marketId: string, observation: BookObservation): void {
    this.writer.append({
      eventType: 'book', runId: this.manifest.runId, commitSha: this.manifest.commitSha,
      processStartTime: this.manifest.processStartTime, marketId, tokenId: observation.tokenId,
      sourceTimestampMs: observation.sourceTimestampMs,
      localReceiveStartedAtMs: observation.receiveStartedAtMs,
      localReceiveCompletedAtMs: observation.receiveCompletedAtMs,
      rawBookRef: observation.rawRef, rawBook: observation.raw,
      normalizedBook: observation.normalized, complete: observation.complete, stale: observation.stale,
    });
  }

  private recordTrustedPnl(record: Record<string, unknown> & { pnl: number }): void {
    const admitted = assertTrustedShadowPnlRecord({
      namespace: 'trusted-shadow', source: SHADOW_V1_SOURCE, pnl: record.pnl,
    });
    this.writer.append({ ...record, eventType: 'trusted_pnl', ...admitted });
    this.manifest.stats.trustedPnlRecords += 1;
  }

  private async runCycle(): Promise<void> {
    const stats = this.manifest.stats;
    const timeoutMs = this.config.fetchTimeoutMs ?? 15_000;
    let markets: GammaMarket[];
    try {
      const query = new URLSearchParams({
        active: 'true', closed: 'false', limit: String(this.config.marketLimit),
        order: 'volume24hr', ascending: 'false',
      });
      const fetched = await fetchJson<GammaMarket[]>(`${GAMMA_MARKETS}?${query}`, timeoutMs);
      markets = Array.isArray(fetched.raw) ? fetched.raw : [];
      stats.marketFetchSuccess += 1;
      this.writer.append({
        eventType: 'market_batch', runId: this.manifest.runId, commitSha: this.manifest.commitSha,
        processStartTime: this.manifest.processStartTime,
        localReceiveStartedAtMs: fetched.startedAtMs, localReceiveCompletedAtMs: fetched.completedAtMs,
        rawRef: hashJson(fetched.raw), rawMarkets: fetched.raw,
      });
    } catch (error) {
      stats.marketFetchFailure += 1;
      stats.errors += 1;
      this.writer.append({ eventType: 'error', scope: 'market_batch', error: describeError(error) });
      return;
    }

    for (const market of markets) {
      const marketId = String(market.conditionId ?? market.condition_id ?? market.id ?? '');
      const tokenIds = parseArray(market.clobTokenIds ?? market.token_ids);
      const outcomes = parseArray(market.outcomes);
      if (!marketId || tokenIds.length !== 2 || outcomes.length !== 2) continue;
      stats.marketsSeen += 1;
      const feeContext = parseFeeContext(market);
      if (feeContext.feesEnabled === false) stats.feeDisabled += 1;
      else if (feeContext.feeSchedule) stats.feeKnown += 1;
      else stats.feeUnknown += 1;

      let yes: BookObservation;
      let no: BookObservation;
      try {
        stats.booksAttempted += 2;
        [yes, no] = await Promise.all([
          fetchBook(tokenIds[0], this.config.staleAfterMs, timeoutMs),
          fetchBook(tokenIds[1], this.config.staleAfterMs, timeoutMs),
        ]);
        for (const observation of [yes, no]) {
          this.recordBook(marketId, observation);
          if (!observation.complete) stats.missingBooks += 1;
          else stats.completeBooks += 1;
          if (observation.stale) stats.staleBooks += 1;
        }
      } catch (error) {
        stats.missingBooks += 2;
        stats.errors += 1;
        this.writer.append({ eventType: 'error', scope: 'paired_books', marketId, tokenIds, error: describeError(error) });
        continue;
      }

      const sizes = this.config.sizesUsd ?? SHADOW_V1_SIZES_USD;
      const latencies = [...(this.config.latenciesMs ?? SHADOW_V1_LATENCIES_MS)].sort((a, b) => a - b);
      const candidate = yes.complete && no.complete && !yes.stale && !no.stale &&
        (bestAsk(yes.normalized) ?? 1) + (bestAsk(no.normalized) ?? 1) < 1;
      const scenarioCount = sizes.length * latencies.length;
      if (candidate) stats.detectedCandidate += scenarioCount;
      const sourceGap = yes.sourceTimestampMs === null || no.sourceTimestampMs === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(yes.sourceTimestampMs - no.sourceTimestampMs);
      const paired = yes.complete && no.complete && !yes.stale && !no.stale && sourceGap <= this.config.maxPairGapMs;
      if (!paired) {
        stats.pairedBooksRejected += 1;
        this.writer.append({
          eventType: 'pair_rejected', marketId, tokenIds, sourceGapMs: sourceGap,
          yesRawRef: yes.rawRef, noRawRef: no.rawRef,
          reason: !yes.complete || !no.complete ? 'MISSING_BOOK' : yes.stale || no.stale ? 'STALE_BOOK' : 'PAIR_GAP',
        });
        continue;
      }
      stats.pairedMarketsAvailable += 1;
      if (candidate) stats.pairedBooksAvailable += scenarioCount;
      const evaluated: PairEconomics[] = [];
      for (const capitalUsd of sizes) {
        const economics = evaluatePairAtSize({
          yes: yes.normalized, no: no.normalized, capitalUsd,
          feeContext, safetySlippageBps: this.config.safetySlippageBps,
        });
        evaluated.push(economics);
        const sizeStats = stressBucket(stats.sizeStress, capitalUsd);
        sizeStats.evaluated += latencies.length;
        for (const latencyMs of latencies) {
          stressBucket(stats.latencyStress, latencyMs).evaluated += 1;
        }
        if (candidate && economics.complete) stats.depthAvailable += latencies.length;
        if (candidate && economics.complete && economics.feeStatus === 'KNOWN') {
          stats.feeKnownCandidate += latencies.length;
        }
        if (candidate && economics.complete && economics.feeStatus === 'KNOWN' && economics.positiveExecutableEdge) {
          stats.positiveExecutableEdge += latencies.length;
          sizeStats.positiveExecutableEdge += latencies.length;
          for (const latencyMs of latencies) {
            stressBucket(stats.latencyStress, latencyMs).positiveExecutableEdge += 1;
          }
        }
        this.writer.append({
          eventType: 'opportunity_economics', namespace: 'trusted-shadow',
          source: SHADOW_V1_OPPORTUNITY_SOURCE, runId: this.manifest.runId,
          commitSha: this.manifest.commitSha, processStartTime: this.manifest.processStartTime,
          marketId, tokenIds, sourceTimestampsMs: [yes.sourceTimestampMs, no.sourceTimestampMs],
          localReceiveTimestampsMs: [yes.receiveCompletedAtMs, no.receiveCompletedAtMs],
          rawBookRefs: [yes.rawRef, no.rawRef], feeMetadata: feeContext,
          feeStatus: economics.feeStatus, strategy: 'complete-set-executable-economics',
          requestedSizeUsd: capitalUsd, requestedShares: economics.requestedShares,
          actualSimulatedFill: { yes: economics.yesFill, no: economics.noFill },
          vwap: { yes: economics.yesFill.vwap, no: economics.noFill.vwap },
          latencyMs: 0, matchedQuantity: Math.min(economics.yesFill.filledSize, economics.noFill.filledSize),
          unhedgedQuantity: Math.abs(economics.yesFill.filledSize - economics.noFill.filledSize),
          pnlAttribution: {
            theoreticalEdge: economics.theoreticalEdge, depthImpact: economics.depthImpact,
            fees: economics.fees, safetySlippage: economics.safetySlippage,
            latencyDecay: 0, legRiskImpact: 0, trustedShadowPnl: economics.executablePnl,
          },
          funnel: {
            detectedCandidate: candidate, pairedBooksAvailable: true,
            depthAvailable: economics.complete,
            feeKnown: economics.feeStatus === 'KNOWN', positiveExecutableEdge: economics.positiveExecutableEdge,
          },
        });
      }

      const viable = evaluated.filter((value) => value.positiveExecutableEdge);
      if (viable.length === 0) continue;
      const detectedAtMs = Date.now();
      const laterNoBooks = new Map<number, BookObservation>();
      for (const latencyMs of latencies) {
        const waitMs = detectedAtMs + latencyMs - Date.now();
        if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
        try {
          stats.booksAttempted += 1;
          const observed = await fetchBook(tokenIds[1], this.config.staleAfterMs, timeoutMs);
          this.recordBook(marketId, observed);
          laterNoBooks.set(latencyMs, observed);
          if (!observed.complete) stats.missingBooks += 1;
          else stats.completeBooks += 1;
          if (observed.stale) stats.staleBooks += 1;
        } catch (error) {
          stats.missingBooks += 1;
          stats.errors += 1;
          this.writer.append({ eventType: 'error', scope: 'second_leg', marketId, latencyMs, error: describeError(error) });
        }
      }

      for (const economics of viable) {
        for (const latencyMs of latencies) {
          const laterNo = laterNoBooks.get(latencyMs);
          if (!laterNo || laterNo.stale) continue;
          const sizeStats = stressBucket(stats.sizeStress, economics.capitalUsd);
          const latencyStats = stressBucket(stats.latencyStress, latencyMs);
          const secondLegHasDepth = laterNo.normalized.asks.length > 0;
          if (secondLegHasDepth) {
            stats.secondLegAvailable += 1;
            sizeStats.secondLegAvailable += 1;
            latencyStats.secondLegAvailable += 1;
          }
          const result = simulateSequentialMultiLeg({
            detectedAtMs,
            safetySlippageBps: this.config.safetySlippageBps,
            legs: [
              { id: 'yes', side: 'buy', shares: economics.requestedShares, book: yes.normalized, latencyMs: 0, feeContext },
              { id: 'no', side: 'buy', shares: economics.requestedShares, book: laterNo.normalized, latencyMs, feeContext },
            ],
          });
          if (result.complete) {
            stats.completeFill += 1;
            sizeStats.completeFill += 1;
            latencyStats.completeFill += 1;
          }
          const second = result.executions[1]?.fill;
          if (second?.status === 'partial') {
            stats.partialSecondLeg += 1;
            sizeStats.partialSecondLeg += 1;
            latencyStats.partialSecondLeg += 1;
          }
          if (second?.status === 'none') {
            stats.zeroSecondLegLiquidity += 1;
            sizeStats.zeroSecondLegLiquidity += 1;
            latencyStats.zeroSecondLegLiquidity += 1;
          }
          if (result.pnl === null) continue;
          const actualSpent = result.combinedCost;
          const safeInitialCost = economics.yesFill.spentOrReceived + economics.noFill.spentOrReceived;
          const latencyDecay = actualSpent - safeInitialCost;
          const fees = result.fees ?? 0;
          const legRiskImpact = economics.theoreticalEdge - economics.depthImpact - economics.safetySlippage -
            latencyDecay - fees - result.pnl;
          this.recordTrustedPnl({
            runId: this.manifest.runId, commitSha: this.manifest.commitSha,
            processStartTime: this.manifest.processStartTime, marketId, tokenIds,
            sourceTimestampsMs: [yes.sourceTimestampMs, laterNo.sourceTimestampMs],
            localReceiveTimestampsMs: [yes.receiveCompletedAtMs, laterNo.receiveCompletedAtMs],
            rawBookRefs: [yes.rawRef, laterNo.rawRef], feeMetadata: feeContext,
            feeStatus: result.fees === null ? FEE_UNKNOWN : 'KNOWN',
            strategy: 'complete-set-executable-economics', requestedSizeUsd: economics.capitalUsd,
            requestedShares: economics.requestedShares, actualSimulatedFill: result.executions,
            vwap: result.executions.map((execution) => execution.fill.vwap),
            configuredLatencyMs: latencyMs, observedDelayMs: laterNo.receiveCompletedAtMs - detectedAtMs,
            matchedQuantity: result.matchedQuantity, unhedgedQuantity: result.unhedgedSize,
            pnlAttribution: {
              theoreticalEdge: economics.theoreticalEdge, depthImpact: economics.depthImpact,
              fees: result.fees, safetySlippage: economics.safetySlippage,
              latencyDecay, legRiskImpact, trustedShadowPnl: result.pnl,
            },
            complete: result.complete, failure: result.failure, pnl: result.pnl,
          });
          sizeStats.trustedPnlRecords += 1;
          sizeStats.trustedPnlSum += result.pnl;
          latencyStats.trustedPnlRecords += 1;
          latencyStats.trustedPnlSum += result.pnl;
        }
      }
    }
  }

  async run(signal?: AbortSignal): Promise<RunManifest> {
    const deadline = Date.now() + this.config.durationSeconds * 1000;
    try {
      while (Date.now() < deadline && !signal?.aborted) {
        await this.runCycle();
        this.manifest.stats.cycles += 1;
        this.manifest.lastCompletedCycle += 1;
        this.syncSequence();
        const reasons = stopReasons(this.manifest.stats);
        if (reasons.length > 0) {
          this.manifest.stopReasons = reasons;
          this.manifest.status = 'blocked';
          this.writer.append({ eventType: 'stop_condition', reasons, stats: this.manifest.stats });
          this.syncSequence();
          return this.manifest;
        }
        const waitMs = Math.min(this.config.intervalMs, deadline - Date.now());
        if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      }
      this.manifest.status = signal?.aborted ? 'paused' : 'completed';
      this.writer.append({ eventType: 'process_stop', status: this.manifest.status, at: new Date().toISOString() });
      this.syncSequence();
      return this.manifest;
    } catch (error) {
      this.manifest.status = 'blocked';
      this.manifest.stopReasons = [`RUNTIME_ERROR: ${describeError(error)}`];
      this.writer.append({ eventType: 'runtime_error', error: describeError(error) });
      this.syncSequence();
      throw error;
    }
  }
}
