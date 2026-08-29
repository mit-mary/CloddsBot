import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FEE_UNKNOWN,
  quotePolymarketFee,
  selectDelayedBookSnapshot,
  simulateBookFill,
  simulateSequentialMultiLeg,
} from '../../src/execution/prediction-market-economics.js';

describe('prediction market execution economics', () => {
  it('walks full ask depth and returns the oracle VWAP', () => {
    const fill = simulateBookFill({
      book: { bids: [[0.40, 100]], asks: [[0.42, 2], [0.43, 10], [0.47, 100]] },
      side: 'buy',
      shares: 100,
    });
    assert.equal(fill.status, 'full');
    assert.equal(fill.filledSize, 100);
    assert.ok(Math.abs(fill.vwap! - 0.465) < 1e-12);
    assert.equal(fill.levelsConsumed.length, 3);
  });

  it('reports partial and no fills without fabricating prices', () => {
    const partial = simulateBookFill({
      book: { bids: [], asks: [[0.42, 2], [0.43, 3]] },
      side: 'buy',
      shares: 10,
    });
    assert.equal(partial.status, 'partial');
    assert.equal(partial.filledSize, 5);
    assert.equal(partial.unfilledSize, 5);

    const none = simulateBookFill({ book: { bids: [], asks: [] }, side: 'sell', shares: 2 });
    assert.equal(none.status, 'none');
    assert.equal(none.vwap, null);
  });

  it('uses dynamic Polymarket fees and propagates FEE_UNKNOWN', () => {
    const known = quotePolymarketFee({
      shares: 100,
      price: 0.465,
      feesEnabled: true,
      feeSchedule: { rate: 0.05, exponent: 1 },
    });
    assert.equal(known.status, 'KNOWN');
    assert.equal(known.fee, 1.24388);

    const disabled = quotePolymarketFee({ shares: 1, price: 0.5, feesEnabled: false });
    assert.equal(disabled.fee, 0);

    const unknown = quotePolymarketFee({ shares: 1, price: 0.5 });
    assert.equal(unknown.status, FEE_UNKNOWN);
    assert.equal(unknown.fee, null);
  });

  it('records sequential leg timing, matched quantity, and unhedged size', () => {
    const result = simulateSequentialMultiLeg({
      detectedAtMs: 1000,
      legs: [
        {
          id: 'yes', side: 'buy', shares: 10, latencyMs: 0,
          book: { bids: [], asks: [[0.40, 10]] },
          feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
        },
        {
          id: 'no', side: 'buy', shares: 10, latencyMs: 500,
          book: { bids: [], asks: [[0.50, 3]] },
          feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
        },
      ],
    });
    assert.equal(result.complete, false);
    assert.equal(result.matchedQuantity, 3);
    assert.equal(result.legImbalance, 7);
    assert.equal(result.unhedgedSize, 7);
    assert.equal(result.secondLegDelayMs, 500);
  });

  it('uses the independent T0+500ms second-leg book at 0.60', () => {
    const result = simulateSequentialMultiLeg({
      detectedAtMs: 1000,
      legs: [
        {
          id: 'yes', side: 'buy', shares: 10, latencyMs: 0,
          book: { timestamp: 1000, bids: [[0.41, 10]], asks: [[0.42, 10]] },
          feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
        },
        {
          id: 'no', side: 'buy', shares: 10, latencyMs: 500,
          book: { timestamp: 1500, bids: [[0.59, 10]], asks: [[0.60, 10]] },
          feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
        },
      ],
    });
    assert.ok(Math.abs(result.executions[0].fill.vwap! - 0.42) < 1e-12);
    assert.ok(Math.abs(result.executions[1].fill.vwap! - 0.60) < 1e-12);
    assert.ok(Math.abs(result.combinedCost - 10.2) < 1e-12);
    assert.ok(Math.abs(result.pnl! + 0.2) < 1e-12);
  });

  it('preserves unhedged inventory for zero and partial later liquidity', () => {
    const run = (asks: Array<[number, number]>) => simulateSequentialMultiLeg({
      detectedAtMs: 1000,
      legs: [
        {
          id: 'yes', side: 'buy', shares: 10, latencyMs: 0,
          book: { bids: [], asks: [[0.42, 10]] },
          feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
        },
        {
          id: 'no', side: 'buy', shares: 10, latencyMs: 500,
          book: { bids: [], asks },
          feeContext: { feesEnabled: true, feeSchedule: { rate: 0 } },
        },
      ],
    });
    const zero = run([]);
    assert.equal(zero.matchedQuantity, 0);
    assert.equal(zero.unhedgedSize, 10);
    assert.equal(zero.complete, false);
    const partial = run([[0.60, 3]]);
    assert.equal(partial.matchedQuantity, 3);
    assert.equal(partial.unhedgedSize, 7);
    assert.equal(partial.complete, false);
  });

  it('fails closed for missing and stale latency snapshots', () => {
    const missing = selectDelayedBookSnapshot({ snapshots: [], detectedAtMs: 1000, latencyMs: 500 });
    assert.equal(missing.book, null);
    assert.equal(missing.source, 'missing_snapshot');
    const stale = selectDelayedBookSnapshot({
      snapshots: [{ timestamp: 2500, bids: [], asks: [[0.60, 10]] }],
      detectedAtMs: 1000,
      latencyMs: 500,
      maxGapMs: 100,
    });
    assert.equal(stale.book, null);
    assert.equal(stale.source, 'missing_snapshot');
  });
});
