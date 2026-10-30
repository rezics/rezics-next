import { useEffect, useState, useSyncExternalStore } from 'react';
import { useSession } from '../../session/query';
import { readAccountErasure } from './actions';
import { ErasureProgressView } from './view';
import { ErasureReader } from './reader';

export function AccountErasurePage({ accountId }: { accountId: string }) {
  const session = useSession();
  return session.state === 'signed-in' && session.subject ? (
    <BoundErasure
      key={`${accountId}:${session.subject}:${session.csrfToken ?? ''}`}
      accountId={accountId}
      viewerId={session.subject}
    />
  ) : (
    <ErasureProgressView
      page={{
        status: session.state === 'unknown' ? 'loading' : session.state === 'signed-out' ? 'signed-out' : 'unavailable',
      }}
    />
  );
}
function BoundErasure({ accountId, viewerId }: { accountId: string; viewerId: string }) {
  const [reader] = useState(
    () => new ErasureReader({ accountId, viewerId }, () => readAccountErasure({ data: { accountId, viewerId } })),
  );
  useEffect(() => {
    void reader.reload();
    return () => reader.clear();
  }, [reader]);
  const page = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  return <ErasureProgressView page={page} reload={() => void reader.reload()} />;
}
