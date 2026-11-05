import { readFileSync } from 'node:fs';
import { websiteRegistrationScopes } from '../src/session/website-scopes.ts';

/** Read the public output of trusted registration, once at build/deployment time. */
export function websiteWorkerScopes(env: NodeJS.ProcessEnv): string {
  const file = env.WEBSITE_CONFIGURATION_FILE;
  if (!file) {
    if (env.NODE_ENV === 'production' && env.WEBSITE_CLIENT_ID && !env.WEB_TEST_STATE_DIR)
      throw new Error('WEBSITE_CONFIGURATION_FILE is required for production website registration');
    return env.WEBSITE_SCOPES ?? '';
  }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('WEBSITE_SCOPES' in value) ||
    typeof value.WEBSITE_SCOPES !== 'string'
  )
    throw new Error('Invalid WEBSITE_CONFIGURATION_FILE: expected WEBSITE_SCOPES');
  const scopes = value.WEBSITE_SCOPES.split(' ');
  if (
    scopes.some((scope) => !/^(openid|offline_access|[a-z][a-z_]*:[a-z][a-z_]*)$/.test(scope)) ||
    websiteRegistrationScopes(scopes).join(' ') !== value.WEBSITE_SCOPES
  )
    throw new Error('Invalid WEBSITE_CONFIGURATION_FILE: expected exact canonical registered scopes');
  if (env.WEBSITE_SCOPES !== undefined && env.WEBSITE_SCOPES !== value.WEBSITE_SCOPES)
    throw new Error('WEBSITE_SCOPES differs from WEBSITE_CONFIGURATION_FILE');
  return value.WEBSITE_SCOPES;
}
