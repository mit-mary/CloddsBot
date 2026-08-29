import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSmartRouter } from '../../src/execution/smart-router.js';

function feeds(feeMetadata: Record<string, unknown>) {
  return {
    async getOrderbook() {
      return {
        platform: 'polymarket', marketId: 'token', outcomeId: 'token',
        bids: [[0.40, 100]], asks: [[0.42, 2], [0.43, 10], [0.47, 100]],
        spread: 0.02, midPrice: 0.41, timestamp: 1000,
      };
    },
    async getMarket() { return feeMetadata; },
  } as any;
}

describe('smart router executable quotes', () => {
  it('quotes full-depth VWAP, capacity, and dynamic fee', async () => {
    const router = createSmartRouter(feeds({
      feesEnabled: true,
      feeSchedule: { rate: 0.05, exponent: 1 },
    }), { enabledPlatforms: ['polymarket'], maxSlippage: 20, preferMaker: false });
    const result = await router.findBestRoute({ marketId: 'token', side: 'buy', size: 100 });
    assert.ok(Math.abs(result.bestRoute.price - 0.465) < 1e-12);
    assert.equal(result.bestRoute.availableSize, 100);
    assert.equal(result.bestRoute.fillStatus, 'full');
    assert.equal(result.bestRoute.estimatedFees, 1.24388);
  });

  it('blocks a taker route when fee metadata is unknown', async () => {
    const router = createSmartRouter(feeds({}), {
      enabledPlatforms: ['polymarket'], maxSlippage: 20, preferMaker: false,
    });
    const quotes = await router.getQuotes({ marketId: 'token', side: 'buy', size: 10 });
    assert.equal(quotes[0].feeStatus, 'FEE_UNKNOWN');
    assert.equal(quotes[0].estimatedFees, null);
    assert.equal(quotes[0].executable, false);
    await assert.rejects(
      router.findBestRoute({ marketId: 'token', side: 'buy', size: 10 }),
      /FEE_UNKNOWN/,
    );
  });

  it('does not fabricate fill capacity for a non-crossing maker limit', async () => {
    const router = createSmartRouter(feeds({ feesEnabled: false }), {
      enabledPlatforms: ['polymarket'], maxSlippage: 20, preferMaker: true,
    });
    const quotes = await router.getQuotes({ marketId: 'token', side: 'buy', size: 10, limitPrice: 0.40 });
    assert.equal(quotes[0].isMaker, true);
    assert.equal(quotes[0].availableSize, 0);
    assert.equal(quotes[0].executable, false);
  });
});
