import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import { realmMembersLifetimeSource } from './lifetime';
import { RealmMembersPage } from './page';
const serverRevision = () => 0;

/** Caller lifetime is independent of native enumeration admission. The default source remains unavailable. */
export function RealmMembersPanel({ realmId }: { realmId: string }) {
  const client = useQueryClient();
  const session = useSession();
  const source = useMemo(() => realmMembersLifetimeSource(client, session.subject), [client, session.subject]);
  const revision = useSyncExternalStore(source.subscribe, source.snapshot, serverRevision);
  const locale = getLocale();
  const { state, subject, csrfToken } = session;
  const caller = useMemo(
    () => source.capture({ state, subject: subject ?? null, csrfToken }, () => getLocale() === locale),
    [source, revision, locale, state, subject, csrfToken],
  );
  const previous = useRef(caller);
  if (previous.current !== caller) {
    previous.current.retire();
    previous.current = caller;
  }
  return <RealmMembersPage realmId={realmId} caller={caller} locale={locale} />;
}
