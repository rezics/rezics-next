// Server-side configuration for the Accounts Worker. Defaults match the `vars`
// in wrangler.jsonc and the shared `task dev` backend; `task env:example`
// renders this spec into apps/accounts/.env.example.
import { cleanEnv, str, url } from 'envalid';

export const accountsSpec = {
  ACCOUNT_TURNSTILE_MODE: str({ choices: ['local', 'cloudflare'], default: 'cloudflare', devDefault: 'local',
    desc: 'Enrollment widget profile; must match Account. Local mode makes no provider request.' }),
  ACCOUNT_TURNSTILE_SITE_KEY: str({ default: '',
    desc: 'Public Cloudflare Turnstile site key; missing key disables only the enrollment widget.' }),
  ACCOUNT_SERVICE_ORIGIN: url({ default: 'http://127.0.0.1:3002',
    desc: 'Account service origin that /api/auth, /api/account, /oauth2 and /.well-known proxy to.' }),
  ACCOUNT_BASE_URL: url({ default: 'http://127.0.0.1:3004',
    desc: 'Public Account origin and OAuth issuer base, the same value the Account service uses.' }),
  WEB_ORIGIN: url({ default: 'http://127.0.0.1:3000', desc: 'REZICS web origin linked from the Accounts header.' }),
};

export function accountsConfig(env: Record<string, string | undefined> = process.env) {
  return cleanEnv(env, accountsSpec);
}

/** Called only by forms that render enrollment challenges, never by proxies. */
export function enrollmentSiteKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const config = accountsConfig(env);
  if (config.ACCOUNT_TURNSTILE_MODE === 'local' && env.NODE_ENV !== 'production') return 'local';
  const key = config.ACCOUNT_TURNSTILE_SITE_KEY.trim();
  if (!key || (env.NODE_ENV === 'production' && /^[123]x0+(?:AA|BB|FF)$/.test(key))) {
    console.error('Accounts enrollment widget disabled: configure ACCOUNT_TURNSTILE_SITE_KEY for cloudflare mode');
    return undefined;
  }
  return key;
}

/** The origin of an absolute HTTP(S) URL without a path, query or fragment. */
export function httpOrigin(name: string, value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search
    || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return parsed.origin;
}
