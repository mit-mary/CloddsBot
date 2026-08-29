/** Fork policy: this mainline is research/shadow only. */
export const PAPER_ONLY = true as const;
export const TRUSTED_TICK_REPLAY_EXECUTION_MODE = 'trusted-orderbook' as const;

export const PAPER_GUARDS = ['NO_PRIVATE_KEY', 'NO_WALLET', 'NO_LIVE_TRADING'] as const;

/**
 * Bundled, read-only/research skills exposed by the approved gateway.
 * Workspace, managed, and extra-directory skills are excluded even when their
 * names collide with an allowed bundled skill.
 */
export const PAPER_APPROVED_SKILLS = [
  'analytics',
  'features',
  'feeds',
  'market-index',
  'markets',
  'metrics',
  'opportunity',
  'risk',
  'slippage',
  'ticks',
] as const;

export const PAPER_DISABLED_STRATEGIES = [
  'crypto-hft',
  'hft-divergence',
  'market-making',
  'copy-trading',
  'opportunity-executor',
] as const;

export const KNOWN_LIVE_CAPABLE_SKILLS = [
  'crypto-hft',
  'divergence',
  'execution',
  'mm',
  'copy-trading',
  'strategy',
  'trading-system',
  'trading-polymarket',
  'trading-kalshi',
  'trading-solana',
  'hyperliquid',
  'mexc-futures',
  'lighter',
  'percolator',
  'pancakeswap',
] as const;

export const PAPER_APPROVED_AGENT_TOOLS = [
  'search_markets',
  'get_market',
  'market_index_search',
  'market_index_stats',
  'find_arbitrage',
  'compare_prices',
  'polymarket_crypto_markets',
  'get_portfolio',
  'get_portfolio_history',
  'create_alert',
  'list_alerts',
  'delete_alert',
  'get_recent_news',
  'search_news',
  'get_wallet_trades',
  'watch_wallet',
  'save_session_checkpoint',
  'restore_session_checkpoint',
  'polymarket_price',
  'polymarket_orderbook',
  'polymarket_fee_rate',
  'polymarket_spread',
  'polymarket_last_trade',
  'polymarket_tick_size',
  'polymarket_market_info',
  'orderbook_imbalance',
  'polymarket_markets',
  'polymarket_event',
  'polymarket_event_by_slug',
  'polymarket_events',
  'polymarket_search_events',
  'tool_search',
] as const;

export const KNOWN_LIVE_CAPABLE_AGENT_TOOLS = [
  'polymarket_buy',
  'polymarket_sell',
  'polymarket_market_buy',
  'polymarket_market_sell',
  'polymarket_maker_buy',
  'polymarket_maker_sell',
  'polymarket_post_orders_batch',
  'polymarket_cancel',
  'polymarket_update_balance_allowance',
  'setup_polymarket_credentials',
  'copy_trade',
  'solana_jupiter_swap',
  'pumpfun_trade',
  'evm_swap',
] as const;

export function isPaperGuardAsserted(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function assertPaperOnlyEnvironment(): void {
  const missing = PAPER_GUARDS.filter((name) => !isPaperGuardAsserted(process.env[name]));
  if (missing.length > 0) {
    throw new Error(`Paper-only runtime requires guards asserted as 1/true: ${missing.join(', ')}`);
  }
}

export function isPaperSkillAllowed(name: string): boolean {
  return (PAPER_APPROVED_SKILLS as readonly string[]).includes(name);
}

export function isPaperAgentToolAllowed(name: string): boolean {
  return !PAPER_ONLY || (PAPER_APPROVED_AGENT_TOOLS as readonly string[]).includes(name);
}

export function filterPaperAgentTools<T extends { name: string }>(tools: T[]): T[] {
  return PAPER_ONLY ? tools.filter((tool) => isPaperAgentToolAllowed(tool.name)) : tools;
}

export function isPaperStrategyAllowed(name: string): boolean {
  return !PAPER_ONLY || !(PAPER_DISABLED_STRATEGIES as readonly string[]).includes(name);
}

export function paperSkillManagerConfig(): {
  allowBundled: string[];
  allowSkills: string[];
  bundledOnly: true;
} {
  const allow = [...PAPER_APPROVED_SKILLS];
  return { allowBundled: allow, allowSkills: allow, bundledOnly: true };
}
