import type { ReactNode, Ref } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { ImportJourney } from '../personal-list-import/presentation';
import type { AniListCompleteness } from './contract';
import type { AniListStage } from './controller';
import { aniListWrapperLabel } from './meaning';

/** Local presentation frame for the mounted, private AniList import journey. */
export function AniListWorkspace({
  stage,
  focusRef,
  completeness,
  primaryAction,
  secondaryActions,
  children,
}: {
  stage: AniListStage;
  focusRef: Ref<HTMLDivElement>;
  completeness: AniListCompleteness | null;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <header className="space-y-5 rounded-xl border bg-card p-4 sm:p-6">
        <PageHeading>{m.library_anilist_title()}</PageHeading>
        <div ref={focusRef} tabIndex={-1} className="space-y-1 focus-visible:outline-2 focus-visible:outline-ring">
          <ImportJourney stage={stage} />
        </div>
        {completeness ? (
          <div className="min-w-0 space-y-1 border-t pt-4 text-sm" data-anilist-upload-scope>
            <p className="text-muted-foreground">
              {aniListWrapperLabel(completeness)}
              {completeness.hasNextChunk ? ` · ${m.library_anilist_completeness_chunk()}` : ''}
            </p>
            <p className="text-muted-foreground">
              {completeness.hasNextChunk ? m.library_anilist_slice() : m.library_anilist_not_complete()}
            </p>
          </div>
        ) : null}
      </header>

      {children}

      {primaryAction ? (
        <div className="flex flex-col items-start gap-3 border-t pt-5 sm:flex-row sm:items-center" data-anilist-primary-action>
          {primaryAction}
        </div>
      ) : null}
      {secondaryActions ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-4" data-anilist-secondary-actions>
          {secondaryActions}
        </div>
      ) : null}
    </main>
  );
}
