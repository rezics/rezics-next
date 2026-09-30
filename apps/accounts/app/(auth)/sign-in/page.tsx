import { redirect } from 'next/navigation';
import { accountsConfig } from '../../../features/config/env.ts';
import { pendingAuthorization } from '../../../features/api/oauth-query.ts';
import { readRequestingClient, readSession } from '../../../features/api/server.ts';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { SignInFlow } from '../../../features/auth/sign-in-flow.tsx';
import { SignUpForm } from '../../../features/auth/sign-up-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

export default async function SignInPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await pageQuery(searchParams);
  const { oauthQuery, next, carry, wantsSignUp } = authQuery(query);
  const reauth = query.get('reauth') === '1';
  const pending = oauthQuery ? pendingAuthorization(oauthQuery) : undefined;
  const [session, client] = await Promise.all([readSession(),
    pending && oauthQuery ? readRequestingClient(pending.clientId, oauthQuery) : undefined]);
  const signedIn = session.status === 'ok' ? session.data : undefined;
  // A signed-in visitor has nothing to do here unless an app or a sensitive
  // page asked for a fresh sign-in.
  if (signedIn && !oauthQuery && !reauth) redirect(next);
  const appName = client?.status === 'ok' ? client.data.name?.trim() || null : null;
  // A verified account may resume a signed request whose original prompt was
  // "create". The unsigned sign_in flag selects sign-in without altering it.
  return <AuthFrame>{wantsSignUp && query.get('sign_in') !== '1'
    ? <SignUpForm next={next} oauthQuery={oauthQuery} carry={carry} appName={appName}
      turnstileSiteKey={accountsConfig().ACCOUNT_TURNSTILE_SITE_KEY} />
    : <SignInFlow next={next} oauthQuery={oauthQuery} carry={carry} appName={appName}
      reauthEmail={reauth ? signedIn?.user.email : undefined}
      turnstileSiteKey={accountsConfig().ACCOUNT_TURNSTILE_SITE_KEY}
      notice={query.get('deleted') === '1' ? 'deleted' : undefined} />}</AuthFrame>;
}
