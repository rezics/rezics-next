import { useState } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { formatConversationReplyCount, type ConversationActivityDisplay } from '../activity';
import { useThreadActivityCurrent } from './current';

/** Presentation only: the existing page reader owns admission, session retirement and refresh. */
export function ThreadActivity({
  activity,
  current,
  onRetry,
  isCurrent,
  queryKey,
  publication,
}: {
  activity: ConversationActivityDisplay | undefined;
  current: boolean;
  onRetry: () => Promise<unknown>;
  isCurrent: () => boolean;
  queryKey?: QueryKey | undefined;
  publication?: object;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const locale = getLocale();
  const options = { locale };
  const activityCurrent = useThreadActivityCurrent(publication ?? activity, queryKey);
  const visible = current && activityCurrent && !pending && !failed ? activity : undefined;

  async function retry() {
    if (pending || !current || !isCurrent()) return;
    setPending(true);
    setFailed(false);
    try {
      await onRetry();
    } catch {
      if (isCurrent()) setFailed(true);
    } finally {
      if (isCurrent()) setPending(false);
    }
  }

  return (
    <div
      data-slot="thread-activity"
      data-state={visible?.state ?? 'unavailable'}
      aria-busy={pending}
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-1 text-sm text-muted-foreground"
    >
      {visible?.state === 'current' ? (
        <>
          <span
            aria-label={
              visible.count.kind === 'lower-bound'
                ? m.board_thread_replies_lower_bound(
                    { count: new Intl.NumberFormat(locale).format(visible.count.value) },
                    options,
                  )
                : undefined
            }
          >
            {m.board_thread_replies({ count: formatConversationReplyCount(visible.count, locale) }, options)}
          </span>
          {visible.lastActivityAt !== null ? (
            <time dateTime={visible.lastActivityAt}>
              {m.board_thread_last_activity(
                {
                  time: new Intl.DateTimeFormat(locale, {
                    dateStyle: 'medium',
                    timeStyle: 'long',
                    timeZone: 'UTC',
                  }).format(new Date(visible.lastActivityAt)),
                },
                options,
              )}
            </time>
          ) : null}
        </>
      ) : (
        <>
          <span role="status">{m.board_thread_activity_unavailable({}, options)}</span>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={!current || pending}
            onClick={() => void retry()}
          >
            {m.thread_post_refresh({}, options)}
          </Button>
        </>
      )}
    </div>
  );
}
