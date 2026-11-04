import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { isThreadPageCursorError } from './thread-page-errors';
import { threadLocation } from './thread-href';

export function ThreadPageError({ error, threadId, retry }: { error: unknown; threadId: string; retry(): void }) {
  return (
    <section className="min-w-0 space-y-4 p-4" role="alert">
      <h1>{m.error_heading()}</h1>
      {isThreadPageCursorError(error) ? (
        <>
          <p>{m.thread_page_invalid_cursor()}</p>
          <a
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
            href={threadLocation(getLocale(), { id: threadId })}
          >
            {m.thread_page_restart()}
          </a>
        </>
      ) : (
        <>
          <p>{m.error_message()}</p>
          <Button onClick={retry}>{m.thread_write_retry()}</Button>
        </>
      )}
    </section>
  );
}
