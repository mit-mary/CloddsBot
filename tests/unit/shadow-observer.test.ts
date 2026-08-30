import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createShadowObserverServer,
  ShadowRunReader,
} from '../../src/gateway/shadow-observer.js';

const MARKET_ID = `0x${'a'.repeat(64)}`;
const YES_TOKEN = 'yes-token';
const NO_TOKEN = 'no-token';

function fixture(): { root: string; runDir: string; eventsPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'shadow-observer-'));
  const runDir = join(root, 'run');
  const eventsPath = join(runDir, 'events.jsonl');
  const manifest = {
    runId: 'run-1', commitSha: '5'.repeat(40), createdAt: new Date(Date.now() - 60_000).toISOString(),
    processStartTime: new Date(Date.now() - 60_000).toISOString(), stage: 'B', status: 'running',
    guards: { NO_PRIVATE_KEY: 'true', NO_WALLET: 'true', NO_LIVE_TRADING: 'true' },
    trustedPnlSources: ['opportunity-executable-economics', 'trusted-orderbook-tick-execution'],
    deniedCapabilities: ['wallet', 'live-trading'],
    config: { durationSeconds: 86_400, intervalMs: 2_000 }, lastSequence: 8, lastCompletedCycle: 1,
    stats: {
      cycles: 1, marketsSampled: 1, bookPairRequests: 1, bookPairResponses: 1,
      reliableBookPairs: 1, feeKnown: 1, feeDisabled: 0, feeUnknown: 0, errors: 0,
      deniedPnlRecords: 0, twoSidedBooks: 2, oneSidedBidOnlyBooks: 0,
      oneSidedAskOnlyBooks: 0, emptyBooks: 0, missingBookResponses: 0,
      invalidBookResponses: 0, requestFailedBooks: 0, transportStaleBooks: 0,
      hashInitial: 2, hashSame: 0, hashChanged: 0,
    },
    stopReasons: [], recoveredIncompleteEventRanges: [], processStarts: [], bookHashState: {},
  };
  const now = Date.now();
  const book = (sequence: number, tokenId: string, bid: number, ask: number) => ({
    sequence, eventType: 'book', marketId: MARKET_ID, tokenId, pairRequestId: 'pair-1',
    requestStartedAtMs: now - 100, receivedAtMs: now - 10, requestCompletedAtMs: now,
    exchangeBookTimestampMs: now - 3_000, transportAgeMs: 100, bookStateAgeMs: 3_000,
    bookHash: `hash-${tokenId}`, hashChange: 'INITIAL', timeSinceLastHashChangeMs: 0,
    rawBookRef: `raw-${tokenId}`, state: 'TWO_SIDED', topologyState: 'TWO_SIDED',
    schemaValid: true, transportFresh: true,
    normalizedBook: { bids: [[bid, 100]], asks: [[ask, 100]], timestamp: now - 3_000 },
  });
  const economics = (sequence: number, size: number, pnl: number) => ({
    sequence, eventType: 'opportunity_economics', namespace: 'trusted-shadow',
    source: 'opportunity-executable-economics', marketId: MARKET_ID,
    tokenIds: [YES_TOKEN, NO_TOKEN], sourceTimestampsMs: [now - 3_000, now - 3_000],
    localReceiveTimestampsMs: [now, now], rawBookRefs: ['raw-yes', 'raw-no'],
    feeMetadata: { feesEnabled: true }, feeStatus: 'KNOWN', strategy: 'complete-set-executable-economics',
    requestedSizeUsd: size, requestedShares: size, latencyMs: 0, matchedQuantity: size,
    unhedgedQuantity: 0, vwap: { yes: 0.49, no: 0.50 },
    actualSimulatedFill: {
      yes: { availableCapacity: 100, filledSize: size, complete: true },
      no: { availableCapacity: 100, filledSize: size, complete: true },
    },
    pnlAttribution: {
      theoreticalEdge: -0.01, depthImpact: 0, fees: 0.01,
      safetySlippage: 0.005, latencyDecay: 0, legRiskImpact: 0, trustedShadowPnl: pnl,
    },
    funnel: {
      validMarketData: true, requiredExecutableSidesAvailable: true,
      depthAvailable: true, feeKnown: true, executableCandidate: false,
    },
  });
  const events = [
    { sequence: 1, eventType: 'process_start', processStartTime: manifest.processStartTime, stage: 'B' },
    {
      sequence: 2, eventType: 'market_batch', requestCompletedAtMs: now,
      rawDiscoveryUniverseCount: 1, sampledCount: 1, sampledMarketIds: [MARKET_ID],
      rawMarkets: [{ conditionId: MARKET_ID, question: 'Will the Fed hold rates?', outcomes: '["Yes","No"]' }],
    },
    book(3, YES_TOKEN, 0.48, 0.49), book(4, NO_TOKEN, 0.49, 0.50),
    {
      sequence: 5, eventType: 'book_pair', marketId: MARKET_ID, tokenIds: [YES_TOKEN, NO_TOKEN],
      pairRequestId: 'pair-1', requestStartedAtMs: now - 100, receivedAtMs: now - 10,
      requestCompletedAtMs: now, rawBatchRef: 'batch-1', error: null,
      yes: { state: 'TWO_SIDED' }, no: { state: 'TWO_SIDED' },
    },
    economics(6, 10, -0.02), economics(7, 100, -0.3),
    {
      sequence: 8, eventType: 'strategy_rejected', marketId: MARKET_ID,
      pairRequestId: 'pair-1', reason: 'NO_POSITIVE_EXECUTABLE_EDGE', dataQualityEligible: true,
    },
  ];
  writeFileSync(join(root, 'placeholder'), '');
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(runDir);
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return { root, runDir, eventsPath };
}

describe('Shadow Observer V1', () => {
  it('reads manifest counters and recorded economics without alternate recomputation', () => {
    const f = fixture();
    try {
      const reader = new ShadowRunReader({ runDir: f.runDir });
      const snapshot = reader.snapshot() as any;
      assert.equal(snapshot.overview.status, 'ONLINE');
      assert.equal(snapshot.overview.commitSha, '5'.repeat(40));
      assert.equal(snapshot.overview.pairReliability, 1);
      assert.equal(snapshot.overview.feeUnknownRate, 0);
      assert.equal(snapshot.markets.length, 1);
      assert.equal(snapshot.markets[0].question, 'Will the Fed hold rates?');
      assert.equal(snapshot.markets[0].category, 'macro/economics');
      assert.equal(snapshot.markets[0].rawSum, 0.99);
      assert.equal(snapshot.markets[0].edge10Bps, -20);
      assert.equal(snapshot.markets[0].edge100Bps, -30);
      assert.equal(snapshot.nearMiss.buckets['-10 to -25 bps'], 1);
      assert.equal(snapshot.nearMiss.buckets['-25 to -50 bps'], 1);
      const detail = reader.marketDetail(MARKET_ID) as any;
      assert.equal(detail.sizeLadder[0].finalExecutablePnlUsd, -0.02);
      assert.equal(detail.sizeLadder[0].feeImpactUsd, 0.01);
      assert.match(detail.note, /does not infer maker fills/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('uses an incremental cursor after initial load and does not rewrite artifacts', () => {
    const f = fixture();
    try {
      const reader = new ShadowRunReader({ runDir: f.runDir });
      const beforeContent = readFileSync(f.eventsPath, 'utf8');
      reader.snapshot();
      const before = reader.diagnostics() as any;
      reader.snapshot();
      const unchanged = reader.diagnostics() as any;
      assert.equal(unchanged.bytesRead, before.bytesRead);
      assert.equal(readFileSync(f.eventsPath, 'utf8'), beforeContent);

      const appended = `${JSON.stringify({
        sequence: 9, eventType: 'book', marketId: MARKET_ID, tokenId: YES_TOKEN,
        requestStartedAtMs: Date.now() - 10, receivedAtMs: Date.now(), requestCompletedAtMs: Date.now(),
        exchangeBookTimestampMs: Date.now(), transportAgeMs: 10, bookStateAgeMs: 0,
        bookHash: 'changed', hashChange: 'CHANGED', timeSinceLastHashChangeMs: 0,
        state: 'TWO_SIDED', schemaValid: true, transportFresh: true,
        normalizedBook: { bids: [[0.48, 100]], asks: [[0.49, 100]] },
      })}\n`;
      appendFileSync(f.eventsPath, appended);
      reader.snapshot();
      const after = reader.diagnostics() as any;
      assert.equal(after.bytesRead - before.bytesRead, Buffer.byteLength(appended));
      assert.equal(after.lastWindowSequence, 9);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('serves only read-only observer routes and exposes no trading controls', async () => {
    const f = fixture();
    const server = createShadowObserverServer({ runDir: f.runDir, host: '127.0.0.1', port: 0 });
    try {
      const address = await server.start();
      const page = await fetch(address.url);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Shadow Observer/);
      assert.match(html, /PAPER ONLY/);
      assert.match(html, /NO WALLET/);
      assert.match(html, /NO LIVE TRADING/);
      assert.match(html, /Strongest recent non-positive observations/);
      assert.match(html, /Recent recorded observations/);
      assert.doesNotMatch(html, /<button|<form|place order|enable strategy|restart shadow/i);

      const snapshot = await fetch(`${address.url}/api/snapshot`);
      assert.equal(snapshot.status, 200);
      const body = await snapshot.json() as any;
      assert.equal(body.overview.runId, 'run-1');

      const detail = await fetch(`${address.url}/api/market/${MARKET_ID}`);
      assert.equal(detail.status, 200);

      const denied = await fetch(`${address.url}/api/snapshot`, { method: 'POST' });
      assert.equal(denied.status, 405);
      assert.deepEqual(await denied.json(), { error: 'READ_ONLY_OBSERVER' });
    } finally {
      await server.stop();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
