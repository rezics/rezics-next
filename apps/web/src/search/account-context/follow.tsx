import { FollowControl } from '../../library/follow-control';
import type { FollowWriteInput, FollowWriteResult } from '../../library/follow-records';
import type { ExpectedReader } from '../../session/expected-reader';
import type { InferOutput } from 'valibot';
import type { collectionFollows } from '../collection-context/schema';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';

/** Uncertain responses retain FollowControl's original intent/key for exact retry.
 * The mounted host owns retirement; this control never reads a relationship itself.
 */
export function AccountFollowControl({
  row,
  binding,
  lifetime,
  current,
  locale,
  write,
  rowKey,
}: {
  row: Extract<InferOutput<typeof collectionFollows>, { state: 'current' }>['rows'][number];
  binding: ExpectedReader;
  lifetime: string;
  current: () => boolean;
  locale: string;
  write: (input: FollowWriteInput & ExpectedReader) => Promise<FollowWriteResult>;
  rowKey: string;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  return (
    <div data-slot="account-follow" data-discovery-personal-row={rowKey}>
      <FollowControl
        targetId={row.targetId}
        initial={{ state: 'ready', following: row.following }}
        canFollow={row.actions.follow}
        canRemove={row.actions.unfollow}
        ready={current()}
        readLifetime={lifetime}
        isCurrent={current}
        write={async (input) => {
          if (!current()) return { ok: false, reason: 'unavailable' };
          const result = await write({ ...input, ...binding });
          return current() ? result : { ok: false, reason: 'unavailable' };
        }}
      />
      {!row.actions.follow && !row.actions.unfollow ? (
        <p role="status">{m.library_follow_forbidden({}, options)}</p>
      ) : null}
    </div>
  );
}
