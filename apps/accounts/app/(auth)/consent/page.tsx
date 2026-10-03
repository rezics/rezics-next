import { pendingAuthorization, signedOAuthQuery } from '../../../features/api/oauth-query.ts';
import { readConsent, readPublicClient, readSession } from '../../../features/api/server.ts';
import { ConsentCard } from '../../../features/consent/consent-card.tsx';
import { ConsentProblem } from '../../../features/consent/consent-problem.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';
import { requestLocale } from '../../../i18n/server.ts';
import { authenticate } from '../../../features/auth/form-actions.ts';

export default async function ConsentPage({ searchParams }: { searchParams: PageSearchParams }) {
  const search = (await pageQuery(searchParams)).toString();
  const oauthQuery = signedOAuthQuery(search);
  const pending = pendingAuthorization(search);
  if (!oauthQuery || !pending)
    return (
      <AuthFrame>
        <ConsentProblem kind="invalid" />
      </AuthFrame>
    );
  const session = await readSession();
  if (session.status === 'signed-out') {
    return (
      <AuthFrame>
        <ConsentProblem kind="signed-out" signIn={`/sign-in?${oauthQuery}`} />
      </AuthFrame>
    );
  }
  if (session.status !== 'ok')
    return (
      <AuthFrame>
        <ConsentProblem kind="unavailable" />
      </AuthFrame>
    );
  const [client, consent, locale] = await Promise.all([
    readPublicClient(pending.clientId),
    readConsent(oauthQuery),
    requestLocale(),
  ]);
  if (consent.status !== 'ok')
    return (
      <AuthFrame>
        <ConsentProblem kind="unavailable" />
      </AuthFrame>
    );
  const descriptions = Object.fromEntries(
    consent.data.scopes.map((scope) => [
      scope.scope,
      scope.description[locale] ?? scope.description.en,
    ]),
  );
  return (
    <AuthFrame>
      <ConsentCard
        app={{
          ...(client.status === 'ok'
            ? client.data
            : { name: null, logo: null, uri: null, policy: null, terms: null }),
          unverified: consent.data.unverified,
          redirectHost: consent.data.redirectHost,
        }}
        user={session.data.user}
        scopes={pending.scopes}
        oauthQuery={oauthQuery}
        descriptions={descriptions}
        action={authenticate.bind(null, {
          operations: ['consent', 'switch'],
          oauthQuery,
          carry: oauthQuery,
        })}
      />
    </AuthFrame>
  );
}
