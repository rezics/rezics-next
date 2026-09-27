import { serviceOrigin } from '../api/origins.ts';
import { webConfig } from '../config/env.ts';
import type { AccountClient } from './account.ts';

/** The web app's public PKCE client at Account, or null when it is not registered. */
export function accountClient(): AccountClient | null {
  const config = webConfig();
  if (!config.WEB_OAUTH_CLIENT_ID) return null;
  return { accountOrigin: serviceOrigin('ACCOUNT_ORIGIN'), clientId: config.WEB_OAUTH_CLIENT_ID,
    resource: config.MAIN_RESOURCE };
}
