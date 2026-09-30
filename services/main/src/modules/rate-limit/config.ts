import type { Pool } from 'pg';
import type { MainConfig } from '../../config.ts';
import { rateLimitBudgets } from './budgets.ts';
import type { MainRateLimit } from './hook.ts';
import { PostgresRateLimitStore } from './store.ts';

export function mainRateLimit(pool: Pool, config: MainConfig): MainRateLimit {
  const set = (value: string) => new Set(value.split(',').map(item => item.trim()).filter(Boolean));
  const options = {
    secret: config.MAIN_RATE_LIMIT_SECRET ?? config.FUSEKI_TITLE_ADMISSION_KEY,
    serviceClientIds: set(config.MAIN_RATE_LIMIT_SERVICE_CLIENT_IDS),
    trustedProxyPeers: set(config.MAIN_RATE_LIMIT_TRUSTED_PROXY_PEERS),
    clientIpHeader: config.MAIN_RATE_LIMIT_CLIENT_IP_HEADER,
  };
  return { options, store: new PostgresRateLimitStore(pool, options),
    budgets: rateLimitBudgets(config.MAIN_RATE_LIMIT_BUDGETS) };
}
