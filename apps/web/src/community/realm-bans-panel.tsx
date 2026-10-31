import { useCallback } from 'react';
import { useSession } from '../session/query';
import { changeRealmBan, readRealmBans } from './space-actions';
import { RealmBansControl } from './realm-bans-control';
import type { BanWriteInput, BanWriteResult } from './realm-bans';

/** The page supplies only the Realm anchor. Native list and commands decide current authority. */
export function RealmBansPanel({ realmId }: { realmId: string }) {
  const { state, csrfToken, subject } = useSession();
  const read = useCallback(
    (cursor?: string) => readRealmBans({ data: { realmId, ...(cursor ? { cursor } : {}) } }),
    [realmId],
  );
  const write = useCallback(
    (input: BanWriteInput): Promise<BanWriteResult> => {
      if (!csrfToken) return Promise.resolve({ ok: false, reason: 'signed-out' });
      return changeRealmBan({ data: input, headers: { 'X-CSRF-Token': csrfToken } });
    },
    [csrfToken],
  );
  if (state !== 'signed-in' || !subject) return null;
  return (
    <RealmBansControl
      key={`${realmId}:${subject}`}
      realmId={realmId}
      read={read}
      write={write}
      ready={csrfToken !== null}
    />
  );
}
