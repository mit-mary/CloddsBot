import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import {
  evaluatePairAtSize,
  SHADOW_V1_LATENCIES_MS,
  SHADOW_V1_SIZES_USD,
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
