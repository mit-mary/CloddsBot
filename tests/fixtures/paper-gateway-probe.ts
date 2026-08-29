import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createGateway } from '../../src/gateway/index.js';
import { loadConfig } from '../../src/utils/config.js';

async function main(): Promise<void> {
  assert.equal(process.env.NO_PRIVATE_KEY, 'true');
  assert.equal(process.env.NO_WALLET, 'true');
  assert.equal(process.env.NO_LIVE_TRADING, 'true');
  const root = process.env.PAPER_GATEWAY_TEST_ROOT;
  assert.ok(root);
  const workspace = process.env.CLODDS_WORKSPACE!;

  const config = await loadConfig(join(root, 'missing-config.json'));
  config.agents.defaults.workspace = workspace;
  config.feeds = {
    polymarket: { enabled: false }, kalshi: { enabled: false }, manifold: { enabled: false },
    metaculus: { enabled: false }, drift: { enabled: false }, news: { enabled: false },
  };
  config.channels = { webchat: { enabled: false } };
  config.opportunityFinder = { enabled: true, realtime: false, semanticMatching: false };
  config.whaleTracking = { enabled: true, realtime: false };
  config.copyTrading = { enabled: true, dryRun: false };
  config.arbitrageExecution = { enabled: true, dryRun: false };
  config.smartRouting = { enabled: false };
  config.positions = { enabled: false };
  config.marketIndex = { enabled: false };
  config.cron = { enabled: false };
  config.monitoring = { enabled: false };
  config.trading = {
    enabled: true,
    dryRun: false,
    maxOrderSize: 100,
    maxDailyLoss: 100,
    polymarket: {
      address: '0xpaper', apiKey: 'paper', apiSecret: 'paper', apiPassphrase: 'paper',
      privateKey: 'must-not-be-read',
    },
    marketMaking: { enabled: true },
    cryptoHft: { enabled: true } as never,
    hftDivergence: { enabled: true } as never,
  };

  const gateway = await createGateway(config);
  const diagnostics = gateway.getPaperDiagnostics();
  const output = {
    ...diagnostics,
    agents: {
      skillManagerConfig: diagnostics.agents.skillManagerConfig,
      loadedSkills: diagnostics.agents.loadedSkills,
      registeredToolNames: diagnostics.agents.registeredToolNames,
    },
    toolSearchProbes: {
      liveOrder: diagnostics.agents.toolSearch('polymarket_buy'),
      credentials: diagnostics.agents.toolSearch('setup polymarket credentials'),
      research: diagnostics.agents.toolSearch('search markets'),
    },
  };
  await gateway.stop();
  process.stdout.write(JSON.stringify(output));
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
