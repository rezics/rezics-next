import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { accountsConfig, enrollmentSiteKey } from '../../../features/config/env.ts';
import { pendingAuthorization } from '../../../features/api/oauth-query.ts';
import { readPolicyStatus, readRequestingClient, readSession } from '../../../features/api/server.ts';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { SignUpForm } from '../../../features/auth/sign-up-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

export default async function SignUpPage({ searchParams }: { searchParams: PageSearchParams }) {
  const { oauthQuery, next, carry } = authQuery(await pageQuery(searchParams));
  if (!oauthQuery && (await readSession()).status === 'ok') redirect(next);
  const pending = oauthQuery ? pendingAuthorization(oauthQuery) : undefined;
  const client = pending && oauthQuery ? await readRequestingClient(pending.clientId, oauthQuery) : undefined;
  const policies = await readPolicyStatus();
  // The region Cloudflare resolved for this request, as the Account service will apply it.
  const country = (await headers()).get('cf-ipcountry');
  return <AuthFrame><SignUpForm next={next} oauthQuery={oauthQuery} carry={carry}
    turnstileSiteKey={enrollmentSiteKey()} policies={policies.status === 'ok' ? policies.data.policies : undefined}
    aboutOrigin={accountsConfig().ABOUT_SITE_URL} country={country}
    appName={client?.status === 'ok' ? client.data.name?.trim() || null : null} /></AuthFrame>;
}
