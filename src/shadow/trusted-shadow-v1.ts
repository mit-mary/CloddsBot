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
import {
  runPublicDataPreflight,
  type PublicDataPreflightResult,
} from './network-preflight';

export const SHADOW_V1_SIZES_USD = [10, 25, 50, 100, 250, 500, 1000] as const;
export const SHADOW_V1_LATENCIES_MS = [0, 100, 250, 500, 1000, 2000, 3000, 5000] as const;
export const SHADOW_V1_SOURCE = 'trusted-orderbook-tick-execution' as const;
export const SHADOW_V1_OPPORTUNITY_SOURCE = 'opportunity-executable-economics' as const;

const GAMMA_MARKETS = 'https://gamma-api.polymarket.com/markets';
const CLOB_BOOK = 'https://clob.polymarket.com/book';
const CLOB_BOOKS = 'https://clob.polymarket.com/books';

export type BookTopologyState =
  | 'TWO_SIDED'
  | 'ONE_SIDED_BID_ONLY'
  | 'ONE_SIDED_ASK_ONLY'
  | 'EMPTY_BOOK';

export type BookObservationState = BookTopologyState
  | 'MISSING_BOOK'
  | 'INVALID_RESPONSE'
  | 'REQUEST_FAILED'
  | 'TRANSPORT_STALE';

export type BookHashChange = 'INITIAL' | 'SAME' | 'CHANGED' | 'UNAVAILABLE';

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
  discoveryLimit?: number;
  minimumQualityMarkets?: number;
  minimumQualityPairs?: number;
  minimumQualityCycles?: number;
  transportStaleAfterMs?: number;
  sizesUsd?: readonly number[];
  latenciesMs?: readonly number[];
  resume?: boolean;
  fetchTimeoutMs?: number;
  preflightAttempts?: number;
  preflightBackoffMs?: number;
}

export interface ShadowStats {
  cycles: number;
  marketFetchSuccess: number;
  marketFetchFailure: number;
  marketsSeen: number;
  marketsDiscovered: number;
  metadataValidMarkets: number;
  marketsSampled: number;
  bookPairRequests: number;
  bookPairResponses: number;
  bookResponsesObtained: number;
  schemaValidBooks: number;
  transportFreshBooks: number;
  transportStaleBooks: number;
  twoSidedBooks: number;
  oneSidedBidOnlyBooks: number;
  oneSidedAskOnlyBooks: number;
  emptyBooks: number;
  missingBookResponses: number;
  invalidBookResponses: number;
  requestFailedBooks: number;
  hashInitial: number;
  hashSame: number;
  hashChanged: number;
  reliableBookPairs: number;
  unreliableBookPairs: number;
  pairedStrategyEligible: number;
  pairedStrategyIneligible: number;
  requiredExecutableSidesPairs: number;
  enoughDepthPairs: number;
  feeCoveredPairs: number;
  executableCandidateMarkets: number;
  strategyRejectionReasons: Record<string, number>;
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
  networkPreflight?: PublicDataPreflightResult;
  bookHashState: Record<string, { hash: string; lastChangedAtMs: number }>;
}

export interface BookObservation {
  tokenId: string;
  sourceTimestampMs: number | null;
  requestStartedAtMs: number;
  receivedAtMs: number;
  requestCompletedAtMs: number;
  transportAgeMs: number;
  bookStateAgeMs: number | null;
  rawRef: string | null;
  raw: RawBook | null;
  normalized: ExecutableBook;
  state: BookObservationState;
  topologyState: BookTopologyState | null;
  schemaValid: boolean;
  transportFresh: boolean;
  bookHash: string | null;
  hashChange: BookHashChange;
  timeSinceLastHashChangeMs: number | null;
  pairRequestId: string;
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

export function emptyShadowStats(): ShadowStats {
  return {
    cycles: 0, marketFetchSuccess: 0, marketFetchFailure: 0, marketsSeen: 0,
    marketsDiscovered: 0, metadataValidMarkets: 0, marketsSampled: 0,
    bookPairRequests: 0, bookPairResponses: 0, bookResponsesObtained: 0,
    schemaValidBooks: 0, transportFreshBooks: 0, transportStaleBooks: 0,
    twoSidedBooks: 0, oneSidedBidOnlyBooks: 0, oneSidedAskOnlyBooks: 0,
    emptyBooks: 0, missingBookResponses: 0, invalidBookResponses: 0,
    requestFailedBooks: 0, hashInitial: 0, hashSame: 0, hashChanged: 0,
    reliableBookPairs: 0, unreliableBookPairs: 0,
    pairedStrategyEligible: 0, pairedStrategyIneligible: 0,
    requiredExecutableSidesPairs: 0, enoughDepthPairs: 0, feeCoveredPairs: 0,
    executableCandidateMarkets: 0, strategyRejectionReasons: {},
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
    preflightAttempts: config.preflightAttempts,
    preflightBackoffMs: config.preflightBackoffMs,
    discoveryLimit: config.discoveryLimit,
    minimumQualityMarkets: config.minimumQualityMarkets,
    minimumQualityPairs: config.minimumQualityPairs,
    minimumQualityCycles: config.minimumQualityCycles,
    transportStaleAfterMs: config.transportStaleAfterMs,
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

function validResearchMarket(market: GammaMarket): boolean {
  const marketId = String(market.conditionId ?? market.condition_id ?? market.id ?? '');
  const tokenIds = parseArray(market.clobTokenIds ?? market.token_ids);
  const outcomes = parseArray(market.outcomes);
  return Boolean(marketId) && tokenIds.length === 2 && outcomes.length === 2 &&
    market.closed !== true && market.active !== false &&
    market.enableOrderBook !== false && market.acceptingOrders !== false;
}

function researchMarketRank(market: GammaMarket): number {
  const volume = Number(market.volume24hr ?? 0);
  const liquidity = Number(market.liquidity ?? 0);
  return (Number.isFinite(volume) ? volume : 0) * 1_000_000 +
    (Number.isFinite(liquidity) ? liquidity : 0);
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

interface FetchJsonResult<T> {
  raw: T;
  startedAtMs: number;
  receivedAtMs: number;
  completedAtMs: number;
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  init: { method?: 'GET' | 'POST'; body?: string } = {},
): Promise<FetchJsonResult<T>> {
  const parsed = new URL(url);
  if (!['gamma-api.polymarket.com', 'clob.polymarket.com'].includes(parsed.hostname)) {
    throw new Error(`UNAPPROVED_FEED_HOST: ${parsed.hostname}`);
  }
  const startedAtMs = Date.now();
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': 'clodds-trusted-shadow-v1-paper-only',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const receivedAtMs = Date.now();
  if (!response.ok) throw new Error(`HTTP_${response.status}: ${url}`);
  const raw = await response.json() as T;
  return { raw, startedAtMs, receivedAtMs, completedAtMs: Date.now() };
}

function validRawLevels(value: unknown): value is RawBook['bids'] {
  return Array.isArray(value) && value.every((level) => {
    if (typeof level !== 'object' || level === null) return false;
    const rawLevel = level as { price?: unknown; size?: unknown };
    const price = Number(rawLevel.price);
    const size = Number(rawLevel.size);
    return Number.isFinite(price) && price >= 0 && price <= 1 && Number.isFinite(size) && size > 0;
  });
}

function topologyState(book: ExecutableBook): BookTopologyState {
  if (book.bids.length > 0 && book.asks.length > 0) return 'TWO_SIDED';
  if (book.bids.length > 0) return 'ONE_SIDED_BID_ONLY';
  if (book.asks.length > 0) return 'ONE_SIDED_ASK_ONLY';
  return 'EMPTY_BOOK';
}

export function makeBookObservation(params: {
  tokenId: string;
  raw: unknown;
  requestStartedAtMs: number;
  receivedAtMs: number;
  requestCompletedAtMs: number;
  pairRequestId: string;
  transportStaleAfterMs: number;
  absentState?: 'MISSING_BOOK' | 'REQUEST_FAILED';
}): BookObservation {
  const emptyBook: ExecutableBook = { bids: [], asks: [], timestamp: params.requestCompletedAtMs };
  if (params.absentState) {
    return {
      tokenId: params.tokenId, sourceTimestampMs: null,
      requestStartedAtMs: params.requestStartedAtMs, receivedAtMs: params.receivedAtMs,
      requestCompletedAtMs: params.requestCompletedAtMs,
      transportAgeMs: params.requestCompletedAtMs - params.requestStartedAtMs,
      bookStateAgeMs: null, rawRef: null, raw: null, normalized: emptyBook,
      state: params.absentState, topologyState: null, schemaValid: false,
      transportFresh: false, bookHash: null, hashChange: 'UNAVAILABLE',
      timeSinceLastHashChangeMs: null, pairRequestId: params.pairRequestId,
    };
  }
  if (typeof params.raw !== 'object' || params.raw === null || Array.isArray(params.raw)) {
    return {
      tokenId: params.tokenId, sourceTimestampMs: null,
      requestStartedAtMs: params.requestStartedAtMs, receivedAtMs: params.receivedAtMs,
      requestCompletedAtMs: params.requestCompletedAtMs,
      transportAgeMs: params.requestCompletedAtMs - params.requestStartedAtMs,
      bookStateAgeMs: null, rawRef: hashJson(params.raw), raw: null, normalized: emptyBook,
      state: 'INVALID_RESPONSE', topologyState: null, schemaValid: false,
      transportFresh: false, bookHash: null, hashChange: 'UNAVAILABLE',
      timeSinceLastHashChangeMs: null, pairRequestId: params.pairRequestId,
    };
  }
  const raw = params.raw as RawBook;
  const rawTimestamp = raw.timestamp;
  const sourceTimestampMs = rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === ''
    ? null
    : Number(rawTimestamp);
  const schemaValid = String(raw.asset_id ?? '') === params.tokenId &&
    Number.isFinite(sourceTimestampMs) && typeof raw.hash === 'string' && raw.hash.length > 0 &&
    validRawLevels(raw.bids) && validRawLevels(raw.asks);
  if (!schemaValid) {
    return {
      tokenId: params.tokenId,
      sourceTimestampMs: Number.isFinite(sourceTimestampMs) ? sourceTimestampMs : null,
      requestStartedAtMs: params.requestStartedAtMs, receivedAtMs: params.receivedAtMs,
      requestCompletedAtMs: params.requestCompletedAtMs,
      transportAgeMs: params.requestCompletedAtMs - params.requestStartedAtMs,
      bookStateAgeMs: Number.isFinite(sourceTimestampMs)
        ? params.requestCompletedAtMs - sourceTimestampMs! : null,
      rawRef: hashJson(raw), raw, normalized: emptyBook,
      state: 'INVALID_RESPONSE', topologyState: null, schemaValid: false,
      transportFresh: false, bookHash: typeof raw.hash === 'string' ? raw.hash : null,
      hashChange: 'UNAVAILABLE', timeSinceLastHashChangeMs: null,
      pairRequestId: params.pairRequestId,
    };
  }
  const normalized: ExecutableBook = {
    bids: normalizeLevels(raw.bids, true),
    asks: normalizeLevels(raw.asks, false),
    timestamp: sourceTimestampMs!,
  };
  const transportAgeMs = params.requestCompletedAtMs - params.requestStartedAtMs;
  const transportFresh = transportAgeMs <= params.transportStaleAfterMs;
  const topology = topologyState(normalized);
  return {
    tokenId: params.tokenId,
    sourceTimestampMs: sourceTimestampMs!,
    requestStartedAtMs: params.requestStartedAtMs,
    receivedAtMs: params.receivedAtMs,
    requestCompletedAtMs: params.requestCompletedAtMs,
    transportAgeMs,
    bookStateAgeMs: params.requestCompletedAtMs - sourceTimestampMs!,
    rawRef: hashJson(raw),
    raw,
    normalized,
    state: transportFresh ? topology : 'TRANSPORT_STALE',
    topologyState: topology,
    schemaValid: true,
    transportFresh,
    bookHash: raw.hash!, hashChange: 'UNAVAILABLE', timeSinceLastHashChangeMs: null,
    pairRequestId: params.pairRequestId,
  };
}

export function applyBookHashTracking(
  observation: BookObservation,
  state: Record<string, { hash: string; lastChangedAtMs: number }>,
): BookHashChange {
  if (!observation.schemaValid || !observation.bookHash) return 'UNAVAILABLE';
  const prior = state[observation.tokenId];
  if (!prior) {
    observation.hashChange = 'INITIAL';
    observation.timeSinceLastHashChangeMs = 0;
    state[observation.tokenId] = {
      hash: observation.bookHash, lastChangedAtMs: observation.requestCompletedAtMs,
    };
  } else if (prior.hash === observation.bookHash) {
    observation.hashChange = 'SAME';
    observation.timeSinceLastHashChangeMs = observation.requestCompletedAtMs - prior.lastChangedAtMs;
  } else {
    observation.hashChange = 'CHANGED';
    observation.timeSinceLastHashChangeMs = 0;
    state[observation.tokenId] = {
      hash: observation.bookHash, lastChangedAtMs: observation.requestCompletedAtMs,
    };
  }
  return observation.hashChange;
}

interface PairedBookFetch {
  pairRequestId: string;
  requestStartedAtMs: number;
  receivedAtMs: number;
  requestCompletedAtMs: number;
  rawBatchRef: string | null;
  rawBooks: unknown;
  observations: [BookObservation, BookObservation];
  error: string | null;
}

async function fetchBookPair(
  tokenIds: [string, string],
  transportStaleAfterMs: number,
  timeoutMs: number,
): Promise<PairedBookFetch> {
  const pairRequestId = randomUUID();
  const fallbackStartedAtMs = Date.now();
  try {
    const response = await fetchJson<unknown>(CLOB_BOOKS, timeoutMs, {
      method: 'POST', body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
    });
    const byAssetId = new Map<string, unknown>();
    const rawArray = Array.isArray(response.raw) ? response.raw : null;
    const batchSchemaValid = rawArray !== null;
    if (rawArray) {
      for (const value of rawArray) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const assetId = String((value as RawBook).asset_id ?? '');
          if (assetId) byAssetId.set(assetId, value);
        }
      }
    }
    const observations = tokenIds.map((tokenId) => makeBookObservation({
      tokenId,
      raw: batchSchemaValid ? (byAssetId.get(tokenId) ?? null) : response.raw,
      requestStartedAtMs: response.startedAtMs,
      receivedAtMs: response.receivedAtMs,
      requestCompletedAtMs: response.completedAtMs,
      pairRequestId,
      transportStaleAfterMs,
      absentState: batchSchemaValid && !byAssetId.has(tokenId) ? 'MISSING_BOOK' : undefined,
    })) as [BookObservation, BookObservation];
    return {
      pairRequestId, requestStartedAtMs: response.startedAtMs,
      receivedAtMs: response.receivedAtMs, requestCompletedAtMs: response.completedAtMs,
      rawBatchRef: hashJson(response.raw), rawBooks: response.raw, observations, error: null,
    };
  } catch (error) {
    const completedAtMs = Date.now();
    const observations = tokenIds.map((tokenId) => makeBookObservation({
      tokenId, raw: null, requestStartedAtMs: fallbackStartedAtMs,
      receivedAtMs: completedAtMs, requestCompletedAtMs: completedAtMs,
      pairRequestId, transportStaleAfterMs, absentState: 'REQUEST_FAILED',
    })) as [BookObservation, BookObservation];
    return {
      pairRequestId, requestStartedAtMs: fallbackStartedAtMs,
      receivedAtMs: completedAtMs, requestCompletedAtMs: completedAtMs,
      rawBatchRef: null, rawBooks: null, observations, error: describeError(error),
    };
  }
}

async function fetchBook(
  tokenId: string,
  transportStaleAfterMs: number,
  timeoutMs: number,
): Promise<BookObservation> {
  const pairRequestId = `single-${randomUUID()}`;
  const response = await fetchJson<RawBook>(`${CLOB_BOOK}?token_id=${encodeURIComponent(tokenId)}`, timeoutMs);
  return makeBookObservation({
    tokenId, raw: response.raw, requestStartedAtMs: response.startedAtMs,
    receivedAtMs: response.receivedAtMs, requestCompletedAtMs: response.completedAtMs,
    pairRequestId, transportStaleAfterMs,
  });
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

export function shadowStopReasons(stats: ShadowStats, config: TrustedShadowConfig): string[] {
  const reasons: string[] = [];
  if (stats.deniedPnlRecords > 0) reasons.push('DENIED_SOURCE_ENTERED_TRUSTED_LEDGER');
  if (stats.marketFetchSuccess === 0) reasons.push('MARKET_FEED_UNAVAILABLE');
  if (stats.bookPairRequests > 0 && stats.bookPairResponses === 0) {
    reasons.push('CLOB_BOOK_FEED_UNAVAILABLE');
  }
  if (stats.bookPairResponses > 0 && stats.booksAttempted > 0 && stats.schemaValidBooks === 0) {
    reasons.push('GLOBAL_BOOK_SCHEMA_INVALID');
  }
  const warmedUp = stats.cycles >= (config.minimumQualityCycles ?? 2) &&
    stats.marketsSampled >= (config.minimumQualityMarkets ?? 20) &&
    stats.bookPairRequests >= (config.minimumQualityPairs ?? 20);
  if (!warmedUp) return reasons;
  const feeUnknownRate = rate(stats.feeUnknown, stats.feeKnown + stats.feeDisabled + stats.feeUnknown);
  if (feeUnknownRate !== null && feeUnknownRate > 0.25) reasons.push('FEE_UNKNOWN_RATE_MATERIAL');
  const badBookRate = rate(
    stats.missingBookResponses + stats.invalidBookResponses + stats.requestFailedBooks + stats.transportStaleBooks,
    stats.booksAttempted,
  );
  if (badBookRate !== null && badBookRate > 0.50) reasons.push('BOOK_DATA_FAILURES_DOMINATE');
  const pairRejectRate = rate(stats.unreliableBookPairs, stats.bookPairRequests);
  if (pairRejectRate !== null && pairRejectRate > 0.20) reasons.push('BOOK_PAIRING_UNRELIABLE');
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
    `- Guards: ${JSON.stringify(manifest.guards)}\n` +
    `- Network preflight: ${JSON.stringify(manifest.networkPreflight ?? null)}\n` +
    `- Stop reasons: ${manifest.stopReasons.join(', ') || 'none'}\n`, 'utf8');
  writeFileSync(join(config.reportsDir, 'SHADOW_DATA_QUALITY.md'), `# Shadow Data Quality\n\n` + markdownTable([
    ['cycles', s.cycles], ['markets discovered', s.marketsDiscovered],
    ['markets sampled', s.marketsSampled], ['REST pair responses', s.bookPairResponses],
    ['two-sided books', s.twoSidedBooks], ['one-sided bid-only books', s.oneSidedBidOnlyBooks],
    ['one-sided ask-only books', s.oneSidedAskOnlyBooks], ['empty books', s.emptyBooks],
    ['missing books', s.missingBookResponses], ['invalid books', s.invalidBookResponses],
    ['request-failed books', s.requestFailedBooks], ['transport-stale books', s.transportStaleBooks],
    ['transport-fresh rate', rate(s.transportFreshBooks, s.schemaValidBooks)],
    ['hash initial', s.hashInitial], ['hash same', s.hashSame], ['hash changed', s.hashChanged],
    ['fee known rate', rate(s.feeKnown, s.feeKnown + s.feeDisabled + s.feeUnknown)],
    ['fee disabled rate', rate(s.feeDisabled, s.feeKnown + s.feeDisabled + s.feeUnknown)],
    ['fee unknown rate', rate(s.feeUnknown, s.feeKnown + s.feeDisabled + s.feeUnknown)],
    ['unreliable pair rate', rate(s.unreliableBookPairs, s.bookPairRequests)],
    ['errors', s.errors],
  ]) + `\n\nRatio warm-up: cycles >= ${config.minimumQualityCycles ?? 2}, sampled markets >= ${config.minimumQualityMarkets ?? 20}, book pairs >= ${config.minimumQualityPairs ?? 20}.\n\nStop conditions: ${manifest.stopReasons.join(', ') || 'none'}.\n`, 'utf8');
  writeFileSync(join(config.reportsDir, 'SHADOW_EDGE_FUNNEL.md'), `# Shadow Edge Funnel\n\n## Data-quality funnel\n\n` + markdownTable([
    ['market discovered', s.marketsDiscovered], ['metadata valid', s.metadataValidMarkets],
    ['book response obtained', s.bookResponsesObtained], ['schema valid', s.schemaValidBooks],
    ['transport fresh', s.transportFreshBooks],
  ]) + `\n\n## Strategy-eligibility funnel\n\n` + markdownTable([
    ['valid paired market data', s.reliableBookPairs],
    ['required executable sides available', s.requiredExecutableSidesPairs],
    ['enough depth', s.enoughDepthPairs], ['fee known', s.feeCoveredPairs],
    ['executable candidate', s.executableCandidateMarkets],
  ]) + `\n\nStrategy rejection reasons: ${JSON.stringify(s.strategyRejectionReasons)}.\n`, 'utf8');
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
      this.manifest.stats = {
        ...emptyShadowStats(), ...this.manifest.stats,
        sizeStress: this.manifest.stats.sizeStress ?? {},
        latencyStress: this.manifest.stats.latencyStress ?? {},
        strategyRejectionReasons: this.manifest.stats.strategyRejectionReasons ?? {},
      };
      this.manifest.bookHashState ??= {};
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
        stats: emptyShadowStats(),
        stopReasons: [],
        bookHashState: {},
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
      pairRequestId: observation.pairRequestId,
      receivedAtMs: observation.receivedAtMs,
      requestStartedAtMs: observation.requestStartedAtMs,
      requestCompletedAtMs: observation.requestCompletedAtMs,
      exchangeBookTimestampMs: observation.sourceTimestampMs,
      transportAgeMs: observation.transportAgeMs,
      bookStateAgeMs: observation.bookStateAgeMs,
      bookHash: observation.bookHash,
      hashChange: observation.hashChange,
      timeSinceLastHashChangeMs: observation.timeSinceLastHashChangeMs,
      rawBookRef: observation.rawRef, rawBook: observation.raw,
      normalizedBook: observation.normalized, state: observation.state,
      topologyState: observation.topologyState, schemaValid: observation.schemaValid,
      transportFresh: observation.transportFresh,
    });
  }

  private trackAndCountBook(observation: BookObservation): void {
    const stats = this.manifest.stats;
    stats.booksAttempted += 1;
    if (observation.raw !== null) stats.bookResponsesObtained += 1;
    if (observation.schemaValid) {
      stats.schemaValidBooks += 1;
      if (observation.transportFresh) stats.transportFreshBooks += 1;
      else stats.transportStaleBooks += 1;
    }
    if (observation.topologyState === 'TWO_SIDED') {
      stats.twoSidedBooks += 1;
      stats.completeBooks += 1;
    } else if (observation.topologyState === 'ONE_SIDED_BID_ONLY') {
      stats.oneSidedBidOnlyBooks += 1;
    } else if (observation.topologyState === 'ONE_SIDED_ASK_ONLY') {
      stats.oneSidedAskOnlyBooks += 1;
    } else if (observation.topologyState === 'EMPTY_BOOK') {
      stats.emptyBooks += 1;
    }
    if (observation.state === 'MISSING_BOOK') {
      stats.missingBookResponses += 1;
      stats.missingBooks += 1;
    } else if (observation.state === 'INVALID_RESPONSE') {
      stats.invalidBookResponses += 1;
      stats.missingBooks += 1;
    } else if (observation.state === 'REQUEST_FAILED') {
      stats.requestFailedBooks += 1;
      stats.missingBooks += 1;
    } else if (observation.state === 'TRANSPORT_STALE') {
      stats.staleBooks += 1;
    }
    const hashChange = applyBookHashTracking(observation, this.manifest.bookHashState);
    if (hashChange === 'INITIAL') stats.hashInitial += 1;
    else if (hashChange === 'SAME') stats.hashSame += 1;
    else if (hashChange === 'CHANGED') stats.hashChanged += 1;
  }

  private rejectStrategy(reason: string): void {
    const reasons = this.manifest.stats.strategyRejectionReasons;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
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
    const transportStaleAfterMs = this.config.transportStaleAfterMs ?? this.config.staleAfterMs;
    let markets: GammaMarket[];
    try {
      const discoveryLimit = Math.max(this.config.discoveryLimit ?? 50, this.config.marketLimit);
      const query = new URLSearchParams({
        active: 'true', closed: 'false', limit: String(discoveryLimit),
        order: 'volume24hr', ascending: 'false',
      });
      const fetched = await fetchJson<GammaMarket[]>(`${GAMMA_MARKETS}?${query}`, timeoutMs);
      markets = Array.isArray(fetched.raw) ? fetched.raw : [];
      stats.marketFetchSuccess += 1;
      stats.marketsDiscovered += markets.length;
      const validMarkets = markets.filter(validResearchMarket)
        .sort((a, b) => researchMarketRank(b) - researchMarketRank(a));
      stats.metadataValidMarkets += validMarkets.length;
      markets = validMarkets.slice(0, this.config.marketLimit);
      stats.marketsSampled += markets.length;
      this.writer.append({
        eventType: 'market_batch', runId: this.manifest.runId, commitSha: this.manifest.commitSha,
        processStartTime: this.manifest.processStartTime,
        requestStartedAtMs: fetched.startedAtMs, receivedAtMs: fetched.receivedAtMs,
        requestCompletedAtMs: fetched.completedAtMs,
        rawDiscoveryUniverseCount: Array.isArray(fetched.raw) ? fetched.raw.length : 0,
        metadataValidCount: validMarkets.length, sampledCount: markets.length,
        sampledMarketIds: markets.map((market) => String(market.conditionId ?? market.condition_id ?? market.id)),
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

      stats.bookPairRequests += 1;
      const pair = await fetchBookPair(
        [tokenIds[0], tokenIds[1]], transportStaleAfterMs, timeoutMs,
      );
      if (pair.error === null) stats.bookPairResponses += 1;
      else stats.errors += 1;
      const [yes, no] = pair.observations;
      for (const observation of [yes, no]) {
        this.trackAndCountBook(observation);
        this.recordBook(marketId, observation);
      }
      this.writer.append({
        eventType: 'book_pair', runId: this.manifest.runId, commitSha: this.manifest.commitSha,
        processStartTime: this.manifest.processStartTime, marketId, tokenIds,
        pairRequestId: pair.pairRequestId, requestStartedAtMs: pair.requestStartedAtMs,
        receivedAtMs: pair.receivedAtMs, requestCompletedAtMs: pair.requestCompletedAtMs,
        rawBatchRef: pair.rawBatchRef, rawBooks: pair.rawBooks, error: pair.error,
        yes: { timestampMs: yes.sourceTimestampMs, hash: yes.bookHash, state: yes.state, topology: yes.topologyState },
        no: { timestampMs: no.sourceTimestampMs, hash: no.bookHash, state: no.state, topology: no.topologyState },
      });

      const sizes = this.config.sizesUsd ?? SHADOW_V1_SIZES_USD;
      const latencies = [...(this.config.latenciesMs ?? SHADOW_V1_LATENCIES_MS)].sort((a, b) => a - b);
      const scenarioCount = sizes.length * latencies.length;
      const sourceGap = yes.sourceTimestampMs === null || no.sourceTimestampMs === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(yes.sourceTimestampMs - no.sourceTimestampMs);
      const pairReliable = yes.schemaValid && no.schemaValid && yes.transportFresh && no.transportFresh;
      if (!pairReliable) {
        stats.unreliableBookPairs += 1;
        stats.pairedBooksRejected += 1;
        stats.pairedStrategyIneligible += 1;
        const rejection = pair.error ? 'REQUEST_FAILED'
          : [yes, no].some((value) => value.state === 'INVALID_RESPONSE') ? 'INVALID_RESPONSE'
            : [yes, no].some((value) => value.state === 'MISSING_BOOK') ? 'MISSING_BOOK'
              : 'TRANSPORT_STALE';
        this.rejectStrategy(rejection);
        this.writer.append({
          eventType: 'strategy_rejected', marketId, tokenIds, sourceGapMs: sourceGap,
          pairRequestId: pair.pairRequestId,
          yesRawRef: yes.rawRef, noRawRef: no.rawRef,
          reason: rejection, dataQualityEligible: false,
        });
        continue;
      }
      stats.reliableBookPairs += 1;
      stats.pairedMarketsAvailable += 1;
      const yesExecutable = yes.normalized.asks.length > 0;
      const noExecutable = no.normalized.asks.length > 0;
      if (!yesExecutable || !noExecutable) {
        stats.pairedStrategyIneligible += 1;
        const rejection = !yesExecutable && !noExecutable ? 'BOTH_BUY_SIDES_UNAVAILABLE'
          : !yesExecutable ? 'YES_BUY_SIDE_UNAVAILABLE' : 'NO_BUY_SIDE_UNAVAILABLE';
        this.rejectStrategy(rejection);
        this.writer.append({
          eventType: 'strategy_rejected', marketId, tokenIds, pairRequestId: pair.pairRequestId,
          reason: rejection, dataQualityEligible: true,
          topology: { yes: yes.topologyState, no: no.topologyState },
        });
        continue;
      }
      stats.pairedBooksAvailable += scenarioCount;
      stats.requiredExecutableSidesPairs += 1;
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
        if (economics.complete) stats.depthAvailable += latencies.length;
        if (economics.complete && economics.feeStatus === 'KNOWN') {
          stats.feeKnownCandidate += latencies.length;
        }
        if (economics.complete && economics.feeStatus === 'KNOWN' && economics.positiveExecutableEdge) {
          stats.detectedCandidate += latencies.length;
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
          localReceiveTimestampsMs: [yes.requestCompletedAtMs, no.requestCompletedAtMs],
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
            validMarketData: true, requiredExecutableSidesAvailable: true,
            depthAvailable: economics.complete,
            feeKnown: economics.feeStatus === 'KNOWN', executableCandidate: economics.positiveExecutableEdge,
          },
        });
      }

      const enoughDepth = evaluated.some((value) => value.complete && value.requestedShares > 0);
      const feeCovered = evaluated.some((value) => value.feeStatus === 'KNOWN');
      if (enoughDepth) stats.enoughDepthPairs += 1;
      if (enoughDepth && feeCovered) stats.feeCoveredPairs += 1;
      if (!enoughDepth || !feeCovered) {
        stats.pairedStrategyIneligible += 1;
        const rejection = enoughDepth ? 'FEE_UNKNOWN' : 'INSUFFICIENT_EXECUTABLE_DEPTH';
        this.rejectStrategy(rejection);
        this.writer.append({
          eventType: 'strategy_rejected', marketId, tokenIds, pairRequestId: pair.pairRequestId,
          reason: rejection, dataQualityEligible: true,
        });
        continue;
      }
      stats.pairedStrategyEligible += 1;
      const viable = evaluated.filter((value) => value.positiveExecutableEdge);
      if (viable.length === 0) {
        this.rejectStrategy('NO_POSITIVE_EXECUTABLE_EDGE');
        this.writer.append({
          eventType: 'strategy_rejected', marketId, tokenIds, pairRequestId: pair.pairRequestId,
          reason: 'NO_POSITIVE_EXECUTABLE_EDGE', dataQualityEligible: true,
        });
        continue;
      }
      stats.executableCandidateMarkets += 1;
      const detectedAtMs = Date.now();
      const laterNoBooks = new Map<number, BookObservation>();
      for (const latencyMs of latencies) {
        const waitMs = detectedAtMs + latencyMs - Date.now();
        if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
        try {
          const observed = await fetchBook(tokenIds[1], transportStaleAfterMs, timeoutMs);
          this.trackAndCountBook(observed);
          this.recordBook(marketId, observed);
          laterNoBooks.set(latencyMs, observed);
        } catch (error) {
          stats.booksAttempted += 1;
          stats.requestFailedBooks += 1;
          stats.missingBooks += 1;
          stats.errors += 1;
          this.writer.append({ eventType: 'error', scope: 'second_leg', marketId, latencyMs, error: describeError(error) });
        }
      }

      for (const economics of viable) {
        for (const latencyMs of latencies) {
          const laterNo = laterNoBooks.get(latencyMs);
          if (!laterNo || !laterNo.schemaValid || !laterNo.transportFresh || laterNo.normalized.asks.length === 0) continue;
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
            localReceiveTimestampsMs: [yes.requestCompletedAtMs, laterNo.requestCompletedAtMs],
            rawBookRefs: [yes.rawRef, laterNo.rawRef], feeMetadata: feeContext,
            feeStatus: result.fees === null ? FEE_UNKNOWN : 'KNOWN',
            strategy: 'complete-set-executable-economics', requestedSizeUsd: economics.capitalUsd,
            requestedShares: economics.requestedShares, actualSimulatedFill: result.executions,
            vwap: result.executions.map((execution) => execution.fill.vwap),
            configuredLatencyMs: latencyMs, observedDelayMs: laterNo.requestCompletedAtMs - detectedAtMs,
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
      const networkPreflight = await runPublicDataPreflight({
        timeoutMs: this.config.fetchTimeoutMs ?? 15_000,
        maxAttempts: this.config.preflightAttempts ?? 3,
        initialBackoffMs: this.config.preflightBackoffMs ?? 500,
        marketLimit: Math.max(10, this.config.marketLimit),
      });
      this.manifest.networkPreflight = networkPreflight;
      this.writer.append({
        eventType: 'network_preflight', runId: this.manifest.runId,
        commitSha: this.manifest.commitSha, processStartTime: this.manifest.processStartTime,
        ...networkPreflight,
      });
      this.syncSequence();
      if (!networkPreflight.success) {
        this.manifest.status = 'blocked';
        this.manifest.stopReasons = [
          `NETWORK_PREFLIGHT_${networkPreflight.failure ?? 'NETWORK_FAILURE'}`,
          'MARKET_FEED_UNAVAILABLE',
        ];
        this.writer.append({
          eventType: 'stop_condition', reasons: this.manifest.stopReasons,
          networkPreflight,
        });
        this.syncSequence();
        return this.manifest;
      }
      while (Date.now() < deadline && !signal?.aborted) {
        await this.runCycle();
        this.manifest.stats.cycles += 1;
        this.manifest.lastCompletedCycle += 1;
        this.syncSequence();
        const reasons = shadowStopReasons(this.manifest.stats, this.config);
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
