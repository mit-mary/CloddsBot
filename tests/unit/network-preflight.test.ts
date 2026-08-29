import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyPreflightError,
  runPublicDataPreflight,
} from '../../src/shadow/network-preflight.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function marketBatch(): unknown[] {
  return [{
    conditionId: 'condition-1',
    clobTokenIds: JSON.stringify(['token-yes', 'token-no']),
  }];
}

function pairedBooks(): unknown[] {
  return [
    { asset_id: 'token-yes', timestamp: '1000', hash: 'yes-hash', bids: [], asks: [{ price: '0.6', size: '10' }] },
    { asset_id: 'token-no', timestamp: '1000', hash: 'no-hash', bids: [{ price: '0.4', size: '10' }], asks: [] },
  ];
}

describe('trusted shadow public-data network preflight', () => {
  it('requires valid Gamma metadata and a real CLOB book', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return urls.length === 1
        ? jsonResponse(marketBatch())
        : jsonResponse(pairedBooks());
    }) as typeof fetch;
    const result = await runPublicDataPreflight({
      timeoutMs: 1000, maxAttempts: 3, initialBackoffMs: 1, fetchImpl,
    });
    assert.equal(result.success, true);
    assert.equal(result.attemptsUsed, 1);
    assert.equal(result.marketId, 'condition-1');
    assert.equal(result.tokenId, 'token-yes');
    assert.equal(result.gammaMarketCount, 1);
    assert.equal(result.clobBidLevels, 1);
    assert.equal(result.clobAskLevels, 1);
    assert.match(urls[0], /^https:\/\/gamma-api\.polymarket\.com\/markets\?/);
    assert.equal(urls[1], 'https://clob.polymarket.com/books');
  });

  it('classifies required HTTP and invalid-response failure modes', async () => {
    const cases: Array<[number, string]> = [
      [400, 'HTTP_4XX'], [429, 'HTTP_429'], [503, 'HTTP_5XX'],
    ];
    for (const [status, expected] of cases) {
      const result = await runPublicDataPreflight({
        timeoutMs: 1000, maxAttempts: 1, initialBackoffMs: 0,
        fetchImpl: (async () => jsonResponse({}, status)) as typeof fetch,
      });
      assert.equal(result.failure, expected);
    }
    const invalid = await runPublicDataPreflight({
      timeoutMs: 1000, maxAttempts: 1, initialBackoffMs: 0,
      fetchImpl: (async () => jsonResponse({ not: 'an array' })) as typeof fetch,
    });
    assert.equal(invalid.failure, 'INVALID_RESPONSE');
  });

  it('distinguishes DNS, connect-timeout, and TLS failures', () => {
    const nested = (code: string, name = 'Error') => new TypeError('fetch failed', {
      cause: Object.assign(new Error(code), { code, name }),
    });
    assert.equal(classifyPreflightError(nested('ENOTFOUND')).failure, 'DNS_FAILURE');
    assert.equal(classifyPreflightError(nested('UND_ERR_CONNECT_TIMEOUT', 'ConnectTimeoutError')).failure, 'CONNECT_TIMEOUT');
    assert.equal(classifyPreflightError(nested('CERT_HAS_EXPIRED')).failure, 'TLS_FAILURE');
  });

  it('uses bounded exponential backoff only for retryable startup failures', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const timeout = () => new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect timeout'), {
        name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    });
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= 2) throw timeout();
      if (calls === 3) return jsonResponse(marketBatch());
      return jsonResponse(pairedBooks());
    }) as typeof fetch;
    const result = await runPublicDataPreflight({
      timeoutMs: 1000, maxAttempts: 3, initialBackoffMs: 100, fetchImpl,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });
    assert.equal(result.success, true);
    assert.equal(result.attemptsUsed, 3);
    assert.deepEqual(sleeps, [100, 200]);
    assert.equal(calls, 4);
  });

  it('stops after the bounded retry budget', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      });
    }) as typeof fetch;
    const result = await runPublicDataPreflight({
      timeoutMs: 1000, maxAttempts: 3, initialBackoffMs: 0, fetchImpl,
      sleep: async () => {},
    });
    assert.equal(result.success, false);
    assert.equal(result.failure, 'CONNECT_TIMEOUT');
    assert.equal(result.attemptsUsed, 3);
    assert.equal(calls, 3);
  });
});
