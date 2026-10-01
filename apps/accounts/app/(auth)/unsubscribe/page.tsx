import { readUnsubscribe } from '../../../features/api/server.ts';
import { Unsubscribe } from '../../../features/auth/unsubscribe.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

/** The link in an optional email lands here; reading it changes nothing, and confirming is one click. */
export default async function UnsubscribePage({ searchParams }: { searchParams: PageSearchParams }) {
  const token = (await pageQuery(searchParams)).get('token') ?? '';
  const state = token ? await readUnsubscribe(token) : 'invalid';
  return <AuthFrame><Unsubscribe token={token} valid={state === 'valid'} /></AuthFrame>;
}
