import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { safeReturnPath } from '../../features/auth/paths.ts';
import { getTranslation, requestLocale } from '../../i18n/server.ts';

export default async function IdentityPage({ searchParams }: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  const { data: messages } = await getTranslation('auth', [await requestLocale()]);
  return <main className="page-width"><div className="auth-layout"><h1>{messages.chooseIdentity}</h1>
    <p className="muted">{messages.identityHelp}</p>
    <form className="auth-form" method="post" action="/identity/select">
      <input type="hidden" name="next" value={safeReturnPath(query.next)} />
      <div><label htmlFor="subject">{messages.identityId}</label><Input id="subject" name="subject" required
        placeholder="https://rezics.com/id/…" /></div>
      {query.error ? <p role="alert">{messages.invalidIdentity}</p> : null}
      <Button type="submit">{messages.continue}</Button>
    </form></div></main>;
}
