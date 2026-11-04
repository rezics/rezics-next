import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { threadLocation } from './thread-href';

export function ThreadPageError({ threadId, boardReturn }: { threadId: string; boardReturn?: string | undefined }) {
  return (
    <section className="min-w-0 space-y-4 p-4" role="alert">
      <h1>{m.error_heading()}</h1>
      <p>{m.thread_page_invalid_cursor()}</p>
      <a
        className={buttonVariants({ variant: 'outline', size: 'lg' })}
        href={threadLocation(getLocale(), { id: threadId }, undefined, undefined, undefined, boardReturn)}
      >
        {m.thread_page_restart()}
      </a>
    </section>
  );
}
