import { PendingPage } from '../shell/pending';
import { ErrorPage, NotFoundPage } from '../shell/shell';

/** Public concealment stays usable while the browser checks the reader's private access. */
export function CollectionAccessState({ state }: { state: 'loading' | 'not-found' | 'unavailable' }) {
  if (state === 'loading') return <PendingPage />;
  return state === 'not-found' ? <NotFoundPage /> : <ErrorPage />;
}
