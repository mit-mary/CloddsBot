export const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';
export const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';

export type PreflightFailure =
  | 'DNS_FAILURE'
  | 'CONNECT_TIMEOUT'
  | 'TLS_FAILURE'
  | 'HTTP_4XX'
  | 'HTTP_429'
  | 'HTTP_5XX'
  | 'INVALID_RESPONSE'
  | 'NETWORK_FAILURE';

export interface PreflightAttempt {
  attempt: number;
  source: 'gamma' | 'clob';
  success: boolean;
  httpStatus: number | null;
  elapsedMs: number;
  failure: PreflightFailure | null;
  errorCode: string | null;
  retryable: boolean;
}

export interface PublicDataPreflightResult {
  success: boolean;
  attemptsUsed: number;
  failure: PreflightFailure | null;
  marketId: string | null;
  tokenId: string | null;
  gammaMarketCount: number;
  clobBidLevels: number;
  clobAskLevels: number;
  observations: PreflightAttempt[];
}

export interface PublicDataPreflightOptions {
  timeoutMs: number;
  maxAttempts: number;
  initialBackoffMs: number;
  marketLimit?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface MarketCandidate {
  marketId: string;
  tokenIds: string[];
}

interface CheckedJson {
  success: boolean;
  body: unknown;
  observation: PreflightAttempt;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA']);
const CONNECT_TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_SSL_CERT_ALTNAME_INVALID',
  'ERR_SSL_HANDSHAKE_FAILURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function nestedErrors(error: unknown): unknown[] {
  const found: unknown[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    if (typeof current === 'object') {
      const value = current as { cause?: unknown; errors?: unknown[] };
      if (value.cause !== undefined) queue.push(value.cause);
      if (Array.isArray(value.errors)) queue.push(...value.errors);
    }
  }
  return found;
}

function errorCode(error: unknown): string | null {
  for (const value of nestedErrors(error)) {
    if (typeof value === 'object' && value !== null && 'code' in value) {
      const code = String((value as { code?: unknown }).code ?? '');
      if (code) return code;
    }
  }
  return null;
}

export function classifyPreflightError(error: unknown): {
  failure: PreflightFailure;
  errorCode: string | null;
  retryable: boolean;
} {
  const errors = nestedErrors(error);
  const codes = errors
    .filter((value): value is { code?: unknown } => typeof value === 'object' && value !== null)
    .map((value) => String(value.code ?? ''));
  const names = errors
    .filter((value): value is { name?: unknown } => typeof value === 'object' && value !== null)
    .map((value) => String(value.name ?? ''));
  if (codes.some((code) => DNS_CODES.has(code))) {
    return { failure: 'DNS_FAILURE', errorCode: codes.find((code) => DNS_CODES.has(code))!, retryable: false };
  }
  if (codes.some((code) => CONNECT_TIMEOUT_CODES.has(code)) || names.includes('TimeoutError')) {
    return {
      failure: 'CONNECT_TIMEOUT',
      errorCode: codes.find((code) => CONNECT_TIMEOUT_CODES.has(code)) ?? null,
      retryable: true,
    };
  }
  if (codes.some((code) => TLS_CODES.has(code) || code.startsWith('ERR_SSL_'))) {
    return {
      failure: 'TLS_FAILURE',
      errorCode: codes.find((code) => TLS_CODES.has(code) || code.startsWith('ERR_SSL_'))!,
      retryable: false,
    };
  }
  return { failure: 'NETWORK_FAILURE', errorCode: errorCode(error), retryable: false };
}

function httpFailure(status: number): PreflightFailure | null {
  if (status === 429) return 'HTTP_429';
  if (status >= 400 && status < 500) return 'HTTP_4XX';
  if (status >= 500) return 'HTTP_5XX';
  return null;
}

async function checkedJson(
  url: string,
  source: 'gamma' | 'clob',
  attempt: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<CheckedJson> {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'clodds-trusted-shadow-v1-preflight' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const failure = httpFailure(response.status);
    if (failure) {
      return {
        success: false,
        body: null,
        observation: {
          attempt, source, success: false, httpStatus: response.status,
          elapsedMs: Date.now() - startedAt, failure, errorCode: null,
          retryable: failure === 'HTTP_429' || failure === 'HTTP_5XX',
        },
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        success: false,
        body: null,
        observation: {
          attempt, source, success: false, httpStatus: response.status,
          elapsedMs: Date.now() - startedAt, failure: 'INVALID_RESPONSE',
          errorCode: null, retryable: false,
        },
      };
    }
    return {
      success: true,
      body,
      observation: {
        attempt, source, success: true, httpStatus: response.status,
        elapsedMs: Date.now() - startedAt, failure: null, errorCode: null, retryable: false,
      },
    };
  } catch (error) {
    const classified = classifyPreflightError(error);
    return {
      success: false,
      body: null,
      observation: {
        attempt, source, success: false, httpStatus: null,
        elapsedMs: Date.now() - startedAt, ...classified,
      },
    };
  }
}

function marketCandidates(body: unknown): MarketCandidate[] {
  if (!Array.isArray(body)) return [];
  const candidates: MarketCandidate[] = [];
  for (const value of body) {
    if (typeof value !== 'object' || value === null) continue;
    const market = value as Record<string, unknown>;
    const marketId = String(market.conditionId ?? market.condition_id ?? market.id ?? '');
    const tokenIds = parseStringArray(market.clobTokenIds ?? market.token_ids);
    if (marketId && tokenIds.length === 2 && tokenIds.every(Boolean)) candidates.push({ marketId, tokenIds });
  }
  return candidates;
}

function validBook(body: unknown): body is { bids: unknown[]; asks: unknown[] } {
  if (typeof body !== 'object' || body === null) return false;
  const book = body as { bids?: unknown; asks?: unknown };
  return Array.isArray(book.bids) && Array.isArray(book.asks) && book.bids.length > 0 && book.asks.length > 0;
}

export async function runPublicDataPreflight(
  options: PublicDataPreflightOptions,
): Promise<PublicDataPreflightResult> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 10) {
    throw new Error('preflight maxAttempts must be an integer from 1 to 10');
  }
  if (!Number.isFinite(options.initialBackoffMs) || options.initialBackoffMs < 0) {
    throw new Error('preflight initialBackoffMs must be non-negative');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const observations: PreflightAttempt[] = [];
  let finalFailure: PreflightFailure = 'INVALID_RESPONSE';

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const query = new URLSearchParams({
      active: 'true', closed: 'false', limit: String(Math.max(1, options.marketLimit ?? 10)),
      order: 'volume24hr', ascending: 'false',
    });
    const gamma = await checkedJson(
      `${GAMMA_MARKETS_URL}?${query}`, 'gamma', attempt, options.timeoutMs, fetchImpl,
    );
    observations.push(gamma.observation);
    if (!gamma.success) {
      finalFailure = gamma.observation.failure!;
      if (gamma.observation.retryable && attempt < options.maxAttempts) {
        await sleep(options.initialBackoffMs * (2 ** (attempt - 1)));
        continue;
      }
      break;
    }

    const candidates = marketCandidates(gamma.body);
    if (candidates.length === 0) {
      observations.push({
        attempt, source: 'gamma', success: false, httpStatus: gamma.observation.httpStatus,
        elapsedMs: 0, failure: 'INVALID_RESPONSE', errorCode: null, retryable: false,
      });
      finalFailure = 'INVALID_RESPONSE';
      break;
    }

    let lastClobFailure: PreflightAttempt | null = null;
    for (const candidate of candidates.slice(0, 5)) {
      for (const tokenId of candidate.tokenIds) {
        const clob = await checkedJson(
          `${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`,
          'clob', attempt, options.timeoutMs, fetchImpl,
        );
        if (clob.success && validBook(clob.body)) {
          observations.push(clob.observation);
          return {
            success: true, attemptsUsed: attempt, failure: null,
            marketId: candidate.marketId, tokenId,
            gammaMarketCount: Array.isArray(gamma.body) ? gamma.body.length : 0,
            clobBidLevels: clob.body.bids.length, clobAskLevels: clob.body.asks.length,
            observations,
          };
        }
        if (clob.success) {
          const invalid: PreflightAttempt = {
            attempt, source: 'clob', success: false, httpStatus: clob.observation.httpStatus,
            elapsedMs: clob.observation.elapsedMs, failure: 'INVALID_RESPONSE',
            errorCode: null, retryable: false,
          };
          observations.push(invalid);
          lastClobFailure = invalid;
        } else {
          observations.push(clob.observation);
          lastClobFailure = clob.observation;
        }
      }
    }
    finalFailure = lastClobFailure?.failure ?? 'INVALID_RESPONSE';
    if (lastClobFailure?.retryable && attempt < options.maxAttempts) {
      await sleep(options.initialBackoffMs * (2 ** (attempt - 1)));
      continue;
    }
    break;
  }

  return {
    success: false,
    attemptsUsed: Math.max(0, ...observations.map((value) => value.attempt)),
    failure: finalFailure,
    marketId: null,
    tokenId: null,
    gammaMarketCount: 0,
    clobBidLevels: 0,
    clobAskLevels: 0,
    observations,
  };
}
