import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import { realmMembersLifetimeSource } from './lifetime';
import { browserRealmMembersSource } from './native-source';
import { RealmMembersPage } from './page';
const serverRevision = () => 0;

/** Caller lifetime is independent of native enumeration admission; the source binds the admitted session viewer. */
export function RealmMembersPanel({ realmId }: { realmId: string }) {
  const client = useQueryClient();
  const session = useSession();
  const { state, subject, csrfToken } = session;
  const lifetime = useMemo(() => realmMembersLifetimeSource(client, subject), [client, subject]);
  const pageSource = useMemo(() => browserRealmMembersSource(subject, csrfToken), [subject, csrfToken]);
  const revision = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, serverRevision);
  const locale = getLocale();
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
