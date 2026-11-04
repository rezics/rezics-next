import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { useSession } from '../../../session/query';
import { browserObservation } from '../../../session/observation';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { loadSubjectArtwork } from './actions';
import type { ArtworkTransport } from './read';

export const ArtworkReaderContext = createContext<{
  incarnation: unknown;
  read?: ArtworkTransport | undefined;
  current?: (() => boolean) | undefined;
}>({ incarnation: null });

/** Share the catalogue/session observation; metadata is independent of correction advice. */
export function SubjectArtworkSession({ locale, children }: { locale: string; children: ReactNode }) {
  const session = useSession();
  const client = useQueryClient();
  const store = browserObservation(client);
  const observation = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const lifetime = useCatalogueLifetime(
    JSON.stringify([locale, session.state, session.subject, session.csrfToken, observation]),
  );
  const expectedReader = session.state === 'signed-in' ? (session.subject ?? null) : null;
  const read = useCallback<ArtworkTransport>(
    async (id) => {
      if (!lifetime.active() || store.getSnapshot() !== observation) return { kind: 'unavailable' };
      try {
        return await loadSubjectArtwork({ data: { id, locale, expectedReader } });
      } catch {
        return { kind: 'unavailable' };
      }
    },
    [expectedReader, lifetime, locale, observation, store],
  );
  const admitted =
    session.state === 'signed-out' ||
    (session.state === 'signed-in' &&
      observation.state === 'signed-in' &&
      observation.observation.subject === expectedReader);
  return (
    <ArtworkReaderContext.Provider
      value={{
        incarnation: admitted ? lifetime.generation : null,
        read: admitted ? read : undefined,
        current: () => lifetime.active() && store.getSnapshot() === observation,
      }}
    >
      {children}
    </ArtworkReaderContext.Provider>
  );
}
