import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isNotFound, notFound, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useSession } from '../session/query';
import { browserObservation } from '../session/observation';
import { personalRead } from '../session/reading-policy';
import type { ReadCredentialMode } from '../kernel/credential';
import { NotFoundPage } from '../shell/shell';
import { PendingPage } from '../shell/pending';

/** An anonymous miss can be retried once by the current browser reader. SSR stays anonymous. */
export async function readCommunityRoute<T>(
  client: QueryClient,
  mode: ReadCredentialMode,
  read: (credentialMode: ReadCredentialMode, expectedReaderSubject?: string) => Promise<T>,
): Promise<T> {
  try {
    return await read(mode);
  } catch (error) {
    if (!isNotFound(error) || mode !== 'anonymous' || !personalRead.enabled) throw error;
    const source = browserObservation(client);
    const before = source.getSnapshot();
    if (before.state !== 'signed-in') throw error;
    const tryPersonal = () => read('session', before.observation.subject);
    const current = () => {
      const after = source.getSnapshot();
      return after.state === 'signed-in' && after.observation.id === before.observation.id;
    };
    try {
      const value = await tryPersonal();
      if (!current()) throw error;
      return value;
    } catch (personalError) {
      if (!current()) throw error;
      if (!isNotFound(personalError)) throw personalError;
      throw notFound({ data: { checkedReader: before.observation.id } });
    }
  }
}

export function CommunityRouteNotFound({ data }: { data?: unknown }) {
  const { state } = useSession();
  const client = useQueryClient();
  const router = useRouter();
  const { href } = useLocation();
  const source = browserObservation(client);
  const reader = source.getSnapshot();
  const checked = data && typeof data === 'object' && 'checkedReader' in data ? data.checkedReader : null;
  const readerId = state === 'signed-in' && reader.state === 'signed-in' ? reader.observation.id : null;
  const readKey = readerId === null || readerId === checked ? null : JSON.stringify([href, readerId]);
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!readKey || attempted.current === readKey || router.state.location.href !== href) return;
    const current = source.getSnapshot();
    if (current.state !== 'signed-in' || current.observation.id !== readerId) return;
    attempted.current = readKey;
    void router.invalidate();
  }, [href, readKey, readerId, router, source]);
  return readKey && attempted.current !== readKey ? <PendingPage /> : <NotFoundPage />;
}
