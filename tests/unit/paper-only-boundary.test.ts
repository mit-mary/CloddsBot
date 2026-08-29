import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillManager } from '../../src/skills/loader.js';
import {
  KNOWN_LIVE_CAPABLE_SKILLS,
  KNOWN_LIVE_CAPABLE_AGENT_TOOLS,
  PAPER_APPROVED_SKILLS,
  PAPER_GUARDS,
  assertPaperOnlyEnvironment,
  filterPaperAgentTools,
  isPaperAgentToolAllowed,
  isPaperSkillAllowed,
  isPaperStrategyAllowed,
  paperSkillManagerConfig,
} from '../../src/safety/paper-only.js';
import { checkShadowReadiness } from '../../src/safety/shadow-readiness.js';
import {
  REJECTED_TRUSTED_SHADOW_PNL_SOURCES,
  assertTrustedShadowPnlRecord,
  isTrustedShadowPnlRecord,
} from '../../src/safety/trusted-shadow-ledger.js';

const savedGuards = Object.fromEntries(PAPER_GUARDS.map((name) => [name, process.env[name]]));
const tempDirs: string[] = [];

afterEach(() => {
  for (const name of PAPER_GUARDS) {
    const saved = savedGuards[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('approved paper gateway boundary', () => {
  it('fails closed unless every guard is explicitly 1/true', () => {
    process.env.NO_PRIVATE_KEY = 'true';
    process.env.NO_WALLET = '1';
    process.env.NO_LIVE_TRADING = '0';
    assert.throws(() => assertPaperOnlyEnvironment(), /NO_LIVE_TRADING/);
    process.env.NO_LIVE_TRADING = 'TRUE';
    assert.doesNotThrow(() => assertPaperOnlyEnvironment());
  });

  it('loads only the bundled paper allowlist and excludes known live skills', () => {
    const manager = createSkillManager(undefined, paperSkillManagerConfig());
    assert.deepEqual(
      [...manager.skills.keys()].sort(),
      [...PAPER_APPROVED_SKILLS].sort(),
    );
    for (const name of KNOWN_LIVE_CAPABLE_SKILLS) {
      assert.equal(manager.getSkill(name), undefined, `${name} must be unreachable`);
      assert.equal(isPaperSkillAllowed(name), false);
    }
    assert.equal(manager.getSkill('backtest'), undefined);
    assert.equal(isPaperSkillAllowed('backtest'), false);
  });

  it('does not let workspace or extra skills bypass bundledOnly by using an approved name', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodds-paper-skills-'));
    tempDirs.push(root);
    const workspace = join(root, 'workspace');
    const extra = join(root, 'extra');
    for (const skillDir of [join(workspace, 'skills', 'markets'), join(extra, 'markets')]) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), [
        '---', 'name: markets', 'description: UNTRUSTED_COLLISION', '---', '# foreign',
      ].join('\n'));
    }
    const manager = createSkillManager(workspace, {
      ...paperSkillManagerConfig(),
      extraDirs: [extra],
    });
    const loaded = manager.getSkill('markets');
    assert.ok(loaded);
    assert.doesNotMatch(loaded.description, /UNTRUSTED_COLLISION/);
    assert.doesNotMatch(loaded.path, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('filters agent tool discovery to research/read-only tools', () => {
    const candidates = [
      { name: 'search_markets' },
      { name: 'tool_search' },
      ...KNOWN_LIVE_CAPABLE_AGENT_TOOLS.map((name) => ({ name })),
    ];
    assert.deepEqual(
      filterPaperAgentTools(candidates).map((tool) => tool.name),
      ['search_markets', 'tool_search'],
    );
    for (const name of KNOWN_LIVE_CAPABLE_AGENT_TOOLS) {
      assert.equal(isPaperAgentToolAllowed(name), false, `${name} must be unreachable`);
    }
  });

  it('disables unmigrated HFT and market-making/copy adapters', () => {
    assert.equal(isPaperStrategyAllowed('crypto-hft'), false);
    assert.equal(isPaperStrategyAllowed('hft-divergence'), false);
    assert.equal(isPaperStrategyAllowed('market-making'), false);
    assert.equal(isPaperStrategyAllowed('copy-trading'), false);
    assert.equal(isPaperStrategyAllowed('opportunity-executor'), false);
    assert.equal(isPaperStrategyAllowed('opportunity'), true);
  });

  it('passes the deterministic shadow-readiness latch', () => {
    const result = checkShadowReadiness();
    assert.equal(result.ready, true, result.blockers.join('; '));
    assert.equal(result.evidence.temporalSecondLegVwap, 0.60);
    assert.equal(result.evidence.unknownFeeStatus, 'FEE_UNKNOWN');
    assert.deepEqual(result.evidence.exposedLiveCapableSkills, []);
    assert.deepEqual(result.evidence.exposedLiveCapableAgentTools, []);
    assert.deepEqual(result.evidence.rejectedPnlSourcesAccepted, []);
  });

  it('admits only executable economics and trusted-orderbook PnL to trusted shadow', () => {
    for (const source of ['opportunity-executable-economics', 'trusted-orderbook-tick-execution'] as const) {
      const record = { namespace: 'trusted-shadow' as const, source, pnl: 1 };
      assert.equal(isTrustedShadowPnlRecord(record), true);
      assert.equal(assertTrustedShadowPnlRecord(record), record);
    }
    for (const source of REJECTED_TRUSTED_SHADOW_PNL_SOURCES) {
      const record = { namespace: 'trusted-shadow' as const, source, pnl: 1 };
      assert.equal(isTrustedShadowPnlRecord(record), false, source);
      assert.throws(() => assertTrustedShadowPnlRecord(record), /UNTRUSTED_SHADOW_PNL_SOURCE/);
    }
    assert.equal(isTrustedShadowPnlRecord({
      namespace: 'legacy-research', source: 'legacy-tick-price-non-realistic', pnl: 1,
    }), false);
  });
});
