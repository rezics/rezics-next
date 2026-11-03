import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import { realmBanSessionSource } from '../realm-ban-lifetime';
import { RealmMembersPage } from './page';

// Observe exposure replacement without requesting roles, Accounts or another exposure read.
const exposures = new WeakMap<QueryClient, ReturnType<typeof exposureSource>>();
function exposureSource(client: QueryClient) {
  let revision = 0;
  let previous = client.getQueryState(['exposure', 'viewer']);
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== 2 || query.queryKey[0] !== 'exposure' || query.queryKey[1] !== 'viewer') return;
    const next = client.getQueryState(['exposure', 'viewer']);
    if (next === previous) return;
    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  return {
    snapshot: () => revision,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
const serverRevision = () => 0;

/** Caller lifetime is independent of native enumeration admission. The default source remains unavailable. */
export function RealmMembersPanel({ realmId }: { realmId: string }) {
  const client = useQueryClient();
  const session = useSession();
  const source = realmBanSessionSource(client);
  let exposure = exposures.get(client);
  if (!exposure) {
    exposure = exposureSource(client);
    exposures.set(client, exposure);
  }
  const revision = useSyncExternalStore(source.subscribe, source.snapshot, serverRevision);
  const exposureRevision = useSyncExternalStore(exposure.subscribe, exposure.snapshot, serverRevision);
  const locale = getLocale();
  const { state, subject, csrfToken } = session;
  const caller = useMemo(() => {
    let retired = false;
    return {
      current: () => {
        const observed = source.read();
        if (
          source.snapshot() !== revision ||
          exposure.snapshot() !== exposureRevision ||
          getLocale() !== locale ||
          state !== 'signed-in' ||
          !subject ||
          !csrfToken ||
          observed?.state !== state ||
          observed.subject !== subject ||
          observed.csrfToken !== csrfToken
        )
          retired = true;
        return !retired;
      },
      retire: () => {
        retired = true;
      },
      subscribe: (listener: () => void) => {
        const stopSession = source.subscribe(listener);
        const stopExposure = exposure.subscribe(listener);
        return () => {
          stopSession();
          stopExposure();
        };
      },
    };
  }, [source, revision, exposure, exposureRevision, locale, state, subject, csrfToken]);
  const previous = useRef(caller);
  if (previous.current !== caller) {
    previous.current.retire();
    previous.current = caller;
  }
  return <RealmMembersPage realmId={realmId} caller={caller} locale={locale} />;
}
