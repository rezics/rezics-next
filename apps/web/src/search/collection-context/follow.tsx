import { useState } from 'react';
import { FollowControl, type FollowWriteInput, type FollowWriteResult } from '../../library/follow-control';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { ExpectedReader } from '../../session/expected-reader';
import type { InferOutput } from 'valibot';
import type { collectionFollows } from './schema';

type Row = Extract<InferOutput<typeof collectionFollows>, { state: 'current' }>['rows'][number];
/** Fed by the private page, with no per-target state read. The parent permanently retires old readers. */
export function CollectionFollowControl({
  row,
  binding,
  lifetime,
  current,
  locale,
  write,
  rowKey,
  title,
  reviewed,
  refresh,
}: {
  row: Row;
  binding: ExpectedReader;
  lifetime: string;
  current: () => boolean;
  locale: string;
  write: (input: FollowWriteInput & ExpectedReader) => Promise<FollowWriteResult>;
  rowKey: string;
  title: string;
  reviewed: boolean;
  refresh: (suppress: boolean) => Promise<void>;
}) {
  const [uncertain, setUncertain] = useState(false);
  const [denied, setDenied] = useState(false);
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  return (
    <div data-slot="collection-follow" data-discovery-personal-row={rowKey}>
      {reviewed ? <p role="status">{m.library_follow_conflict_recovery_ready({}, options)}</p> : null}
      <FollowControl
        targetId={row.targetId}
        initial={{ state: 'ready', following: row.following }}
        canFollow={row.actions.follow}
        canRemove={row.actions.unfollow}
        ready={!denied && current()}
        locale={options.locale}
        labelContext={`${title} (${row.targetId})`}
        onAccepted={() => {
          void refresh(true);
          return false;
        }}
        onReview={async () => {
          await refresh(false);
          return null;
        }}
        readLifetime={lifetime}
        isCurrent={() => current()}
        write={async (input) => {
          if (!current()) return { ok: false, reason: 'unavailable' };
          const result = await write({ ...input, ...binding }).catch((): FollowWriteResult => ({
            ok: false,
            reason: 'unavailable',
          }));
          if (!current()) return { ok: false, reason: 'unavailable' };
          setUncertain(!result.ok && result.reason === 'unavailable');
          // Only a definitive denial closes admission. Transport uncertainty belongs to native intent.
          if (!result.ok && result.reason !== 'unavailable' && result.reason !== 'conflict') setDenied(true);
          return result;
        }}
      />
      {uncertain ? <p role="status">{m.discovery_collection_follow_uncertain({}, options)}</p> : null}
      {!row.actions.follow && !row.actions.unfollow ? (
        <p role="status">{m.library_follow_forbidden({}, options)}</p>
      ) : null}
    </div>
  );
}
