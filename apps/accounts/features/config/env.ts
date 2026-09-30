// Server-side configuration for the Accounts Worker. Defaults match the `vars`
// in wrangler.jsonc and the shared `task dev` backend; `task env:example`
// renders this spec into apps/accounts/.env.example.
import { cleanEnv, str, url } from 'envalid';

export const accountsSpec = {
  ACCOUNT_TURNSTILE_SITE_KEY: str({ devDefault: '1x00000000000000000000AA',
    desc: 'Public Cloudflare Turnstile site key; production must supply a real key.' }),
  ACCOUNT_SERVICE_ORIGIN: url({ default: 'http://127.0.0.1:3002',
    desc: 'Account service origin that /api/auth, /api/account, /oauth2 and /.well-known proxy to.' }),
  ACCOUNT_BASE_URL: url({ default: 'http://127.0.0.1:3004',
    desc: 'Public Account origin and OAuth issuer base, the same value the Account service uses.' }),
  WEB_ORIGIN: url({ default: 'http://127.0.0.1:3000', desc: 'REZICS web origin linked from the Accounts header.' }),
};

export function accountsConfig(env: Record<string, string | undefined> = process.env) {
  const config = cleanEnv(env, accountsSpec);
  if (!config.ACCOUNT_TURNSTILE_SITE_KEY.trim()
    || (env.NODE_ENV === 'production' && /^[123]x0+(?:AA|BB|FF)$/.test(config.ACCOUNT_TURNSTILE_SITE_KEY))) {
    throw new Error('ACCOUNT_TURNSTILE_SITE_KEY must be configured; test keys are development-only');
  }
  return config;
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
