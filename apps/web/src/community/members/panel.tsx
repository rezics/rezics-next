import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import { realmMembersLifetimeSource } from './lifetime';
import { nativeRealmMembersSource } from './native-source';
import { RealmMembersPage } from './page';
const serverRevision = () => 0;

/** Caller lifetime is independent of native enumeration admission; the source binds the admitted session viewer. */
export function RealmMembersPanel({ realmId }: { realmId: string }) {
  const client = useQueryClient();
  const session = useSession();
  const lifetime = useMemo(() => realmMembersLifetimeSource(client, session.subject), [client, session.subject]);
  const pageSource = useMemo(() => nativeRealmMembersSource(session.subject), [session.subject]);
  const revision = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, serverRevision);
  const locale = getLocale();
  const { state, subject, csrfToken } = session;
  const caller = useMemo(
    () => lifetime.capture({ state, subject: subject ?? null, csrfToken }, () => getLocale() === locale),
    [lifetime, revision, locale, state, subject, csrfToken],
  );
  const previous = useRef(caller);
  if (previous.current !== caller) {
    previous.current.retire();
    previous.current = caller;
  }
  return <RealmMembersPage realmId={realmId} source={pageSource} caller={caller} locale={locale} />;
}
