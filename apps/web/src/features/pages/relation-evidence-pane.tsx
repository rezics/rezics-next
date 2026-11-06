import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';
import { relationHistoryFailure } from './relation-history-pane';
import { qualifiedNotes } from './qualified-relations';
import { loadRelationEvidence, type RelationEvidenceCandidate, type RelationEvidenceRead } from './relation-evidence';
import type { Stmt } from './shared';

const actionClass =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal [overflow-wrap:anywhere] px-4 py-3 text-center focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';

type PaneState = {
  candidates: RelationEvidenceCandidate[];
  next: string | null;
  loading: boolean;
  failed: boolean;
  status: number | undefined;
};

const initial: PaneState = { candidates: [], next: null, loading: true, failed: false, status: undefined };

function applyRead(previous: PaneState, read: RelationEvidenceRead, append: boolean): PaneState {
  if (read.kind === 'ready')
    return {
      candidates: append
        ? [
            ...previous.candidates,
            ...read.candidates.filter((row) => !previous.candidates.some((seen) => seen.id === row.id)),
          ]
        : read.candidates,
      next: read.next,
      loading: false,
      failed: false,
      status: undefined,
    };
  // A failed window keeps the candidates already shown and its continuation.
  return { ...previous, loading: false, failed: true, status: read.status };
}

function decisionLabel(decision: RelationEvidenceCandidate['decision'], locale: string): string | undefined {
  const options = { locale: locale as never };
  if (decision === 'accepted') return m.relation_evidence_accepted({}, options);
  if (decision === 'rejected') return m.relation_evidence_rejected({}, options);
  if (decision === 'abstained') return m.relation_evidence_abstained({}, options);
  return undefined;
}

function rankLabel(rank: RelationEvidenceCandidate['rank'], locale: string): string | undefined {
  const options = { locale: locale as never };
  if (rank === 'preferred') return m.candidate_rank_preferred({}, options);
  if (rank === 'normal') return m.candidate_rank_normal({}, options);
  if (rank === 'deprecated') return m.changes_rank_deprecated({}, options);
  return undefined;
}

/** Each original citation is one reference group; its text values are the citation text. */
function citations(statement: Stmt): string[][] {
  return statement.references.flatMap((reference) => {
    const values = reference.parts.flatMap((part) =>
      typeof part.value.content === 'string' && part.value.content ? [part.value.content] : [],
    );
    return values.length ? [values] : [];
  });
}

/** The competing candidates of one relation slot, beyond the window's preview. Continuation keeps the exact slot. */
export function RelationEvidencePane({
  subject,
  locale,
  reader,
  property,
  target,
  slotKey,
  close,
}: {
  subject: string;
  locale: string;
  reader: string | null;
  property: string;
  target: string;
  slotKey?: string | undefined;
  close: string;
}) {
  const [state, setState] = useState<PaneState>(initial);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setState(initial);
    loadRelationEvidence({ data: { subject, locale, reader, property, target, key: slotKey } }).then(
      (read) => {
        if (current === generation.current) setState((previous) => applyRead(previous, read, false));
      },
      () => {
        if (current === generation.current)
          setState((previous) => applyRead(previous, { kind: 'failure', status: undefined }, false));
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [subject, locale, reader, property, target, slotKey]);

  const more = (event: MouseEvent<HTMLButtonElement>, cursor: string) => {
    event.preventDefault();
    const current = generation.current;
    setState((previous) => ({ ...previous, loading: true, failed: false }));
    loadRelationEvidence({ data: { subject, locale, reader, property, target, key: slotKey, cursor } }).then(
      (read) => {
        if (current === generation.current) setState((previous) => applyRead(previous, read, true));
      },
      () => {
        if (current === generation.current)
          setState((previous) => applyRead(previous, { kind: 'failure', status: undefined }, true));
      },
    );
  };

  const options = { locale: locale as never };
  return (
    <section data-slot="relation-evidence" aria-labelledby="relation-evidence-title" className="min-w-0 space-y-4">
      <h2 id="relation-evidence-title" className="text-2xl font-semibold tracking-tight">
        {m.relation_evidence_title({}, options)}
      </h2>
      <a
        data-slot="relation-evidence-close"
        href={close}
        className={cn(buttonVariants({ variant: 'link' }), actionClass)}
      >
        {m.relation_evidence_close({}, options)}
      </a>
      {state.loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.changes_loading({}, options)}
        </p>
      ) : null}
      {state.failed ? <p role="alert">{relationHistoryFailure(state.status, locale)}</p> : null}
      {!state.loading && !state.failed && state.candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.relation_evidence_empty({}, options)}</p>
      ) : null}
      {state.candidates.length > 0 ? (
        <ol data-slot="relation-evidence-candidates" className="space-y-4">
          {state.candidates.map((candidate) => {
            const notes = qualifiedNotes(candidate.statement, {}, locale);
            const groups = citations(candidate.statement);
            const labels = [
              decisionLabel(candidate.decision, locale),
              rankLabel(candidate.rank, locale),
              candidate.retracted ? m.relation_evidence_retracted({}, options) : undefined,
            ].filter((label): label is string => label !== undefined);
            return (
              <li key={candidate.id} data-slot="relation-evidence-candidate" className="min-w-0 space-y-2">
                <p className="text-sm font-medium">
                  {m.changes_revision({ revision: candidate.revision }, options)}
                  {labels.length ? ` · ${labels.join(' · ')}` : ''}
                </p>
                {notes.map((note, index) => (
                  <p key={index} className="text-sm text-muted-foreground">
                    {note.text}
                  </p>
                ))}
                {groups.length ? (
                  <section className="space-y-1">
                    <h3 className="text-sm font-medium">{m.relation_evidence_citations({}, options)}</h3>
                    <ol className="space-y-1">
                      {groups.map((values, index) => (
                        <li key={index} className="text-sm [overflow-wrap:anywhere]">
                          {values.join(' · ')}
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {state.next ? (
        <button
          type="button"
          data-slot="relation-evidence-more"
          className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
          onClick={(event) => more(event, state.next!)}
        >
          {m.subject_section_more({ label: m.relation_evidence_title({}, options) }, options)}
        </button>
      ) : null}
    </section>
  );
}
