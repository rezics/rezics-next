import { redirect } from 'next/navigation';
import { accountsConfig } from '../../../features/config/env.ts';
import { pendingAuthorization } from '../../../features/api/oauth-query.ts';
import { readRequestingClient, readSession } from '../../../features/api/server.ts';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { SignUpForm } from '../../../features/auth/sign-up-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

export default async function SignUpPage({ searchParams }: { searchParams: PageSearchParams }) {
  const { oauthQuery, next, carry } = authQuery(await pageQuery(searchParams));
  if (!oauthQuery && (await readSession()).status === 'ok') redirect(next);
  const pending = oauthQuery ? pendingAuthorization(oauthQuery) : undefined;
  const client = pending && oauthQuery ? await readRequestingClient(pending.clientId, oauthQuery) : undefined;
  return <AuthFrame><SignUpForm next={next} oauthQuery={oauthQuery} carry={carry}
    turnstileSiteKey={accountsConfig().ACCOUNT_TURNSTILE_SITE_KEY}
    appName={client?.status === 'ok' ? client.data.name?.trim() || null : null} /></AuthFrame>;
}
