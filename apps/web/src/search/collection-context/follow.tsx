import { useState } from 'react';
import { FollowControl } from '../../library/follow-control';
import type { FollowWriteInput, FollowWriteResult } from '../../library/follow-records';
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
}: {
  row: Row;
  binding: ExpectedReader;
  lifetime: string;
  current: () => boolean;
  locale: string;
  write: (input: FollowWriteInput & ExpectedReader) => Promise<FollowWriteResult>;
}) {
  const [failed, setFailed] = useState(false);
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  return (
    <div data-slot="collection-follow">
      <FollowControl
        targetId={row.targetId}
        initial={failed ? { state: 'unavailable' } : { state: 'ready', following: row.following }}
        canFollow={row.actions.follow}
        canRemove={row.actions.unfollow}
        ready={!failed && current()}
        readLifetime={lifetime}
        isCurrent={() => current()}
        write={async (input) => {
          if (!current()) return { ok: false, reason: 'unavailable' };
          let result: FollowWriteResult;
          try {
            result = await write({ ...input, ...binding });
          } catch {
            result = { ok: false, reason: 'unavailable' };
          }
          if (!current()) return { ok: false, reason: 'unavailable' };
          if (!result.ok) setFailed(true);
          return result;
        }}
      />
      {failed ? <p role="alert">{m.library_follow_unavailable({}, options)}</p> : null}
      {!row.actions.follow && !row.actions.unfollow ? (
        <p role="status">{m.library_follow_forbidden({}, options)}</p>
      ) : null}
    </div>
  );
}
