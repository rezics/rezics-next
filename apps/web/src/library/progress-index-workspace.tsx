import type { MouseEventHandler, ReactNode, RefObject } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';

/** Stable presentation shell for the mounted progress directory and its start workspace. */
export function ProgressIndexWorkspace({
  currentWork,
  discovery,
  loadingStatus,
  returnRecovery,
  sessionsHeading,
  sessionContent,
  windowControls,
  startContent,
  startOpen,
  onClickCapture,
}: {
  currentWork?: ReactNode;
  discovery: ReactNode;
  loadingStatus?: ReactNode;
  returnRecovery?: ReactNode;
  sessionsHeading: RefObject<HTMLHeadingElement | null>;
  sessionContent: ReactNode;
  windowControls?: ReactNode;
  startContent: ReactNode;
  startOpen: boolean;
  onClickCapture?: MouseEventHandler<HTMLElement>;
}) {
  return (
    <article className="max-w-7xl space-y-6 text-foreground" onClickCapture={onClickCapture}>
      <PageHeading>{m.library_progress_heading()}</PageHeading>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)] lg:items-start">
        <section
          aria-labelledby="progress-discovery-heading"
          className="min-w-0 space-y-4 rounded-xl border border-border p-4 sm:p-5 lg:col-span-2"
        >
          <h2 id="progress-discovery-heading" className="font-semibold">
            {m.library_progress_discovery_search()}
          </h2>
          {currentWork}
          {discovery}
        </section>

        <section aria-labelledby="progress-index-sessions-heading" className="min-w-0 space-y-4">
          <h2
            id="progress-index-sessions-heading"
            ref={sessionsHeading}
            tabIndex={-1}
            className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.library_progress_index_list_heading()}
          </h2>
          {loadingStatus}
          {returnRecovery}
          {sessionContent}
          {windowControls}
        </section>

        <section aria-labelledby="start-progress-heading" className="min-w-0">
          <details
            data-progress-start=""
            open={startOpen || undefined}
            className="rounded-xl border border-border p-4 sm:p-5"
          >
            <summary
              id="start-progress-heading"
              className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.library_progress_start_heading()}
            </summary>
            <div className="space-y-5 pt-4">{startContent}</div>
          </details>
        </section>
      </div>
    </article>
  );
}
