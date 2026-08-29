import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { GAMMA_MARKETS_URL } from '../src/shadow/network-preflight.js';
import { relaunchWithHostProxyIfNeeded } from '../src/shadow/node-network-bootstrap.js';
import { TrustedShadowV1Runner } from '../src/shadow/trusted-shadow-v1.js';

function value(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): void {
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const stage = value('stage', 'A').toUpperCase();
  if (!['A', 'B', 'C'].includes(stage)) throw new Error('stage must be A, B, or C');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  const runner = new TrustedShadowV1Runner({
    runDir: resolve(value('run-dir')),
    reportsDir: resolve(value('reports-dir')),
    commitSha,
    stage: stage as 'A' | 'B' | 'C',
    durationSeconds: Number(value('duration-seconds', stage === 'A' ? '60' : '86400')),
    intervalMs: Number(value('interval-ms', '2000')),
    marketLimit: Number(value('market-limit', '5')),
    safetySlippageBps: Number(value('safety-bps', '25')),
    staleAfterMs: Number(value('stale-after-ms', '5000')),
    maxPairGapMs: Number(value('max-pair-gap-ms', '2000')),
    fetchTimeoutMs: Number(value('fetch-timeout-ms', '15000')),
    preflightAttempts: Number(value('preflight-attempts', '3')),
    preflightBackoffMs: Number(value('preflight-backoff-ms', '500')),
    resume: flag('resume'),
  });

  runner.run(controller.signal).then(
    (manifest) => {
      process.stdout.write(`${JSON.stringify({
        runId: manifest.runId, commitSha: manifest.commitSha, stage: manifest.stage,
        status: manifest.status, stopReasons: manifest.stopReasons,
        networkPreflight: manifest.networkPreflight, stats: manifest.stats,
      })}\n`);
      process.exitCode = manifest.status === 'blocked' ? 2 : 0;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

if (!relaunchWithHostProxyIfNeeded(GAMMA_MARKETS_URL)) main();
