import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import {
  evaluatePairAtSize,
  applyBookHashTracking,
  emptyShadowStats,
  makeBookObservation,
  SHADOW_V1_LATENCIES_MS,
  SHADOW_V1_SIZES_USD,
  shadowStopReasons,
  TrustedShadowV1Runner,
  type TrustedShadowConfig,
} from '../../src/shadow/trusted-shadow-v1.js';

function config(root: string, resume = false): TrustedShadowConfig {
  return {
    runDir: join(root, 'run'), reportsDir: join(root, 'reports'),
    commitSha: 'a'.repeat(40), stage: 'A', durationSeconds: 1,
    intervalMs: 0, marketLimit: 1, safetySlippageBps: 25,
    staleAfterMs: 5000, maxPairGapMs: 2000, resume,
  };
}

describe('trusted shadow v1 economics harness', () => {
  it('uses the required size and latency grids', () => {
    assert.deepEqual(SHADOW_V1_SIZES_USD, [10, 25, 50, 100, 250, 500, 1000]);
    assert.deepEqual(SHADOW_V1_LATENCIES_MS, [0, 100, 250, 500, 1000, 2000, 3000, 5000]);
  });

  it('attributes executable PnL without midpoint or last-price inputs', () => {
    const result = evaluatePairAtSize({
      yes: { timestamp: 1, bids: [[0.47, 100]], asks: [[0.48, 100]] },
      no: { timestamp: 1, bids: [[0.47, 100]], asks: [[0.48, 100]] },
      capitalUsd: 10,
      feeContext: { feesEnabled: false },
      safetySlippageBps: 0,
    });
    assert.equal(result.complete, true);
    assert.equal(result.feeStatus, 'KNOWN');
    assert.ok(result.executablePnl !== null && result.executablePnl > 0);
    assert.ok(Math.abs(
      result.theoreticalEdge - result.depthImpact - result.safetySlippage - result.executablePnl!,
    ) < 1e-10);
  });

  it('fails closed when fee metadata is unknown', () => {
    const result = evaluatePairAtSize({
      yes: { timestamp: 1, bids: [[0.39, 100]], asks: [[0.40, 100]] },
      no: { timestamp: 1, bids: [[0.39, 100]], asks: [[0.40, 100]] },
      capitalUsd: 10,
      feeContext: {},
      safetySlippageBps: 25,
    });
    assert.equal(result.feeStatus, 'FEE_UNKNOWN');
    assert.equal(result.fees, null);
    assert.equal(result.executablePnl, null);
    assert.equal(result.positiveExecutableEdge, false);
  });

  it('separates fresh REST transport from old unchanged book state', () => {
    const observation = makeBookObservation({
      tokenId: 'yes', pairRequestId: 'pair-1', requestStartedAtMs: 10_000,
      receivedAtMs: 10_080, requestCompletedAtMs: 10_100,
      transportStaleAfterMs: 5_000,
      raw: {
        asset_id: 'yes', timestamp: '1000', hash: 'hash-1',
        bids: [{ price: '0.4', size: '10' }], asks: [{ price: '0.6', size: '10' }],
      },
    });
    assert.equal(observation.transportFresh, true);
    assert.equal(observation.transportAgeMs, 100);
    assert.equal(observation.bookStateAgeMs, 9_100);
    assert.equal(observation.state, 'TWO_SIDED');
  });

  it('records one-sided books as valid market state rather than missing data', () => {
    const observation = makeBookObservation({
      tokenId: 'yes', pairRequestId: 'pair-1', requestStartedAtMs: 1_000,
      receivedAtMs: 1_010, requestCompletedAtMs: 1_020,
      transportStaleAfterMs: 5_000,
      raw: {
        asset_id: 'yes', timestamp: '900', hash: 'hash-1', bids: [],
        asks: [{ price: '0.6', size: '10' }],
      },
    });
    assert.equal(observation.schemaValid, true);
    assert.equal(observation.topologyState, 'ONE_SIDED_ASK_ONLY');
    assert.equal(observation.state, 'ONE_SIDED_ASK_ONLY');
  });

  it('uses local request duration for TRANSPORT_STALE', () => {
    const observation = makeBookObservation({
      tokenId: 'yes', pairRequestId: 'pair-1', requestStartedAtMs: 1_000,
      receivedAtMs: 6_900, requestCompletedAtMs: 7_000,
      transportStaleAfterMs: 5_000,
      raw: {
        asset_id: 'yes', timestamp: '6950', hash: 'hash-1',
        bids: [{ price: '0.4', size: '10' }], asks: [{ price: '0.6', size: '10' }],
      },
    });
    assert.equal(observation.bookStateAgeMs, 50);
    assert.equal(observation.transportFresh, false);
    assert.equal(observation.state, 'TRANSPORT_STALE');
  });

  it('tracks initial, same, and changed official book hashes without inventing activity', () => {
    const state: Record<string, { hash: string; lastChangedAtMs: number }> = {};
    const observed = (hash: string, completed: number) => makeBookObservation({
      tokenId: 'yes', pairRequestId: 'pair-1', requestStartedAtMs: completed - 10,
      receivedAtMs: completed - 1, requestCompletedAtMs: completed,
      transportStaleAfterMs: 5_000,
      raw: {
        asset_id: 'yes', timestamp: String(completed - 100), hash,
        bids: [{ price: '0.4', size: '10' }], asks: [{ price: '0.6', size: '10' }],
      },
    });
    const first = observed('hash-1', 1_000);
    const same = observed('hash-1', 2_000);
    const changed = observed('hash-2', 3_000);
    assert.equal(applyBookHashTracking(first, state), 'INITIAL');
    assert.equal(applyBookHashTracking(same, state), 'SAME');
    assert.equal(same.timeSinceLastHashChangeMs, 1_000);
    assert.equal(applyBookHashTracking(changed, state), 'CHANGED');
    assert.equal(changed.timeSinceLastHashChangeMs, 0);
  });

  it('does not apply ratio stops before the explicit quality warm-up', () => {
    const stats = emptyShadowStats();
    Object.assign(stats, {
      marketFetchSuccess: 1, cycles: 1, marketsSampled: 3, bookPairRequests: 3,
      bookPairResponses: 3,
      booksAttempted: 6, schemaValidBooks: 6, transportStaleBooks: 4, unreliableBookPairs: 2,
    });
    assert.deepEqual(shadowStopReasons(stats, config('unused')), []);
  });

  it('applies unchanged quality thresholds after the warm-up denominator', () => {
    const stats = emptyShadowStats();
    Object.assign(stats, {
      marketFetchSuccess: 1, cycles: 2, marketsSampled: 20, bookPairRequests: 20,
      bookPairResponses: 20,
      booksAttempted: 40, schemaValidBooks: 40, transportStaleBooks: 24, unreliableBookPairs: 10,
    });
    assert.deepEqual(shadowStopReasons(stats, config('unused')), [
      'BOOK_DATA_FAILURES_DOMINATE', 'BOOK_PAIRING_UNRELIABLE',
    ]);
  });

  it('keeps structural CLOB unavailability as an immediate hard stop', () => {
    const stats = emptyShadowStats();
    Object.assign(stats, { marketFetchSuccess: 1, cycles: 1, bookPairRequests: 3 });
    assert.deepEqual(shadowStopReasons(stats, config('unused')), ['CLOB_BOOK_FEED_UNAVAILABLE']);
  });

  it('preserves contiguous crash-tail provenance across restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-shadow-v1-'));
    try {
      new TrustedShadowV1Runner(config(root));
      const manifestPath = join(root, 'run', 'manifest.json');
      const eventPath = join(root, 'run', 'events.jsonl');
      const before = JSON.parse(readFileSync(manifestPath, 'utf8')) as { lastSequence: number };
      appendFileSync(eventPath, `${JSON.stringify({
        sequence: before.lastSequence + 1,
        eventType: 'crash_tail_test',
      })}\n`);
      new TrustedShadowV1Runner(config(root, true));
      const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        recoveredIncompleteEventRanges: Array<{ fromSequence: number; toSequence: number }>;
      };
      assert.deepEqual(after.recoveredIncompleteEventRanges, [{
        fromSequence: before.lastSequence + 1,
        toSequence: before.lastSequence + 1,
        recoveredAt: after.recoveredIncompleteEventRanges[0].recoveredAt,
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects non-contiguous event provenance on restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-shadow-v1-'));
    try {
      new TrustedShadowV1Runner(config(root));
      const manifest = JSON.parse(readFileSync(join(root, 'run', 'manifest.json'), 'utf8')) as {
        lastSequence: number;
      };
      appendFileSync(join(root, 'run', 'events.jsonl'), `${JSON.stringify({
        sequence: manifest.lastSequence + 2,
        eventType: 'gap',
      })}\n`);
      assert.throws(
        () => new TrustedShadowV1Runner(config(root, true)),
        /RESTART_PROVENANCE_CORRUPT/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
