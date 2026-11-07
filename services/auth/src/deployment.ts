import { securityScopeLimit } from '@rezics/auth-contract';
import { createAuthHost, type AuthHostOptions } from './host.ts';
import type { AuthServiceOptions, WebsiteClientRegistration } from './index.ts';
import { issuerOrigin } from './issuer.ts';
import { websiteDeploymentScopes } from './website-scopes.ts';
import type { WorkflowContext } from './workflows.ts';

export { websiteDeploymentScopes };

/** A deployment uses the mounted catalogue, including anonymous/private branches. */
type SiteActions = NonNullable<AuthServiceOptions['siteActions']>;

export type AuthWebsiteDeployment = {
  /** Canonical origins serving the installed Web callback and sign-out return. */
  origins: readonly string[];
  publicJwks: WebsiteClientRegistration['publicJwks'];
};

export type AuthDeploymentConfiguration = {
  issuer: string;
  audience: string;
  kernelOrigin: string;
  turnstileSiteKey: string;
  website: AuthWebsiteDeployment;
};

/** External deployment configuration is admitted before any native state changes. */
export function authDeploymentConfiguration(configuration: AuthDeploymentConfiguration, actions: SiteActions) {
  issuerOrigin(configuration.issuer);
  const audience = issuerOrigin(configuration.audience);
  if (audience.protocol !== 'https:') throw new Error('Auth audience must be an HTTPS origin');
  issuerOrigin(configuration.kernelOrigin);
  if (!configuration.turnstileSiteKey) throw new Error('Turnstile site key is required');
  const origins = [...new Set(configuration.website.origins)];
  if (!origins.length || origins.length > 8) throw new Error('Website requires one to eight origins');
  for (const origin of origins) {
    const website = issuerOrigin(origin);
    if (configuration.issuer.startsWith('https:') && website.protocol !== 'https:')
      throw new Error('HTTPS Auth requires HTTPS website origins');
  }
  const scopes = websiteDeploymentScopes(actions.keys());
  return {
    registration: {
      publicJwks: configuration.website.publicJwks,
      redirectUris: origins.map((origin) => `${origin}/auth/callback`),
      postLogoutRedirectUris: origins.map((origin) => `${origin}/`),
      scopes,
    } satisfies WebsiteClientRegistration,
    authPages: {
      AUTH_SECURITY_SCOPE_CONFIGURATION: `catalogue:${securityScopeLimit(actions.keys())}`,
      TURNSTILE_SITE_KEY: configuration.turnstileSiteKey,
    },
    website: {
      AUTH_ISSUER: configuration.issuer,
      API_RESOURCE: configuration.audience,
      WEBSITE_CLIENT_ID: 'rezics-website',
      WEBSITE_SCOPES: scopes.join(' '),
      SITE_ORIGINS: origins.join(','),
      KERNEL_ORIGIN: configuration.kernelOrigin,
    },
  };
}

export type AuthDeploymentOptions<Context = WorkflowContext> = {
  host: AuthHostOptions<Context> & {
    siteActions: SiteActions;
    turnstile: NonNullable<AuthHostOptions['turnstile']>;
    /** The installed private delivery adapter receives the original native URL and identity. */
    recoveryDelivery: NonNullable<AuthServiceOptions['recoveryDelivery']>;
  };
  kernelOrigin: string;
  turnstileSiteKey: string;
  website: AuthWebsiteDeployment;
};

/** Construct, register and start one host before publishing its nonsecret bindings.
 * The website signing key remains a separate Web Worker secret. Delivery uses the
 * native callback and custody contract; this layer does not resend or store mail.
 */
export async function createAuthDeployment<Context = WorkflowContext>(options: AuthDeploymentOptions<Context>) {
  const configuration = authDeploymentConfiguration(
    {
      issuer: options.host.issuer,
      audience: options.host.audience,
      kernelOrigin: options.kernelOrigin,
      turnstileSiteKey: options.turnstileSiteKey,
      website: options.website,
    },
    options.host.siteActions,
  );
  const host = await createAuthHost(options.host);
  try {
    await host.service.internal.registerWebsiteClient(configuration.registration);
    await host.start();
  } catch (error) {
    await host.stop();
    throw error;
  }
  return { host, authPages: configuration.authPages, website: configuration.website };
}
