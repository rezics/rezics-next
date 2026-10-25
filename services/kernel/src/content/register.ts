import { createAccess } from '../access/index.ts';
import resourceRoles from '../access/resource-roles.json';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { createAuthConsentReader } from '../access/auth-consent.ts';
import { ConfigError } from '../commerce/config.ts';
import { contentEffects } from './relays.ts';
import type { WorkModule } from '../work/registry.ts';
import { R2Storage } from './r2-storage.ts';
import { createContentWork } from './work.ts';
import { readContentWorkConfig } from './work-config.ts';

/** Resolve the shared role catalogue in full; a partial action catalogue would
 * disable owner roles containing actions in addition to post:erase. This private
 * worker Access instance restores native initiators, never HTTP credentials. */
export function createContentWorkAccess() {
  return createAccess({
    actions: new Map(
      Object.values(resourceRoles.roles)
        .flat()
        .map((action) => [action, { anonymous: false }]),
    ),
  });
}

/** Sole kernel worker composition entry; configuration comes from its shared context. */
export const registerContent: WorkModule = {
  name: 'content',
  async register(context) {
    const config = readContentWorkConfig(context.env);
    const storage = new R2Storage({ ...config.storage, fetch });
    const required = (name: string) => {
      const value = context.env[name];
      if (!value || !/^[\x21-\x7e]{1,1024}$/.test(value)) throw new ConfigError(name);
      return value;
    };
    const consentUrl = required('CONTENT_AUTH_CONSENT_URL');
    try {
      const url = new URL(consentUrl);
      if (
        url.protocol !== 'https:' ||
        url.pathname !== '/internal/v1/consents:read' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ConfigError('CONTENT_AUTH_CONSENT_URL');
    }
    const readConsent = createAuthConsentReader({
      url: consentUrl,
      serviceTokenId: required('CF_ACCESS_CLIENT_ID'),
      serviceTokenSecret: required('CF_ACCESS_CLIENT_SECRET'),
    });
    await createContentWork({
      storage,
      access: createContentWorkAccess(),
      readConsent,
      routeKey: readMembershipRouteKey(context.env),
      fetchConfig: { allowedHosts: config.sourceHosts },
    }).register(context);
    context.addEffects(contentEffects(context.pool, context.client));
  },
};
