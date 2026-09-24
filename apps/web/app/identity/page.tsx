import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { safeReturnPath } from '../../features/auth/paths.ts';

export default async function IdentityPage({ searchParams }: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  return <main className="page-width"><div className="auth-layout"><h1>Choose an acting identity</h1>
    <p className="muted">Enter an identity you are authorized to use. The service checks your authority for each action.</p>
    <form className="auth-form" method="post" action="/identity/select">
      <input type="hidden" name="next" value={safeReturnPath(query.next)} />
      <div><label htmlFor="subject">Identity ID</label><Input id="subject" name="subject" required
        placeholder="https://rezics.com/id/…" /></div>
      {query.error ? <p role="alert">Enter a full REZICS identity ID.</p> : null}
      <Button type="submit">Continue</Button>
    </form></div></main>;
}
