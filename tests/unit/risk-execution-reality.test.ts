import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRiskModeler, summarizeExecutionReality } from '../../src/opportunity/risk.js';

describe('multi-leg observed execution reality', () => {
  it('summarizes matched quantity, imbalance, unhedged size, and second-leg timing', () => {
    const reality = summarizeExecutionReality([
      { legIndex: 0, requestedSize: 10, filledSize: 10, executedAtMs: 1000 },
      { legIndex: 1, requestedSize: 10, filledSize: 3, executedAtMs: 1500 },
    ]);
    assert.deepEqual(reality, {
      matchedQuantity: 3,
      legFillQuantities: [10, 3],
      legImbalance: 7,
      unhedgedSize: 7,
      secondLegDelayMs: 500,
    });
  });

  it('attaches observed fills to the existing risk output without replacing estimates', () => {
    const output = createRiskModeler().modelRisk({
      legs: [
        { platform: 'polymarket', marketId: 'm', outcomeId: 'yes', side: 'buy', price: 0.4, size: 10, liquidityAtPrice: 10 },
        { platform: 'polymarket', marketId: 'm', outcomeId: 'no', side: 'buy', price: 0.5, size: 10, liquidityAtPrice: 3 },
      ],
      positionSize: 9,
      expectedEdge: 10,
      sameEvent: true,
      actualExecutions: [
        { legIndex: 0, requestedSize: 10, filledSize: 10, executedAtMs: 1000 },
        { legIndex: 1, requestedSize: 10, filledSize: 3, executedAtMs: 1500 },
      ],
    });
    assert.equal(output.executionReality?.unhedgedSize, 7);
    assert.ok(output.fullExecutionProb < 1, 'estimated probability remains available');
  });
});
