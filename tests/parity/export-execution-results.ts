import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  quotePolymarketFee,
  selectDelayedBookSnapshot,
  simulateBookFill,
  simulateSequentialMultiLeg,
} from '../../src/execution/prediction-market-economics.js';

const fixturePath = resolve(process.argv[2] ?? '../../fixtures/execution_parity.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const output: Record<string, Record<string, unknown>> = {
  orderbook_cases: {},
  fee_cases: {},
  latency_cases: {},
  multi_leg_cases: {},
};

for (const testCase of fixture.orderbook_cases) {
  const fill = simulateBookFill({
    book: {
      bids: testCase.book.bids,
      asks: testCase.book.asks,
      timestamp: testCase.book.timestamp_ms,
    },
    side: testCase.side,
    shares: testCase.shares,
    safetySlippageBps: testCase.safety_slippage_bps,
  });
  output.orderbook_cases[testCase.id] = {
    filled_size: fill.filledSize,
    unfilled_size: fill.unfilledSize,
    spent_or_received: fill.spentOrReceived,
    vwap: fill.vwap,
    slippage: fill.slippage,
    complete: fill.complete,
    status: fill.status,
  };
}

for (const testCase of fixture.fee_cases) {
  const fee = quotePolymarketFee({
    shares: testCase.shares,
    price: testCase.price,
    liquidityRole: testCase.liquidity_role,
    feesEnabled: testCase.fees_enabled ?? undefined,
    feeSchedule: testCase.fee_schedule,
  });
  output.fee_cases[testCase.id] = { status: fee.status, fee: fee.fee, rate: fee.rate };
}

for (const testCase of fixture.latency_cases ?? []) {
  const selected = selectDelayedBookSnapshot({
    snapshots: testCase.snapshots.map((snapshot: any) => ({
      bids: snapshot.bids,
      asks: snapshot.asks,
      timestamp: snapshot.timestamp_ms,
    })),
    detectedAtMs: testCase.detected_at_ms,
    latencyMs: testCase.latency_ms,
    maxGapMs: testCase.max_gap_ms,
  });
  output.latency_cases[testCase.id] = {
    target_timestamp_ms: selected.targetTimestampMs,
    selected_timestamp_ms: selected.book?.timestamp ?? null,
    source: selected.source,
  };
}

for (const testCase of fixture.multi_leg_cases) {
  const result = simulateSequentialMultiLeg({
    detectedAtMs: testCase.detected_at_ms,
    legs: testCase.legs.map((leg: any) => ({
      id: leg.id,
      side: leg.side,
      shares: leg.shares,
      latencyMs: leg.latency_ms,
      book: { bids: leg.book.bids, asks: leg.book.asks, timestamp: leg.book.timestamp_ms },
      feeContext: {
        feesEnabled: (leg.fee_context ?? testCase.fee_context).fees_enabled ?? undefined,
        feeSchedule: (leg.fee_context ?? testCase.fee_context).fee_schedule,
      },
    })),
  });
  output.multi_leg_cases[testCase.id] = {
    matched_quantity: result.matchedQuantity,
    leg_imbalance: result.legImbalance,
    unhedged_size: result.unhedgedSize,
    second_leg_delay_ms: result.secondLegDelayMs,
    combined_cost: result.combinedCost,
    fees: result.fees,
    payout: result.payout,
    pnl: result.pnl,
    complete: result.complete,
    failure: result.failure ?? null,
  };
}

process.stdout.write(JSON.stringify(output));
