import { pendingAuthorization, signedOAuthQuery } from '../../../features/api/oauth-query.ts';
import { readPublicClient, readSession } from '../../../features/api/server.ts';
import { ConsentCard } from '../../../features/consent/consent-card.tsx';
import { ConsentProblem } from '../../../features/consent/consent-problem.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

export default async function ConsentPage({ searchParams }: { searchParams: PageSearchParams }) {
  const search = (await pageQuery(searchParams)).toString();
  const oauthQuery = signedOAuthQuery(search);
  const pending = pendingAuthorization(search);
  if (!oauthQuery || !pending) return <AuthFrame><ConsentProblem kind="invalid" /></AuthFrame>;
  const session = await readSession();
  if (session.status === 'signed-out') {
    return <AuthFrame><ConsentProblem kind="signed-out" signIn={`/sign-in?${oauthQuery}`} /></AuthFrame>;
  }
  if (session.status !== 'ok') return <AuthFrame><ConsentProblem kind="unavailable" /></AuthFrame>;
  const client = await readPublicClient(pending.clientId);
  return <AuthFrame><ConsentCard app={client.status === 'ok' ? client.data : null}
    user={session.data.user} scopes={pending.scopes} oauthQuery={oauthQuery} /></AuthFrame>;
}
