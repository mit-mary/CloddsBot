/**
 * Shadow Observer V2
 *
 * Read-only views over an existing trusted-shadow run. This module never writes
 * to the run directory and never imports wallet, execution, or strategy control
 * services. Cumulative counters come from manifest.json; live/detail views are
 * maintained from a bounded JSONL tail followed by incremental byte reads.
 */

import express, { type Express, type Request, type Response } from 'express';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { resolve, join } from 'node:path';
import { shadowObserverHtml } from './shadow-observer-ui.js';

type JsonRecord = Record<string, unknown>;

export interface ShadowObserverOptions {
  runDir: string;
  pathPrefix?: string;
  initialTailBytes?: number;
  maxSamples?: number;
  offlineAfterMs?: number;
}

interface Manifest {
  runId: string;
  commitSha: string;
  createdAt: string;
  processStartTime: string;
  stage: string;
  status: string;
  guards: Record<string, string>;
  trustedPnlSources: string[];
  deniedCapabilities: string[];
  config: JsonRecord;
  lastSequence: number;
  lastCompletedCycle: number;
  stats: JsonRecord;
  stopReasons: string[];
  recoveredIncompleteEventRanges?: unknown[];
  networkPreflight?: JsonRecord;
  processStarts?: JsonRecord[];
}

interface EdgeObservation {
  sequence: number;
  at: string | null;
  requestedSizeUsd: number;
  latencyMs: number;
  netEdgeBps: number;
  pnlUsd: number;
}

interface MarketViewState {
  marketId: string;
  metadata: JsonRecord | null;
  category: string;
  tokenIds: string[];
  books: Map<string, JsonRecord>;
  economics: Map<string, JsonRecord>;
  latestPairId: string | null;
  rejectionReason: string | null;
  latestUpdateMs: number | null;
  recent: Array<{ sequence: number; eventType: string; summary: string; at: string | null }>;
  edgeHistory: EdgeObservation[];
  hashActivity: Record<'INITIAL' | 'SAME' | 'CHANGED', number>;
  topologyChanges: number;
  lastTopologyByToken: Map<string, string>;
}

interface PairWindowState {
  pairRequestId: string;
  marketId: string;
  valid: boolean;
  executableBuySides: boolean;
  enoughDepth: boolean;
  feeCovered: boolean;
  theoreticalCandidate: boolean;
  positiveExecutableEdge: boolean;
  completeTrustedExecution: boolean;
}

interface NearMiss {
  sequence: number;
  marketId: string;
  question: string;
  requestedSizeUsd: number;
  latencyMs: number;
  netEdgeBps: number;
  pnlUsd: number;
  feeStatus: string;
  at: string | null;
}

const SIZE_LADDER = [10, 25, 50, 100, 250, 500, 1000] as const;

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function distribution(values: number[]): JsonRecord {
  return {
    n: values.length,
    p50: percentile(values, 0.50),
    p90: percentile(values, 0.90),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: percentile(values, 1),
  };
}

function histogram(values: number[], boundaries: number[], labels: string[]): JsonRecord {
  const counts = labels.map(() => 0);
  for (const value of values) {
    let index = boundaries.findIndex((boundary) => value < boundary);
    if (index < 0) index = labels.length - 1;
    counts[index] += 1;
  }
  return { labels, counts, total: values.length };
}

function eventTimeMs(event: JsonRecord): number | null {
  const candidates = [
    event.requestCompletedAtMs,
    event.receivedAtMs,
    ...array(event.localReceiveTimestampsMs),
    event.at,
    event.processStartTime,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function marketIdOf(metadata: JsonRecord): string {
  return string(metadata.conditionId ?? metadata.condition_id ?? metadata.id);
}

function marketQuestion(metadata: JsonRecord | null, marketId: string): string {
  return metadata ? string(metadata.question ?? metadata.title ?? metadata.slug, marketId) : marketId;
}

function conservativeCategory(metadata: JsonRecord): string {
  if (metadata.sportsMarketType || metadata.gameStartTime || array(metadata.events).some((item) => record(item).gameId)) {
    return 'sports';
  }
  const eventText = array(metadata.events)
    .flatMap((item) => {
      const event = record(item);
      return [event.title, event.slug, ...array(event.series).flatMap((series) => {
        const parsed = record(series);
        return [parsed.title, parsed.slug];
      })];
    })
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase();
  const text = `${string(metadata.question)} ${string(metadata.slug)} ${eventText}`.toLowerCase();
  if (/\b(bitcoin|ethereum|crypto|btc|eth|solana|xrp|dogecoin)\b/.test(text)) return 'crypto';
  if (/\b(fed|federal reserve|interest rate|inflation|gdp|recession|cpi|economy)\b/.test(text)) {
    return 'macro/economics';
  }
  if (/\b(election|president|presidential|congress|senate|parliament|prime minister|republican|democrat)\b/.test(text)) {
    return 'politics';
  }
  return 'other';
}

function bestLevel(bookEvent: JsonRecord | undefined, side: 'bids' | 'asks'): number | null {
  if (!bookEvent) return null;
  const levels = array(record(bookEvent.normalizedBook)[side]);
  const first = array(levels[0]);
  return first.length >= 2 ? nullableNumber(first[0]) : null;
}

function depthLevels(bookEvent: JsonRecord | undefined, side: 'bids' | 'asks'): unknown[] {
  if (!bookEvent) return [];
  return array(record(bookEvent.normalizedBook)[side]).slice(0, 20);
}

function netEdge(event: JsonRecord): { pnlUsd: number; bps: number } | null {
  const size = nullableNumber(event.requestedSizeUsd);
  const pnl = nullableNumber(record(event.pnlAttribution).trustedShadowPnl);
  if (size === null || size <= 0 || pnl === null) return null;
  return { pnlUsd: pnl, bps: pnl / size * 10_000 };
}

function impactBps(event: JsonRecord, key: string): number | null {
  const size = nullableNumber(event.requestedSizeUsd);
  const value = nullableNumber(record(event.pnlAttribution)[key]);
  return size !== null && size > 0 && value !== null ? value / size * 10_000 : null;
}

function eventSummary(event: JsonRecord): string {
  const type = string(event.eventType, 'unknown');
  if (type === 'network_preflight') return bool(event.success) ? 'Public data preflight passed' : 'Public data preflight failed';
  if (type === 'market_batch') return `${number(event.sampledCount)} markets sampled from ${number(event.rawDiscoveryUniverseCount)}`;
  if (type === 'book') return `${string(event.state)} · token ${string(event.tokenId).slice(0, 12)}…`;
  if (type === 'strategy_rejected') return string(event.reason, 'Strategy observation rejected');
  if (type === 'opportunity_economics') {
    const edge = netEdge(event);
    return edge ? `Recorded net edge ${edge.bps.toFixed(1)} bps at $${number(event.requestedSizeUsd)}` : 'Recorded executable economics';
  }
  if (type === 'process_stop') return `Run ${string(event.status, 'stopped')}`;
  return type.replaceAll('_', ' ');
}

function importantEvent(event: JsonRecord): boolean {
  const type = string(event.eventType);
  if (['process_start', 'network_preflight', 'process_stop', 'provenance_rejection'].includes(type)) return true;
  if (type === 'market_batch') return true;
  if (type === 'book') return ['MISSING_BOOK', 'INVALID_RESPONSE', 'REQUEST_FAILED', 'TRANSPORT_STALE'].includes(string(event.state));
  if (type === 'opportunity_economics') {
    const edge = netEdge(event);
    return string(event.feeStatus) === 'FEE_UNKNOWN' || (edge !== null && edge.bps > 0);
  }
  return type === 'trusted_pnl' || type === 'denied_pnl';
}

export class ShadowRunReader {
  readonly runDir: string;
  readonly manifestPath: string;
  readonly eventsPath: string;
  private readonly initialTailBytes: number;
  private readonly maxSamples: number;
  private readonly offlineAfterMs: number;
  private initialized = false;
  private offset = 0;
  private carry = '';
  private bytesRead = 0;
  private integrityError: string | null = null;
  private firstWindowSequence: number | null = null;
  private lastWindowSequence: number | null = null;
  private lastEventTimeMs: number | null = null;
  private markets = new Map<string, MarketViewState>();
  private metadata = new Map<string, JsonRecord>();
  private latestSampledMarketIds = new Set<string>();
  private pairs = new Map<string, PairWindowState>();
  private latestPairByMarket = new Map<string, string>();
  private transportAges: number[] = [];
  private bookStateAges: number[] = [];
  private hashChangeAges: number[] = [];
  private nearMisses: NearMiss[] = [];
  private importantEvents: Array<JsonRecord> = [];

  constructor(options: ShadowObserverOptions) {
    this.runDir = resolve(options.runDir);
    this.manifestPath = join(this.runDir, 'manifest.json');
    this.eventsPath = join(this.runDir, 'events.jsonl');
    this.initialTailBytes = Math.max(64 * 1024, options.initialTailBytes ?? 16 * 1024 * 1024);
    this.maxSamples = Math.max(1_000, options.maxSamples ?? 50_000);
    this.offlineAfterMs = Math.max(10_000, options.offlineAfterMs ?? 120_000);
    if (!existsSync(this.manifestPath) || !existsSync(this.eventsPath)) {
      throw new Error('Shadow Observer requires existing manifest.json and events.jsonl');
    }
  }

  diagnostics(): JsonRecord {
    return {
      offset: this.offset,
      bytesRead: this.bytesRead,
      initialTailBytes: this.initialTailBytes,
      integrityError: this.integrityError,
      firstWindowSequence: this.firstWindowSequence,
      lastWindowSequence: this.lastWindowSequence,
    };
  }

  private market(marketId: string): MarketViewState {
    let value = this.markets.get(marketId);
    if (!value) {
      const metadata = this.metadata.get(marketId) ?? null;
      value = {
        marketId,
        metadata,
        category: metadata ? conservativeCategory(metadata) : 'other',
        tokenIds: [],
        books: new Map(),
        economics: new Map(),
        latestPairId: null,
        rejectionReason: null,
        latestUpdateMs: null,
        recent: [],
        edgeHistory: [],
        hashActivity: { INITIAL: 0, SAME: 0, CHANGED: 0 },
        topologyChanges: 0,
        lastTopologyByToken: new Map(),
      };
      this.markets.set(marketId, value);
    }
    return value;
  }

  private cap(values: number[]): void {
    if (values.length > this.maxSamples) values.splice(0, values.length - this.maxSamples);
  }

  private addRecent(market: MarketViewState, event: JsonRecord): void {
    const time = eventTimeMs(event);
    market.latestUpdateMs = Math.max(market.latestUpdateMs ?? 0, time ?? 0) || market.latestUpdateMs;
    market.recent.push({
      sequence: number(event.sequence),
      eventType: string(event.eventType),
      summary: eventSummary(event),
      at: iso(time),
    });
    if (market.recent.length > 40) market.recent.splice(0, market.recent.length - 40);
  }

  private apply(event: JsonRecord): void {
    const sequence = nullableNumber(event.sequence);
    if (sequence !== null) {
      this.firstWindowSequence ??= sequence;
      this.lastWindowSequence = sequence;
    }
    const time = eventTimeMs(event);
    if (time !== null) this.lastEventTimeMs = Math.max(this.lastEventTimeMs ?? 0, time);
    const type = string(event.eventType);

    if (type === 'market_batch') {
      const sampledMarketIds = array(event.sampledMarketIds).map((item) => string(item)).filter(Boolean);
      if (sampledMarketIds.length > 0) this.latestSampledMarketIds = new Set(sampledMarketIds);
      for (const item of array(event.rawMarkets)) {
        const parsed = record(item);
        const id = marketIdOf(parsed);
        if (!id) continue;
        this.metadata.set(id, parsed);
        const market = this.markets.get(id);
        if (market) {
          market.metadata = parsed;
          market.category = conservativeCategory(parsed);
        }
      }
    }

    const marketId = string(event.marketId);
    if (marketId) {
      const market = this.market(marketId);
      if (type === 'book') {
        const tokenId = string(event.tokenId);
        const topology = string(event.topologyState ?? event.state, 'UNKNOWN');
        const previousTopology = market.lastTopologyByToken.get(tokenId);
        if (previousTopology && previousTopology !== topology) market.topologyChanges += 1;
        if (tokenId) market.lastTopologyByToken.set(tokenId, topology);
        const hashChange = string(event.hashChange);
        if (hashChange === 'INITIAL' || hashChange === 'SAME' || hashChange === 'CHANGED') {
          market.hashActivity[hashChange] += 1;
        }
        if (tokenId) market.books.set(tokenId, event);
        const transportAge = nullableNumber(event.transportAgeMs);
        const stateAge = nullableNumber(event.bookStateAgeMs);
        const hashAge = nullableNumber(event.timeSinceLastHashChangeMs);
        if (transportAge !== null) this.transportAges.push(transportAge);
        if (stateAge !== null) this.bookStateAges.push(stateAge);
        if (hashAge !== null) this.hashChangeAges.push(hashAge);
        this.cap(this.transportAges);
        this.cap(this.bookStateAges);
        this.cap(this.hashChangeAges);
        this.addRecent(market, event);
      } else if (type === 'book_pair') {
        market.tokenIds = array(event.tokenIds).map((item) => string(item)).filter(Boolean);
        market.latestPairId = string(event.pairRequestId) || null;
        const yes = record(event.yes);
        const no = record(event.no);
        const invalidStates = new Set(['MISSING_BOOK', 'INVALID_RESPONSE', 'REQUEST_FAILED', 'TRANSPORT_STALE']);
        const valid = !event.error && !invalidStates.has(string(yes.state)) && !invalidStates.has(string(no.state));
        if (market.latestPairId) {
          this.pairs.set(market.latestPairId, {
            pairRequestId: market.latestPairId,
            marketId,
            valid,
            executableBuySides: false,
            enoughDepth: false,
            feeCovered: false,
            theoreticalCandidate: false,
            positiveExecutableEdge: false,
            completeTrustedExecution: false,
          });
          this.latestPairByMarket.set(marketId, market.latestPairId);
        }
        this.addRecent(market, event);
      } else if (type === 'strategy_rejected') {
        market.rejectionReason = string(event.reason) || null;
        this.addRecent(market, event);
      } else if (type === 'opportunity_economics') {
        const key = `${number(event.requestedSizeUsd)}:${number(event.latencyMs)}`;
        market.economics.set(key, event);
        const pair = this.pairs.get(this.latestPairByMarket.get(marketId) ?? '');
        if (pair) {
          const funnel = record(event.funnel);
          pair.executableBuySides ||= bool(funnel.requiredExecutableSidesAvailable);
          pair.enoughDepth ||= bool(funnel.depthAvailable);
          pair.feeCovered ||= bool(funnel.feeKnown);
          pair.theoreticalCandidate ||= number(record(event.pnlAttribution).theoreticalEdge) > 0;
          const edge = netEdge(event);
          pair.positiveExecutableEdge ||= edge !== null && edge.bps > 0;
        }
        const edge = netEdge(event);
        if (edge) {
          const observation: EdgeObservation = {
            sequence: number(event.sequence),
            at: iso(time),
            requestedSizeUsd: number(event.requestedSizeUsd),
            latencyMs: number(event.latencyMs),
            netEdgeBps: edge.bps,
            pnlUsd: edge.pnlUsd,
          };
          market.edgeHistory.push(observation);
          if (market.edgeHistory.length > 1_024) market.edgeHistory.splice(0, market.edgeHistory.length - 1_024);
          this.nearMisses.push({
            sequence: observation.sequence,
            marketId,
            question: marketQuestion(market.metadata, marketId),
            requestedSizeUsd: observation.requestedSizeUsd,
            latencyMs: observation.latencyMs,
            netEdgeBps: observation.netEdgeBps,
            pnlUsd: observation.pnlUsd,
            feeStatus: string(event.feeStatus),
            at: observation.at,
          });
          if (this.nearMisses.length > this.maxSamples) {
            this.nearMisses.splice(0, this.nearMisses.length - this.maxSamples);
          }
        }
        this.addRecent(market, event);
      } else if (type === 'trusted_pnl') {
        const pair = this.pairs.get(this.latestPairByMarket.get(marketId) ?? '');
        if (pair) pair.completeTrustedExecution = true;
        this.addRecent(market, event);
      }
    }

    if (importantEvent(event)) {
      this.importantEvents.push({
        sequence: number(event.sequence),
        eventType: type,
        marketId: marketId || null,
        summary: eventSummary(event),
        at: iso(time),
      });
      if (this.importantEvents.length > 100) this.importantEvents.splice(0, this.importantEvents.length - 100);
    }
  }

  refresh(): void {
    const stats = statSync(this.eventsPath);
    if (stats.size < this.offset) {
      this.integrityError = `EVENT_FILE_TRUNCATED: expected at least ${this.offset} bytes, found ${stats.size}`;
      return;
    }
    let start = this.offset;
    let discardLeadingPartial = false;
    if (!this.initialized) {
      start = Math.max(0, stats.size - this.initialTailBytes);
      discardLeadingPartial = start > 0;
      this.offset = start;
      this.initialized = true;
    }
    const length = stats.size - start;
    if (length <= 0) return;
    const fd = openSync(this.eventsPath, 'r');
    const chunks: Buffer[] = [];
    let position = start;
    try {
      while (position < stats.size) {
        const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, stats.size - position));
        const read = readSync(fd, chunk, 0, chunk.length, position);
        if (read <= 0) break;
        chunks.push(chunk.subarray(0, read));
        position += read;
      }
    } finally {
      closeSync(fd);
    }
    this.bytesRead += position - start;
    this.offset = position;
    let text = this.carry + Buffer.concat(chunks).toString('utf8');
    this.carry = '';
    if (discardLeadingPartial) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const trailingNewline = text.endsWith('\n');
    const lines = text.split(/\r?\n/);
    if (!trailingNewline) this.carry = lines.pop() ?? '';
    else lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.apply(JSON.parse(line) as JsonRecord);
      } catch {
        this.integrityError ??= 'INVALID_JSONL_EVENT_IN_OBSERVER_WINDOW';
      }
    }
  }

  private readManifest(): Manifest {
    return JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Manifest;
  }

  private marketSummary(market: MarketViewState): JsonRecord {
    const [yesToken, noToken] = market.tokenIds;
    const yes = yesToken ? market.books.get(yesToken) : undefined;
    const no = noToken ? market.books.get(noToken) : undefined;
    const yesAsk = bestLevel(yes, 'asks');
    const noAsk = bestLevel(no, 'asks');
    const econ10 = market.economics.get('10:0');
    const econ100 = market.economics.get('100:0');
    const econ500 = market.economics.get('500:0');
    const fill10 = econ10 ? record(econ10.actualSimulatedFill) : {};
    const yesFill = record(fill10.yes);
    const noFill = record(fill10.no);
    const yesState = string(yes?.state, 'UNKNOWN');
    const noState = string(no?.state, 'UNKNOWN');
    const currentEdges = SIZE_LADDER.map((size) => {
      const event = market.economics.get(`${size}:0`);
      return event ? netEdge(event)?.bps ?? null : null;
    }).filter((value): value is number => value !== null);
    return {
      marketId: market.marketId,
      question: marketQuestion(market.metadata, market.marketId),
      category: market.category,
      topology: yesState === noState ? yesState : `YES ${yesState} / NO ${noState}`,
      yesBestAsk: yesAsk,
      noBestAsk: noAsk,
      rawSum: yesAsk !== null && noAsk !== null ? yesAsk + noAsk : null,
      edge10Bps: econ10 ? netEdge(econ10)?.bps ?? null : null,
      edge100Bps: econ100 ? netEdge(econ100)?.bps ?? null : null,
      edge500Bps: econ500 ? netEdge(econ500)?.bps ?? null : null,
      bestEdgeBps: currentEdges.length > 0 ? Math.max(...currentEdges) : null,
      availableDepthShares: Math.min(
        nullableNumber(yesFill.availableCapacity) ?? Number.POSITIVE_INFINITY,
        nullableNumber(noFill.availableCapacity) ?? Number.POSITIVE_INFINITY,
      ) || null,
      feeStatus: string(econ10?.feeStatus ?? econ100?.feeStatus, 'N/A'),
      bookStateAgeMs: Math.max(nullableNumber(yes?.bookStateAgeMs) ?? 0, nullableNumber(no?.bookStateAgeMs) ?? 0) || null,
      lastHashChangeMs: Math.max(nullableNumber(yes?.timeSinceLastHashChangeMs) ?? 0, nullableNumber(no?.timeSinceLastHashChangeMs) ?? 0) || 0,
      latestUpdate: iso(market.latestUpdateMs),
      rejectionReason: market.rejectionReason,
      edgeTrend: market.edgeHistory
        .filter((item) => item.requestedSizeUsd === 100 && item.latencyMs === 0)
        .slice(-24)
        .map((item) => ({ at: item.at, bps: item.netEdgeBps })),
    };
  }

  private analytics(markets: JsonRecord[]): JsonRecord {
    const reference = this.nearMisses.filter((item) => item.requestedSizeUsd === 100 && item.latencyMs === 0);
    const byMinute = new Map<number, number[]>();
    for (const item of reference) {
      if (!item.at) continue;
      const timestamp = Date.parse(item.at);
      if (!Number.isFinite(timestamp)) continue;
      const bucket = Math.floor(timestamp / 60_000) * 60_000;
      const values = byMinute.get(bucket) ?? [];
      values.push(item.netEdgeBps);
      byMinute.set(bucket, values);
    }
    const edgeTimeSeries = [...byMinute.entries()].sort((a, b) => a[0] - b[0]).map(([at, values]) => ({
      at: new Date(at).toISOString(),
      count: values.length,
      bestBps: percentile(values, 1),
      medianBps: percentile(values, 0.5),
      p25Bps: percentile(values, 0.25),
      p75Bps: percentile(values, 0.75),
    }));
    const edgeValues = reference.map((item) => item.netEdgeBps);
    const edgeHistogram = histogram(
      edgeValues,
      [-500, -250, -100, -50, -25, -10, 0, 10, 25, 50, 100],
      ['< -500', '-500 to -250', '-250 to -100', '-100 to -50', '-50 to -25', '-25 to -10', '-10 to 0', '0 to 10', '10 to 25', '25 to 50', '50 to 100', '> 100'],
    );
    const sizeProfile = SIZE_LADDER.map((size) => {
      const values = this.nearMisses
        .filter((item) => item.requestedSizeUsd === size && item.latencyMs === 0)
        .map((item) => item.netEdgeBps);
      return { size, count: values.length, bestBps: percentile(values, 1), medianBps: percentile(values, 0.5) };
    });
    const categories = new Map<string, number[]>();
    for (const item of reference) {
      const category = this.markets.get(item.marketId)?.category ?? 'other';
      const values = categories.get(category) ?? [];
      values.push(item.netEdgeBps);
      categories.set(category, values);
    }
    const categoryComparison = [...categories.entries()].map(([category, values]) => ({
      category,
      count: values.length,
      bestBps: percentile(values, 1),
      medianBps: percentile(values, 0.5),
    })).sort((a, b) => number(b.bestBps, Number.NEGATIVE_INFINITY) - number(a.bestBps, Number.NEGATIVE_INFINITY));
    const topologyCounts = new Map<string, number>();
    for (const market of markets) {
      const topology = string(market.topology, 'UNKNOWN');
      topologyCounts.set(topology, (topologyCounts.get(topology) ?? 0) + 1);
    }
    const latencySurvival = [0, 100, 250, 500, 1_000, 2_000, 3_000, 5_000].map((latencyMs) => {
      const values = this.nearMisses
        .filter((item) => item.requestedSizeUsd === 100 && item.latencyMs === latencyMs)
        .map((item) => item.netEdgeBps);
      return {
        latencyMs,
        count: values.length,
        positive: values.filter((value) => value > 0).length,
        bestBps: percentile(values, 1),
        medianBps: percentile(values, 0.5),
      };
    }).filter((item) => item.count > 0);
    return {
      reference: '$100 recorded executable economics at 0ms',
      window: {
        firstAt: reference.find((item) => item.at)?.at ?? null,
        lastAt: [...reference].reverse().find((item) => item.at)?.at ?? null,
        observations: reference.length,
      },
      edgeTimeSeries,
      edgeHistogram,
      sizeProfile,
      categoryComparison,
      topologyDistribution: [...topologyCounts.entries()].map(([topology, count]) => ({ topology, count })),
      bookStateAgeHistogram: histogram(
        this.bookStateAges,
        [1_000, 5_000, 15_000, 60_000, 300_000],
        ['< 1s', '1–5s', '5–15s', '15–60s', '1–5m', '> 5m'],
      ),
      hashChangeAgeHistogram: histogram(
        this.hashChangeAges,
        [1_000, 5_000, 15_000, 60_000, 300_000],
        ['< 1s', '1–5s', '5–15s', '15–60s', '1–5m', '> 5m'],
      ),
      latencySurvival,
    };
  }

  private funnel(): JsonRecord {
    const pairs = [...this.pairs.values()];
    const steps: Array<[string, number]> = [
      ['Paired observations', pairs.length],
      ['Valid paired data', pairs.filter((item) => item.valid).length],
      ['Executable buy sides', pairs.filter((item) => item.executableBuySides).length],
      ['Enough depth', pairs.filter((item) => item.enoughDepth).length],
      ['Fee covered', pairs.filter((item) => item.feeCovered).length],
      ['Theoretical spread candidate', pairs.filter((item) => item.theoreticalCandidate).length],
      ['Positive executable edge', pairs.filter((item) => item.positiveExecutableEdge).length],
      ['Complete trusted execution', pairs.filter((item) => item.completeTrustedExecution).length],
    ];
    return {
      scope: 'recent incremental observer window',
      steps: steps.map(([label, count], index) => ({
        label,
        count,
        conversion: index === 0 ? 1 : rate(count, steps[index - 1][1]),
        fromPaired: rate(count, steps[0][1]),
      })),
    };
  }

  private nearMissDistribution(): JsonRecord {
    const buckets: Record<string, number> = {
      positive: 0,
      '0 to -10 bps': 0,
      '-10 to -25 bps': 0,
      '-25 to -50 bps': 0,
      '-50 to -100 bps': 0,
      'below -100 bps': 0,
    };
    for (const item of this.nearMisses) {
      if (item.netEdgeBps > 0) buckets.positive += 1;
      else if (item.netEdgeBps >= -10) buckets['0 to -10 bps'] += 1;
      else if (item.netEdgeBps >= -25) buckets['-10 to -25 bps'] += 1;
      else if (item.netEdgeBps >= -50) buckets['-25 to -50 bps'] += 1;
      else if (item.netEdgeBps >= -100) buckets['-50 to -100 bps'] += 1;
      else buckets['below -100 bps'] += 1;
    }
    return {
      scope: 'recorded opportunity_economics events in observer window',
      count: this.nearMisses.length,
      buckets,
      strongestRecent: this.nearMisses
        .filter((item) => item.netEdgeBps <= 0)
        .sort((a, b) => b.netEdgeBps - a.netEdgeBps || b.sequence - a.sequence)
        .slice(0, 12),
    };
  }

  private recentImportantEvents(): JsonRecord[] {
    const result: JsonRecord[] = [];
    let marketBatches = 0;
    for (const event of [...this.importantEvents].reverse()) {
      if (event.eventType === 'market_batch') {
        marketBatches += 1;
        if (marketBatches > 5) continue;
      }
      result.push(event);
      if (result.length >= 40) break;
    }
    return result;
  }

  snapshot(): JsonRecord {
    this.refresh();
    const manifest = this.readManifest();
    const stats = record(manifest.stats);
    const fileMtime = statSync(this.eventsPath).mtimeMs;
    const lastActivity = Math.max(this.lastEventTimeMs ?? 0, fileMtime);
    const blocked = manifest.status === 'blocked' || manifest.stopReasons.length > 0 || this.integrityError !== null;
    const online = manifest.status === 'running' && Date.now() - lastActivity <= this.offlineAfterMs;
    const status = blocked ? 'BLOCKED' : online ? 'ONLINE' : 'STOPPED';
    const feeTotal = number(stats.feeKnown) + number(stats.feeDisabled) + number(stats.feeUnknown);
    const pairRequests = number(stats.bookPairRequests);
    const createdAtMs = Date.parse(manifest.createdAt);
    const targetDurationSeconds = number(manifest.config.durationSeconds);
    const marketList = [...this.markets.values()]
      .filter((item) => item.tokenIds.length === 2
        && (this.latestSampledMarketIds.size === 0 || this.latestSampledMarketIds.has(item.marketId)))
      .map((item) => this.marketSummary(item));
    return {
      generatedAt: new Date().toISOString(),
      scope: {
        runDir: this.runDir,
        firstSequence: this.firstWindowSequence,
        lastSequence: this.lastWindowSequence,
        cumulativeCounters: 'manifest.json',
        liveViews: 'bounded JSONL tail plus incremental reads',
      },
      overview: {
        status,
        stage: manifest.stage,
        runId: manifest.runId,
        commitSha: manifest.commitSha,
        uptimeSeconds: Math.max(0, (Date.now() - createdAtMs) / 1000),
        targetDurationSeconds,
        cycles: number(stats.cycles),
        marketsSampled: number(stats.marketsSampled),
        currentSampledMarkets: marketList.length,
        pairedRequests: pairRequests,
        pairReliability: rate(number(stats.reliableBookPairs), pairRequests),
        feeUnknownRate: rate(number(stats.feeUnknown), feeTotal),
        errors: number(stats.errors),
        deniedPnl: number(stats.deniedPnlRecords),
        lastEventTime: iso(lastActivity),
        guards: manifest.guards,
        stopReasons: manifest.stopReasons,
        integrityError: this.integrityError,
      },
      funnel: this.funnel(),
      nearMiss: this.nearMissDistribution(),
      markets: marketList,
      analytics: this.analytics(marketList),
      dataQuality: {
        cumulative: {
          TWO_SIDED: number(stats.twoSidedBooks),
          BID_ONLY: number(stats.oneSidedBidOnlyBooks),
          ASK_ONLY: number(stats.oneSidedAskOnlyBooks),
          EMPTY: number(stats.emptyBooks),
          MISSING: number(stats.missingBookResponses),
          INVALID: number(stats.invalidBookResponses),
          REQUEST_FAILED: number(stats.requestFailedBooks),
          TRANSPORT_STALE: number(stats.transportStaleBooks),
          pairReliability: rate(number(stats.reliableBookPairs), pairRequests),
          feeKnown: number(stats.feeKnown),
          feeDisabled: number(stats.feeDisabled),
          feeUnknown: number(stats.feeUnknown),
          hashInitial: number(stats.hashInitial),
          hashSame: number(stats.hashSame),
          hashChanged: number(stats.hashChanged),
          recoveredSequenceRanges: manifest.recoveredIncompleteEventRanges?.length ?? 0,
        },
        observerWindow: {
          transportAgeMs: distribution(this.transportAges),
          bookStateAgeMs: distribution(this.bookStateAges),
          timeSinceHashChangeMs: distribution(this.hashChangeAges),
        },
      },
      events: this.recentImportantEvents(),
      system: {
        run: {
          runId: manifest.runId,
          commitSha: manifest.commitSha,
          branch: string(manifest.config.branch) || null,
          stage: manifest.stage,
          createdAt: manifest.createdAt,
          processStartTime: manifest.processStartTime,
          status: manifest.status,
          recorderSequence: manifest.lastSequence,
          completedCycle: manifest.lastCompletedCycle,
        },
        networkPreflight: manifest.networkPreflight ?? null,
        safety: {
          guards: manifest.guards,
          trustedPnlSources: manifest.trustedPnlSources,
          deniedCapabilities: manifest.deniedCapabilities,
          trustedPnlRecords: number(stats.trustedPnlRecords),
          deniedPnlRecords: number(stats.deniedPnlRecords),
        },
      },
      diagnostics: this.diagnostics(),
    };
  }

  marketDetail(marketId: string): JsonRecord | null {
    this.refresh();
    const market = this.markets.get(marketId);
    if (!market) return null;
    const [yesToken, noToken] = market.tokenIds;
    const yes = yesToken ? market.books.get(yesToken) : undefined;
    const no = noToken ? market.books.get(noToken) : undefined;
    const ladder = SIZE_LADDER.map((size) => {
      const event = market.economics.get(`${size}:0`);
      if (!event) return { requestedSizeUsd: size, available: false };
      const edge = netEdge(event);
      const pnl = record(event.pnlAttribution);
      const fill = record(event.actualSimulatedFill);
      return {
        requestedSizeUsd: size,
        available: true,
        feeStatus: string(event.feeStatus),
        complete: bool(record(event.funnel).depthAvailable),
        matchedQuantity: nullableNumber(event.matchedQuantity),
        unhedgedQuantity: nullableNumber(event.unhedgedQuantity),
        rawTheoreticalSpreadUsd: nullableNumber(pnl.theoreticalEdge),
        rawTheoreticalSpreadBps: impactBps(event, 'theoreticalEdge'),
        depthImpactUsd: nullableNumber(pnl.depthImpact),
        depthImpactBps: impactBps(event, 'depthImpact'),
        feeImpactUsd: nullableNumber(pnl.fees),
        feeImpactBps: impactBps(event, 'fees'),
        safetySlippageUsd: nullableNumber(pnl.safetySlippage),
        safetySlippageBps: impactBps(event, 'safetySlippage'),
        latencyImpactUsd: nullableNumber(pnl.latencyDecay),
        legRiskImpactUsd: nullableNumber(pnl.legRiskImpact),
        finalExecutablePnlUsd: edge?.pnlUsd ?? null,
        finalExecutableEdgeBps: edge?.bps ?? null,
        vwap: event.vwap,
        actualSimulatedFill: {
          yes: record(fill.yes),
          no: record(fill.no),
        },
      };
    });
    const metadata = market.metadata ?? {};
    return {
      summary: this.marketSummary(market),
      metadata: {
        conditionId: marketId,
        question: marketQuestion(market.metadata, marketId),
        slug: metadata.slug ?? null,
        category: market.category,
        endDate: metadata.endDate ?? null,
        active: metadata.active ?? null,
        closed: metadata.closed ?? null,
        acceptingOrders: metadata.acceptingOrders ?? null,
        liquidity: metadata.liquidity ?? null,
        volume24hr: metadata.volume24hr ?? null,
        sportsMarketType: metadata.sportsMarketType ?? null,
      },
      books: {
        yes: {
          tokenId: yesToken ?? null,
          state: yes?.state ?? null,
          bestBid: bestLevel(yes, 'bids'),
          bestAsk: bestLevel(yes, 'asks'),
          bids: depthLevels(yes, 'bids'),
          asks: depthLevels(yes, 'asks'),
          exchangeTimestampMs: yes?.exchangeBookTimestampMs ?? null,
          receivedAtMs: yes?.receivedAtMs ?? null,
          hash: yes?.bookHash ?? null,
          hashChange: yes?.hashChange ?? null,
          transportAgeMs: yes?.transportAgeMs ?? null,
          bookStateAgeMs: yes?.bookStateAgeMs ?? null,
          timeSinceLastHashChangeMs: yes?.timeSinceLastHashChangeMs ?? null,
        },
        no: {
          tokenId: noToken ?? null,
          state: no?.state ?? null,
          bestBid: bestLevel(no, 'bids'),
          bestAsk: bestLevel(no, 'asks'),
          bids: depthLevels(no, 'bids'),
          asks: depthLevels(no, 'asks'),
          exchangeTimestampMs: no?.exchangeBookTimestampMs ?? null,
          receivedAtMs: no?.receivedAtMs ?? null,
          hash: no?.bookHash ?? null,
          hashChange: no?.hashChange ?? null,
          transportAgeMs: no?.transportAgeMs ?? null,
          bookStateAgeMs: no?.bookStateAgeMs ?? null,
          timeSinceLastHashChangeMs: no?.timeSinceLastHashChangeMs ?? null,
        },
      },
      sizeLadder: ladder,
      edgeTimeline: market.edgeHistory
        .filter((item) => item.requestedSizeUsd === 100 && item.latencyMs === 0)
        .slice(-180),
      activity: {
        topologyChanges: market.topologyChanges,
        hashActivity: market.hashActivity,
      },
      recentObservations: [...market.recent].reverse(),
      note: 'All economics and fills are recorder outputs. The observer does not infer maker fills or recompute execution.',
    };
  }
}

function observerHtml(prefix: string): string {
  const api = `${prefix}/api/snapshot`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shadow Observer</title>
<style>
:root{--bg:#080d14;--panel:#101923;--line:#243242;--muted:#8291a5;--text:#edf3f8;--cyan:#5ce1e6;--green:#5ee3a1;--amber:#f6c768;--red:#ff7185;--blue:#78a9ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#173247 0,transparent 34%),var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.shell{max-width:1540px;margin:auto;padding:24px}.top{display:flex;gap:18px;align-items:flex-start;justify-content:space-between;margin-bottom:18px}.eyebrow{color:var(--cyan);font-size:11px;letter-spacing:.18em;text-transform:uppercase}.title{font-size:30px;letter-spacing:-.03em;margin:3px 0}.subtitle,.muted{color:var(--muted)}.badges{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.badge{border:1px solid #2e5d59;background:#102823;color:var(--green);border-radius:999px;padding:7px 11px;font-size:11px;font-weight:750;letter-spacing:.06em}.badge.status{font-size:12px}.badge.blocked{color:var(--red);border-color:#6d3340;background:#2a151b}.badge.stopped{color:var(--amber);border-color:#68532a;background:#292313}.grid{display:grid;gap:14px}.metrics{grid-template-columns:repeat(8,minmax(110px,1fr));margin-bottom:14px}.card{background:linear-gradient(180deg,rgba(19,30,42,.96),rgba(13,22,31,.96));border:1px solid var(--line);border-radius:14px;padding:15px;box-shadow:0 12px 40px rgba(0,0,0,.16)}.metric .k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.1em}.metric .v{font-size:21px;font-variant-numeric:tabular-nums;margin-top:5px}.section-title{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 12px}.section-title h2{font-size:14px;margin:0;letter-spacing:.02em}.section-title span{color:var(--muted);font-size:11px}.two{grid-template-columns:1.25fr .75fr;margin-bottom:14px}.funnel{display:grid;grid-template-columns:repeat(8,1fr);gap:7px}.step{min-width:0;border-top:3px solid var(--blue);background:#0c151f;border-radius:7px;padding:10px}.step .n{font-size:20px;font-variant-numeric:tabular-nums}.step .l{height:33px;color:var(--muted);font-size:10px}.step .p{font-size:10px;color:var(--cyan)}.buckets{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.bucket{background:#0c151f;border-radius:8px;padding:9px}.bucket b{display:block;font-size:18px}.bucket span{color:var(--muted);font-size:10px}.near-list{margin-top:10px}.near-row{display:grid;grid-template-columns:1fr 90px 76px;gap:8px;padding:6px 0;border-top:1px solid #1d2936;font-size:10px}.quality{grid-template-columns:repeat(8,1fr);gap:7px}.quality .bucket{text-align:center}.toolbar{display:flex;gap:9px;margin-bottom:10px}.input{background:#09121b;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 10px;min-width:210px}select.input{min-width:130px}table{width:100%;border-collapse:collapse;font-size:12px}th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em;text-align:left;padding:9px;border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap}td{padding:9px;border-bottom:1px solid #1d2936;font-variant-numeric:tabular-nums}tr.market{cursor:pointer}tr.market:hover{background:#142230}.question{max-width:300px}.pos{color:var(--green)}.neg{color:var(--red)}.warn{color:var(--amber)}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.scroll{overflow:auto}.bottom{grid-template-columns:1fr 1fr;margin-top:14px}.event{display:grid;grid-template-columns:70px 150px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid #1d2936;font-size:11px}.event:last-child{border:0}.detail{display:none;margin-top:14px}.detail.open{display:block}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.depth{display:grid;grid-template-columns:1fr 1fr;gap:8px}.levels{max-height:240px;overflow:auto;background:#09121b;border-radius:8px;padding:8px}.levels div{display:flex;justify-content:space-between;font:11px ui-monospace,monospace;padding:2px}.recent-list{max-height:220px;overflow:auto;margin-top:10px}.foot{color:var(--muted);font-size:11px;margin:14px 0 4px}.error{color:var(--red)}@media(max-width:1100px){.metrics{grid-template-columns:repeat(4,1fr)}.two,.bottom{grid-template-columns:1fr}.funnel{grid-template-columns:repeat(4,1fr)}}@media(max-width:700px){.shell{padding:14px}.top{display:block}.badges{justify-content:flex-start;margin-top:12px}.metrics{grid-template-columns:repeat(2,1fr)}.funnel,.quality{grid-template-columns:repeat(2,1fr)}.detail-grid{grid-template-columns:1fr}}
</style></head><body><main class="shell">
<div class="top"><div><div class="eyebrow">Read-only experiment telemetry</div><h1 class="title">Shadow Observer</h1><div class="subtitle" id="runline">Loading trusted-shadow artifacts…</div></div><div class="badges"><span class="badge status" id="status">—</span><span class="badge">PAPER ONLY</span><span class="badge">NO WALLET</span><span class="badge">NO LIVE TRADING</span></div></div>
<section class="grid metrics" id="metrics"></section>
<section class="grid two"><div class="card"><div class="section-title"><h2>Executable edge funnel</h2><span id="funnelScope"></span></div><div class="funnel" id="funnel"></div></div><div class="card"><div class="section-title"><h2>Near-miss distribution</h2><span id="nearScope"></span></div><div class="buckets" id="buckets"></div><div class="near-list" id="nearList"></div></div></section>
<section class="card"><div class="section-title"><h2>Live market observations</h2><span>Recorded economics only · click a row for detail</span></div><div class="toolbar"><input class="input" id="filter" placeholder="Filter market or question"><select class="input" id="category"><option value="">All categories</option><option>sports</option><option>crypto</option><option>macro/economics</option><option>politics</option><option>other</option></select></div><div class="scroll"><table><thead><tr id="marketHead"><th data-key="question">Market / question</th><th data-key="category">Category</th><th data-key="topology">Topology</th><th data-key="yesBestAsk">YES ask</th><th data-key="noBestAsk">NO ask</th><th data-key="rawSum">Raw sum</th><th data-key="edge10Bps">Edge $10</th><th data-key="edge100Bps">Edge $100</th><th data-key="availableDepthShares">Depth</th><th data-key="feeStatus">Fee</th><th data-key="bookStateAgeMs">Book state age</th><th data-key="lastHashChangeMs">Hash age</th><th data-key="latestUpdate">Updated</th></tr></thead><tbody id="markets"></tbody></table></div></section>
<section class="card detail" id="detail"></section>
<section class="grid bottom"><div class="card"><div class="section-title"><h2>Data quality</h2><span>Cumulative manifest counters</span></div><div class="grid quality" id="quality"></div><div class="scroll" id="distributions"></div></div><div class="card"><div class="section-title"><h2>Important event stream</h2><span>Filtered · not every raw event</span></div><div id="events"></div></div></section>
<div class="foot" id="foot">Observer never writes to the run and exposes no experiment controls.</div></main>
<script>
const api=${JSON.stringify(api)};let snapshot=null,sortKey='edge10Bps',sortDir=-1,selected=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=v=>v==null?'—':(v*100).toFixed(2)+'%';const num=(v,d=0)=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:d});
const bps=v=>v==null?'—':(v>0?'+':'')+Number(v).toFixed(1)+' bps';const age=v=>v==null?'—':v<1000?num(v)+'ms':v<60000?(v/1000).toFixed(1)+'s':(v/60000).toFixed(1)+'m';
const duration=s=>{s=Math.max(0,s||0);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h+'h '+m+'m'};const time=v=>v?new Date(v).toLocaleTimeString():'—';
function render(){const o=snapshot.overview;const st=document.getElementById('status');st.textContent=o.status;st.className='badge status '+(o.status==='BLOCKED'?'blocked':o.status==='STOPPED'?'stopped':'');document.getElementById('runline').textContent='Stage '+o.stage+' · '+o.runId+' · '+o.commitSha.slice(0,12)+' · '+duration(o.uptimeSeconds)+' / '+duration(o.targetDurationSeconds);
const metrics=[['Cycles',o.cycles],['Markets sampled',o.marketsSampled],['Paired requests',o.pairedRequests],['Pair reliability',pct(o.pairReliability)],['Fee unknown',pct(o.feeUnknownRate)],['Errors',o.errors],['Denied PnL',o.deniedPnl],['Last event',time(o.lastEventTime)]];document.getElementById('metrics').innerHTML=metrics.map(x=>'<div class="card metric"><div class="k">'+esc(x[0])+'</div><div class="v">'+esc(x[1])+'</div></div>').join('');
document.getElementById('funnelScope').textContent=snapshot.funnel.scope;document.getElementById('funnel').innerHTML=snapshot.funnel.steps.map(x=>'<div class="step"><div class="l">'+esc(x.label)+'</div><div class="n">'+num(x.count)+'</div><div class="p">'+pct(x.conversion)+' step · '+pct(x.fromPaired)+' total</div></div>').join('');
document.getElementById('nearScope').textContent=num(snapshot.nearMiss.count)+' recorded scenarios';document.getElementById('buckets').innerHTML=Object.entries(snapshot.nearMiss.buckets).map(([k,v])=>'<div class="bucket"><b>'+num(v)+'</b><span>'+esc(k)+'</span></div>').join('');document.getElementById('nearList').innerHTML='<div class="muted">Strongest recent non-positive observations</div>'+snapshot.nearMiss.strongestRecent.slice(0,5).map(x=>'<div class="near-row"><span>'+esc(x.question)+'</span><span>$'+num(x.requestedSizeUsd)+' · '+num(x.latencyMs)+'ms</span><span class="neg">'+bps(x.netEdgeBps)+'</span></div>').join('');renderMarkets();
const q=snapshot.dataQuality.cumulative;document.getElementById('quality').innerHTML=['TWO_SIDED','BID_ONLY','ASK_ONLY','EMPTY','MISSING','INVALID','REQUEST_FAILED','TRANSPORT_STALE'].map(k=>'<div class="bucket"><b>'+num(q[k])+'</b><span>'+k+'</span></div>').join('');const w=snapshot.dataQuality.observerWindow;document.getElementById('distributions').innerHTML='<table><thead><tr><th>Observer-window distribution</th><th>P50</th><th>P90</th><th>P95</th><th>P99</th><th>Max</th></tr></thead><tbody>'+[['Transport age',w.transportAgeMs],['Book-state age',w.bookStateAgeMs],['Hash-change age',w.timeSinceHashChangeMs]].map(([k,v])=>'<tr><td>'+k+'</td><td>'+age(v.p50)+'</td><td>'+age(v.p90)+'</td><td>'+age(v.p95)+'</td><td>'+age(v.p99)+'</td><td>'+age(v.max)+'</td></tr>').join('')+'</tbody></table><div class="foot">Fee: known '+num(q.feeKnown)+' · disabled '+num(q.feeDisabled)+' · unknown '+num(q.feeUnknown)+' &nbsp; Hash: INITIAL '+num(q.hashInitial)+' · SAME '+num(q.hashSame)+' · CHANGED '+num(q.hashChanged)+'</div>';
document.getElementById('events').innerHTML=snapshot.events.slice(0,40).map(e=>'<div class="event"><span class="mono">#'+num(e.sequence)+'</span><span>'+esc(e.eventType)+'</span><span>'+esc(e.summary)+' <span class="muted">'+time(e.at)+'</span></span></div>').join('')||'<div class="muted">No important events in the observer window.</div>';document.getElementById('foot').textContent='Window sequences '+(snapshot.scope.firstSequence??'—')+'–'+(snapshot.scope.lastSequence??'—')+' · cumulative counters from manifest.json · '+snapshot.scope.liveViews+'.';}
function renderMarkets(){const f=document.getElementById('filter').value.toLowerCase(),c=document.getElementById('category').value;let rows=snapshot.markets.filter(x=>(!c||x.category===c)&&(!f||(x.question+' '+x.marketId).toLowerCase().includes(f)));rows.sort((a,b)=>{let x=a[sortKey],y=b[sortKey];if(x==null)return 1;if(y==null)return -1;return (typeof x==='number'?x-y:String(x).localeCompare(String(y)))*sortDir});document.getElementById('markets').innerHTML=rows.map(x=>'<tr class="market" data-id="'+esc(x.marketId)+'"><td class="question">'+esc(x.question)+'</td><td>'+esc(x.category)+'</td><td>'+esc(x.topology)+'</td><td>'+num(x.yesBestAsk,4)+'</td><td>'+num(x.noBestAsk,4)+'</td><td>'+num(x.rawSum,4)+'</td><td class="'+(x.edge10Bps>0?'pos':'neg')+'">'+bps(x.edge10Bps)+'</td><td class="'+(x.edge100Bps>0?'pos':'neg')+'">'+bps(x.edge100Bps)+'</td><td>'+num(x.availableDepthShares,1)+'</td><td>'+esc(x.feeStatus)+'</td><td>'+age(x.bookStateAgeMs)+'</td><td>'+age(x.lastHashChangeMs)+'</td><td>'+time(x.latestUpdate)+'</td></tr>').join('');document.querySelectorAll('tr.market').forEach(el=>el.addEventListener('click',()=>openDetail(el.dataset.id)));}
function levels(items){return (items||[]).map(x=>'<div><span>'+num(x[0],4)+'</span><span>'+num(x[1],2)+'</span></div>').join('')||'<div class="muted">No levels</div>'}
async function openDetail(id){
  selected=id;const res=await fetch(api+'/../market/'+encodeURIComponent(id));const d=await res.json();if(selected!==id)return;
  const el=document.getElementById('detail');el.className='card detail open';
  el.innerHTML='<div class="section-title"><h2>'+esc(d.metadata.question)+'</h2><span>'+esc(d.metadata.category)+' · '+esc(id)+'</span></div><div class="detail-grid"><div><h3>Current recorded depth</h3><div class="depth"><div><b>YES · bid '+num(d.books.yes.bestBid,4)+' / ask '+num(d.books.yes.bestAsk,4)+'</b><div class="levels">'+levels(d.books.yes.bids)+levels(d.books.yes.asks)+'</div></div><div><b>NO · bid '+num(d.books.no.bestBid,4)+' / ask '+num(d.books.no.bestAsk,4)+'</b><div class="levels">'+levels(d.books.no.bids)+levels(d.books.no.asks)+'</div></div></div><div class="foot mono">YES '+esc(d.books.yes.hash)+' · '+esc(d.books.yes.hashChange)+'<br>NO '+esc(d.books.no.hash)+' · '+esc(d.books.no.hashChange)+'</div></div><div><h3>Size ladder · recorded latency 0ms</h3><div class="scroll"><table><thead><tr><th>Size</th><th>Raw</th><th>Depth</th><th>Fee</th><th>Safety</th><th>Final</th><th>Match</th></tr></thead><tbody>'+d.sizeLadder.map(x=>'<tr><td>$'+x.requestedSizeUsd+'</td><td>'+bps(x.rawTheoreticalSpreadBps)+'</td><td>'+bps(x.depthImpactBps)+'</td><td>'+bps(x.feeImpactBps)+'</td><td>'+bps(x.safetySlippageBps)+'</td><td class="'+(x.finalExecutableEdgeBps>0?'pos':'neg')+'">'+bps(x.finalExecutableEdgeBps)+'</td><td>'+num(x.matchedQuantity,2)+' / unhedged '+num(x.unhedgedQuantity,2)+'</td></tr>').join('')+'</tbody></table></div><div class="foot">'+esc(d.note)+'</div></div></div>';
  el.insertAdjacentHTML('beforeend','<div class="recent-list"><div class="muted">Recent recorded observations</div>'+d.recentObservations.slice(0,10).map(x=>'<div class="event"><span class="mono">#'+num(x.sequence)+'</span><span>'+esc(x.eventType)+'</span><span>'+esc(x.summary)+'</span></div>').join('')+'</div>');
  el.scrollIntoView({behavior:'smooth',block:'start'});
}
async function refresh(){try{const r=await fetch(api,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);snapshot=await r.json();render();if(selected)openDetail(selected)}catch(e){document.getElementById('runline').innerHTML='<span class="error">Observer read failed: '+esc(e.message)+'</span>'}}
document.getElementById('filter').addEventListener('input',()=>snapshot&&renderMarkets());document.getElementById('category').addEventListener('change',()=>snapshot&&renderMarkets());document.querySelectorAll('#marketHead th').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.key;if(sortKey===k)sortDir*=-1;else{sortKey=k;sortDir=1}renderMarkets()}));refresh();setInterval(refresh,3000);
</script></body></html>`;
}

export function mountShadowObserver(app: Express, options: ShadowObserverOptions): ShadowRunReader {
  const prefix = options.pathPrefix ?? '/shadow';
  const reader = new ShadowRunReader(options);
  app.use(prefix, (req: Request, res: Response, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.status(405).json({ error: 'READ_ONLY_OBSERVER' });
      return;
    }
    next();
  });
  app.get(prefix, (_req, res) => res.type('html').send(shadowObserverHtml(prefix)));
  app.get(`${prefix}/api/snapshot`, (_req, res) => {
    try {
      res.json(reader.snapshot());
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get(`${prefix}/api/market/:marketId`, (req, res) => {
    try {
      const detail = reader.marketDetail(req.params.marketId);
      if (!detail) res.status(404).json({ error: 'MARKET_NOT_IN_OBSERVER_WINDOW' });
      else res.json(detail);
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return reader;
}

export interface ShadowObserverServer {
  reader: ShadowRunReader;
  start(): Promise<{ host: string; port: number; url: string }>;
  stop(): Promise<void>;
}

export function createShadowObserverServer(options: ShadowObserverOptions & { host?: string; port: number }): ShadowObserverServer {
  const app = express();
  app.disable('x-powered-by');
  const prefix = options.pathPrefix ?? '/shadow';
  const reader = mountShadowObserver(app, options);
  let server: Server | null = null;
  const host = options.host ?? '127.0.0.1';
  return {
    reader,
    async start() {
      server = createHttpServer(app);
      await new Promise<void>((resolvePromise, reject) => {
        server!.once('error', reject);
        server!.listen(options.port, host, () => resolvePromise());
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      return { host, port, url: `http://${host}:${port}${prefix}` };
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolvePromise, reject) => {
        server!.close((error) => error ? reject(error) : resolvePromise());
      });
      server = null;
    },
  };
}
