import { useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { MalPreviewRow, MalReviewInput } from './contract';
import { MalAction, MalCheck } from './controls';
import {
  admittedFields,
  malKindLabel,
  malMatchLabel,
  malProgressEntries,
  malRetainReason,
  malScoreLabel,
  malValueLabel,
} from './meaning';
import { MalTargetSearch } from './target';

export type RowDraft = MalReviewInput & { fields: string[] };

export function draftFromRow(row: MalPreviewRow): RowDraft {
  const review = row.review;
  return {
    row: row.index,
    target: review?.target ?? row.target,
    skip: review?.skip ?? false,
    replace: review?.replace ?? false,
    fields: review ? (review.skip ? [] : admittedFields({ ...row, review })) : admittedFields(row),
  };
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="whitespace-normal [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

export function MalRowReview({
  row,
  busy,
  onSave,
}: {
  row: MalPreviewRow;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<RowDraft>(() => draftFromRow(row));
  const admitted = admittedFields(row);
  const canTarget = row.match === 'unmatched' || row.match === 'ambiguous';
  const selectable = !draft.skip && admitted.length > 0;
  return (
    <article className="space-y-4 rounded-lg border p-4" data-mal-row={row.index} data-mal-kind={row.kind}>
      <header className="space-y-1">
        <h3 className="text-lg font-medium [overflow-wrap:anywhere]">{row.title}</h3>
        <p className="text-sm text-muted-foreground">
          {malKindLabel(row.kind)} · {malMatchLabel(row.match, draft.skip)}
        </p>
        <p className="text-sm [overflow-wrap:anywhere]">
          {m.library_mal_identifier({ namespace: row.identifier.namespace, value: row.identifier.value })}
        </p>
      </header>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label={m.library_mal_status()} value={malValueLabel(row.status)} />
        <Fact label={m.library_mal_score()} value={malScoreLabel(row.score)} />
        {malProgressEntries(row).map((item) => (
          <Fact key={item.key} label={item.label} value={malValueLabel(item.value)} />
        ))}
        <Fact label={m.library_mal_started()} value={malValueLabel(row.dates.started ?? { kind: 'missing' })} />
        <Fact label={m.library_mal_finished()} value={malValueLabel(row.dates.finished ?? { kind: 'missing' })} />
        <Fact label={m.library_mal_repeats()} value={malValueLabel(row.repeats)} />
        <Fact label={m.library_mal_privacy()} value={malValueLabel(row.privacy)} />
      </dl>
      <p>{m.library_mal_not_vote()}</p>
      <p>{m.library_mal_not_session()}</p>
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_mal_notes_summary()}</summary>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{malValueLabel(row.notes)}</p>
        <p className="mt-2 text-sm text-muted-foreground">{m.library_mal_not_review()}</p>
      </details>
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_mal_retained_summary()}</summary>
        <ul className="mt-2 space-y-2">
          <li>
            {m.library_mal_tags()}: {malValueLabel(row.tags)}
          </li>
          {Object.entries(row.timestamps).map(([field, value]) => (
            <li key={field}>
              {field}: {malValueLabel(value)} · {m.library_mal_not_clock()}
            </li>
          ))}
          {row.retained.map((item) => (
            <li key={item.field}>
              {item.field}: {malRetainReason(item.reason)}
            </li>
          ))}
        </ul>
      </details>
      {row.current ? (
        <p>
          {m.library_mal_current({
            state: row.current.state,
            revision: row.current.revision,
          })}
        </p>
      ) : null}
      {row.state ? <p>{m.library_mal_proposed({ state: row.state })}</p> : <p>{m.library_mal_unsupported_status()}</p>}
      {row.review?.conflict ? <p>{m.library_mal_conflict_entry()}</p> : null}
      {canTarget && !draft.skip ? (
        <MalTargetSearch
          disabled={busy}
          value={draft.target}
          onChange={(target) => setDraft({ ...draft, target })}
        />
      ) : null}
      <MalCheck
        id={`${base}-skip`}
        checked={draft.skip}
        disabled={busy}
        label={m.library_mal_skip_row()}
        onToggle={(skip) => setDraft({ ...draft, skip, fields: skip ? [] : admitted })}
      />
      {row.review?.conflict || row.match === 'already-matched' ? (
        <MalCheck
          id={`${base}-replace`}
          checked={draft.replace}
          disabled={busy || draft.skip}
          label={m.library_mal_replace_current()}
          onToggle={(replace) => setDraft({ ...draft, replace })}
        />
      ) : null}
      {selectable ? (
        <MalCheck
          id={`${base}-status`}
          checked={draft.fields.includes('status')}
          disabled={busy}
          label={m.library_mal_select_status()}
          onToggle={(on) => setDraft({ ...draft, fields: on ? ['status'] : [] })}
        />
      ) : null}
      <MalAction type="button" disabled={busy} onClick={() => onSave(draft)}>
        {m.library_mal_save_review()}
      </MalAction>
    </article>
  );
}
