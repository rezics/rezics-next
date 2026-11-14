import { createContext, useContext, useEffect, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { CollectionTypeOption } from '../collection-presentation';
import { ReleasedTypeChoices } from '../collection-presentation-review/type-options';
import type {
  RecoveryPresentationChoice,
  RecoveryPresentationEvidence,
  RecoveryStatus,
} from './contract';

async function readPresentationTypes(): Promise<readonly CollectionTypeOption[] | null> {
  const { readArchiveRecoveryPresentationTypes } = await import('./server');
  return readArchiveRecoveryPresentationTypes();
}

export const RecoveryPresentationTypesContext = createContext(readPresentationTypes);

function sourceText(source: RecoveryStatus['presentation']['source']): string {
  switch (source) {
    case 'mixed':
      return m.library_archive_recovery_presentation_source_mixed();
    case 'archived':
      return m.library_archive_recovery_presentation_source_archived();
    case 'alternative':
      return m.library_archive_recovery_presentation_source_alternative();
    case null:
      return m.library_archive_recovery_presentation_source_unreviewed();
  }
}

/** Show sealed identity directly. Current release labels cannot rename an earlier review or effect. */
export function RecoveryPresentationSummary({
  choice,
}: {
  choice: Pick<RecoveryStatus['presentation'], 'kind' | 'source' | 'releaseDigest'>;
}) {
  return (
    <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2" data-recovery-presentation-choice>
      <div className="grid min-w-0 gap-1">
        <dt className="font-medium">{m.library_archive_recovery_presentation_kind()}</dt>
        <dd className="[overflow-wrap:anywhere]">{choice.kind ?? m.library_collection_mixed_label()}</dd>
      </div>
      <div className="grid min-w-0 gap-1">
        <dt className="font-medium">{m.library_archive_recovery_presentation_source()}</dt>
        <dd>{sourceText(choice.source)}</dd>
      </div>
      <div className="grid min-w-0 gap-1 sm:col-span-2">
        <dt className="font-medium">{m.library_archive_recovery_presentation_release()}</dt>
        <dd className="[overflow-wrap:anywhere]">
          {choice.releaseDigest ?? m.library_archive_recovery_presentation_no_release()}
        </dd>
      </div>
    </dl>
  );
}

export function RecoverySealedPresentation({ choice }: { choice: RecoveryPresentationChoice }) {
  return (
    <section className="grid min-w-0 gap-3 rounded-lg border p-4" data-recovery-presentation="sealed">
      <h4 className="font-semibold">{m.library_archive_recovery_presentation_sealed()}</h4>
      <RecoveryPresentationSummary choice={choice} />
      <p className="text-sm text-muted-foreground">{m.library_archive_recovery_presentation_sealed_help()}</p>
    </section>
  );
}

function archivedDisposition(evidence: RecoveryPresentationEvidence): string {
  switch (evidence.presentationDisposition) {
    case 'none':
      return m.library_archive_recovery_presentation_archived_none();
    case 'available_explicit_choice':
      return m.library_archive_recovery_presentation_archived_available();
    case 'unsupported_current_meaning':
      return m.library_archive_recovery_presentation_archived_unsupported();
    default:
      return m.library_archive_present_unknown();
  }
}

export function RecoveryPresentationChoices({
  kind,
  evidence,
  disabled,
  onChange,
}: {
  kind: string | null;
  evidence: RecoveryPresentationEvidence | null;
  disabled: boolean;
  onChange: (kind: string | null) => void;
}) {
  const readTypes = useContext(RecoveryPresentationTypesContext);
  const [types, setTypes] = useState<readonly CollectionTypeOption[] | null>(null);
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setPending(true);
    void readTypes().then(
      (value) => {
        if (!current) return;
        setTypes(value);
        setPending(false);
      },
      () => {
        if (!current) return;
        setTypes(null);
        setPending(false);
      },
    );
    return () => {
      current = false;
    };
  }, [readTypes, attempt]);

  return (
    <section className="grid min-w-0 gap-4 rounded-xl border p-4" aria-labelledby="recovery-presentation-title">
      <h3 id="recovery-presentation-title" className="font-semibold">
        {m.library_archive_recovery_presentation_title()}
      </h3>
      <p className="text-sm">{m.library_archive_recovery_presentation_choice_help()}</p>
      {evidence ? (
        <div className="grid min-w-0 gap-2 rounded-lg bg-muted/40 p-3" data-archived-presentation>
          <p className="text-sm [overflow-wrap:anywhere]">
            <span className="font-medium">{m.library_archive_recovery_presentation_archived()}: </span>
            {evidence.presentationKind ?? m.library_collection_mixed_label()}
          </p>
          <p className="text-sm">{archivedDisposition(evidence)}</p>
        </div>
      ) : null}
      {pending ? <p role="status">{m.library_archive_recovery_presentation_loading()}</p> : null}
      <ReleasedTypeChoices
        types={types}
        kind={kind}
        savedKind={null}
        members={[]}
        listPresentations={undefined}
        disabled={disabled || pending}
        onChange={onChange}
        name="archive-recovery-presentation"
      />
      {!pending && types === null ? (
        <button
          type="button"
          className="min-h-11 w-fit max-w-full rounded-md border px-4 py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          disabled={disabled}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {m.library_archive_recovery_presentation_retry_types()}
        </button>
      ) : null}
    </section>
  );
}

function outcomeText(state: RecoveryStatus['presentation']['state']): string {
  switch (state) {
    case 'mixed':
      return m.library_archive_recovery_presentation_mixed();
    case 'adopted':
      return m.library_archive_recovery_presentation_adopted();
    case 'unsupported_or_stale':
      return m.library_archive_recovery_presentation_stale();
    case 'unattempted':
      return m.library_archive_recovery_presentation_unattempted();
  }
}

export function RecoveryPresentationOutcome({ presentation }: { presentation: RecoveryStatus['presentation'] }) {
  return (
    <section
      className="grid min-w-0 gap-3 rounded-xl border p-4"
      aria-labelledby="recovery-presentation-result-title"
      data-recovery-presentation={presentation.state}
    >
      <h3 id="recovery-presentation-result-title" className="font-semibold">
        {m.library_archive_recovery_presentation_result()}
      </h3>
      <p role="status">{outcomeText(presentation.state)}</p>
      <RecoveryPresentationSummary choice={presentation} />
      {presentation.state === 'unsupported_or_stale' ? (
        <p className="text-sm">{m.library_archive_recovery_presentation_stale_help()}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.library_archive_recovery_presentation_partial_scope()}</p>
    </section>
  );
}
