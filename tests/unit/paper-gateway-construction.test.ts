import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { KNOWN_LIVE_CAPABLE_AGENT_TOOLS } from '../../src/safety/paper-only.js';

describe('real approved paper gateway construction', () => {
  it('constructs the actual createGateway path without live services or foreign skills/tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodds-paper-gateway-'));
    try {
      const workspace = join(root, 'workspace');
      const collisionDir = join(workspace, 'skills', 'markets');
      mkdirSync(collisionDir, { recursive: true });
      writeFileSync(join(collisionDir, 'SKILL.md'), [
        '---', 'name: markets', 'description: UNTRUSTED_WORKSPACE_COLLISION', '---', '# foreign',
      ].join('\n'));

      const probe = spawnSync(process.execPath, [
        '--import', 'tsx', 'tests/fixtures/paper-gateway-probe.ts',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          NO_PRIVATE_KEY: 'true',
          NO_WALLET: 'true',
          NO_LIVE_TRADING: 'true',
          ANTHROPIC_API_KEY: 'paper-construction-test-not-used',
          CLODDS_STATE_DIR: join(root, 'state'),
          CLODDS_WORKSPACE: workspace,
          PAPER_GATEWAY_TEST_ROOT: root,
          LOG_LEVEL: 'fatal',
        },
      });
      assert.equal(probe.status, 0, probe.stderr || probe.stdout);
      const diagnostics = JSON.parse(probe.stdout.trim());

      assert.equal(diagnostics.executionService, null);
      assert.equal(diagnostics.walletLaunchRouterMounted, false);
      assert.equal(diagnostics.cryptoHftInstantiated, false);
      assert.equal(diagnostics.hftDivergenceInstantiated, false);
      assert.equal(diagnostics.marketMakingInstantiated, false);
      assert.equal(diagnostics.copyTradingInstantiated, false);
      assert.equal(diagnostics.opportunityAutoExecutorInstantiated, false);

      assert.equal(diagnostics.agents.skillManagerConfig.bundledOnly, true);
      assert.equal(diagnostics.agents.loadedSkills.some(({ name }: { name: string }) => name === 'backtest'), false);
      const markets = diagnostics.agents.loadedSkills.find(({ name }: { name: string }) => name === 'markets');
      assert.ok(markets);
      assert.equal(normalize(markets.path).startsWith(normalize(root)), false);

      for (const tool of KNOWN_LIVE_CAPABLE_AGENT_TOOLS) {
        assert.equal(diagnostics.agents.registeredToolNames.includes(tool), false, tool);
      }
      for (const results of Object.values(diagnostics.toolSearchProbes) as string[][]) {
        assert.ok(results.every((name) => diagnostics.agents.registeredToolNames.includes(name)));
        assert.ok(results.every((name) => !KNOWN_LIVE_CAPABLE_AGENT_TOOLS.includes(name as never)));
      }
      assert.ok(diagnostics.toolSearchProbes.research.includes('search_markets'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
