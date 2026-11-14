import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import type { RecoveryCollection } from './contract';

type RecoveryWorkspaceStage =
  | 'upload'
  | 'collections'
  | 'occurrences'
  | 'review'
  | 'results'
  | 'conflict'
  | 'expired'
  | 'denied'
  | 'unavailable';

const steps = ['upload', 'collections', 'occurrences', 'review', 'results'] as const;

function stepFor(stage: RecoveryWorkspaceStage): (typeof steps)[number] {
  if (stage === 'conflict' || stage === 'expired' || stage === 'denied' || stage === 'unavailable') {
    return 'results';
  }
  return stage;
}

function stepLabel(step: (typeof steps)[number]) {
  switch (step) {
    case 'upload':
      return m.library_archive_recovery_step_upload();
    case 'collections':
      return m.library_archive_recovery_step_collection();
    case 'occurrences':
      return m.library_archive_recovery_step_occurrences();
    case 'review':
      return m.library_archive_recovery_step_review();
    case 'results':
      return m.library_archive_recovery_step_results();
  }
}

function stageLabel(stage: RecoveryWorkspaceStage) {
  switch (stage) {
    case 'upload':
      return m.library_archive_recovery_upload_title();
    case 'collections':
      return m.library_archive_recovery_collections_title();
    case 'occurrences':
      return m.library_archive_recovery_occurrences_title();
    case 'review':
      return m.library_archive_recovery_review_title();
    case 'conflict':
      return m.library_archive_recovery_conflict_title();
    case 'expired':
      return m.library_archive_recovery_expired_title();
    case 'denied':
      return m.library_archive_recovery_denied();
    case 'unavailable':
      return m.library_archive_recovery_unavailable();
    case 'results':
      return m.library_archive_recovery_result_title();
  }
}

export function ArchiveCollectionWorkspace({
  routeHeading,
  stage,
  collection,
  primaryAction,
  children,
}: {
  routeHeading: ReactNode;
  stage: RecoveryWorkspaceStage;
  collection: RecoveryCollection | null;
  primaryAction?: ReactNode;
  children: ReactNode;
}) {
  const currentStep = stepFor(stage);

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-6">
      <header className="grid gap-5">
        {routeHeading}
        <nav aria-label={m.library_archive_recovery_steps()}>
          <ol className="flex flex-wrap gap-2 text-sm">
            {steps.map((step, index) => (
              <li key={step} aria-current={currentStep === step ? 'step' : undefined}>
                <span
                  className={`inline-flex min-h-11 items-center rounded-full border px-3 ${currentStep === step ? 'border-primary bg-primary/10 font-semibold' : ''}`}
                >
                  {index + 1}. {stepLabel(step)}
                </span>
              </li>
            ))}
          </ol>
        </nav>
      </header>

      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(14rem,0.72fr)_minmax(0,2fr)]">
        <aside className="grid min-w-0 content-start gap-4 rounded-xl border p-4 sm:p-6">
          <h2 className="text-lg font-semibold">{stageLabel(stage)}</h2>
          {collection ? (
            <section
              className="grid min-w-0 gap-2 rounded-lg bg-muted/40 p-3"
              aria-label={m.library_archive_recovery_selected_label()}
            >
              <p className="text-xs font-medium text-muted-foreground">{m.library_archive_recovery_selected_label()}</p>
              <p className="break-words font-medium">
                {collection.title || m.library_archive_recovery_untitled()}
              </p>
              {collection.description ? (
                <p className="whitespace-pre-wrap break-words text-sm">{collection.description}</p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                {m.library_archive_recovery_collection_members({ count: collection.memberCount })}
                {' · '}
                {collection.orderComplete
                  ? m.library_archive_recovery_order_available()
                  : m.library_archive_recovery_order_incomplete()}
              </p>
              <p className="text-sm">{m.library_archive_recovery_destination_private()}</p>
            </section>
          ) : null}
          {primaryAction ? <div className="grid gap-2">{primaryAction}</div> : null}
        </aside>

        <section className="grid min-w-0 gap-5" aria-label={stepLabel(currentStep)}>
          {children}
        </section>
      </div>
    </main>
  );
}
