import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { accountsConfig, enrollmentSiteKey } from '../../../features/config/env.ts';
import { pendingAuthorization } from '../../../features/api/oauth-query.ts';
import {
  readPolicyStatus,
  readRequestingClient,
  readSession,
} from '../../../features/api/server.ts';
import { authQuery } from '../../../features/auth/auth-query.ts';
import { SignInFlow } from '../../../features/auth/sign-in-flow.tsx';
import { SignUpForm } from '../../../features/auth/sign-up-form.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';
import { authenticate } from '../../../features/auth/form-actions.ts';
import { acceptances } from '../../../features/auth/policies.ts';
import { requestLocale } from '../../../i18n/server.ts';

export default async function SignInPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await pageQuery(searchParams);
  const { oauthQuery, next, carry, wantsSignUp } = authQuery(query);
  const reauth = query.get('reauth') === '1';
  const pending = oauthQuery ? pendingAuthorization(oauthQuery) : undefined;
  const [session, client] = await Promise.all([
    readSession(),
    pending && oauthQuery ? readRequestingClient(pending.clientId, oauthQuery) : undefined,
  ]);
  const signedIn = session.status === 'ok' ? session.data : undefined;
  // A signed-in visitor has nothing to do here unless an app or a sensitive
  // page asked for a fresh sign-in.
  if (signedIn && !oauthQuery && !reauth) redirect(next);
  const appName = client?.status === 'ok' ? client.data.name?.trim() || null : null;
  const signUp = wantsSignUp && query.get('sign_in') !== '1';
  const policies = signUp ? await readPolicyStatus() : undefined;
  const action = authenticate.bind(null, {
    operations: signUp ? ['sign-up'] : ['email', 'email-reset', 'password', 'two-factor'],
    next,
    oauthQuery,
    carry,
    locale: await requestLocale(),
    policies: policies?.status === 'ok' ? acceptances(policies.data.policies) : undefined,
    localChallenge: enrollmentSiteKey() === 'local',
  });
  // A verified account may resume a signed request whose original prompt was
  // "create". The unsigned sign_in flag selects sign-in without altering it.
  return (
    <AuthFrame>
      {signUp ? (
        <SignUpForm
          action={action}
          next={next}
          oauthQuery={oauthQuery}
          carry={carry}
          appName={appName}
          turnstileSiteKey={enrollmentSiteKey()}
          policies={policies?.status === 'ok' ? policies.data.policies : undefined}
          aboutOrigin={accountsConfig().ABOUT_SITE_URL}
          country={(await headers()).get('cf-ipcountry')}
        />
      ) : (
        <SignInFlow
          action={action}
          next={next}
          oauthQuery={oauthQuery}
          carry={carry}
          appName={appName}
          reauthEmail={reauth ? signedIn?.user.email : undefined}
          turnstileSiteKey={enrollmentSiteKey()}
          notice={
            query.get('policy_declined') === '1'
              ? 'policy-declined'
              : query.get('deleted') === '1'
                ? 'deleted'
                : undefined
          }
        />
      )}
    </AuthFrame>
  );
}
