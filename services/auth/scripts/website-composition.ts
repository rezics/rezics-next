/** Trusted host/deployment composition. Never import this module into the browser. */
import { writeFile } from 'node:fs/promises';
import type { ActionCatalogue } from '../../kernel/src/request/access.ts';
import { websiteRegistrationScopes } from '../../../apps/web/src/session/website-scopes.ts';
import type { AuthService } from '../src/index.ts';

type Registration = Parameters<AuthService['internal']['registerWebsiteClient']>[0];

/** Route declarations resolve operation IDs to action names, including anonymous/private branches. */
export function mountedWebsiteConfiguration(actions: ActionCatalogue) {
  const scopes = websiteRegistrationScopes([
    ...actions.keys(),
    'organization:create',
    'account:manage',
    'account:delete',
  ]);
  return { scopes, WEBSITE_SCOPES: scopes.join(' ') };
}

/** Publish only after Auth accepts the exact registration, never before a failed registration. */
export async function registerWebsiteDeployment(
  auth: AuthService,
  actions: ActionCatalogue,
  registration: Omit<Registration, 'scopes'>,
  configurationFile: string,
) {
  const configuration = mountedWebsiteConfiguration(actions);
  await auth.internal.registerWebsiteClient({ ...registration, scopes: configuration.scopes });
  await writeFile(configurationFile, JSON.stringify({ WEBSITE_SCOPES: configuration.WEBSITE_SCOPES }) + '\n');
  return configuration;
}
