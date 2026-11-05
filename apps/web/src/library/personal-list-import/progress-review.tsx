import { useEffect, useId, useState } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import type { VndbReviewInput, VndbRow } from './contract';
import { VndbAction, VndbCheck } from './controls';
import { readVndbOccurrences } from './server';
import { useVndbVisit } from './visit';

type ProgressInput = Extract<VndbReviewInput, { action: 'progress' }>['progress'];
type Occurrences = Awaited<ReturnType<typeof readVndbOccurrences>>;

export function VndbProgressReview({
  row,
  targetId,
  busy,
  onReview,
}: {
  row: VndbRow;
  targetId: string | null;
  busy: boolean;
  onReview: (body: VndbReviewInput) => void;
}) {
  const id = useId();
  const visit = useVndbVisit();
  const [current, setCurrent] = useState<Occurrences | null>(null);
  const [occurrence, setOccurrence] = useState('');
  const [action, setAction] = useState<'adopt' | 'clear'>('adopt');
  const [replace, setReplace] = useState(false);
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    let active = true;
    setCurrent(null);
    setOccurrence('');
    setConsent(false);
    setReplace(false);
    if (targetId && visit)
      void readVndbOccurrences({ data: { targetId, sender: visit.subject } }).then((value) => {
        if (active && visit.current()) setCurrent(value);
      });
    return () => {
      active = false;
    };
  }, [targetId, visit]);
  const sessions = current?.kind === 'occurrences' ? current.sessions : [];
  const eligible = sessions.filter(
    (session) =>
      session.state === 'active' &&
      session.mode === 'scalar_amount' &&
      (session.unit === 'minute' || session.measures?.some((measure) => measure.unit === 'minute')),
  );
  const progress = row.decision?.progress;
  function save() {
    const selected: ProgressInput['occurrence'] =
      occurrence === 'start' ? { kind: 'start', primaryUnit: 'minute' } : { kind: 'existing', sessionId: occurrence };
    onReview({
      ordinal: row.ordinal,
      action: 'progress',
      targetId: targetId!,
      progress: {
        occurrence: selected,
        measures: [{ field: 'minutes', action, ...(action === 'adopt' ? { replace } : {}) }],
      },
    });
  }
  return (
    <section className="space-y-3 rounded-md border p-3" data-vndb-progress-review>
      <h4 className="font-medium">{m.library_vndb_progress_title()}</h4>
      <p>{m.library_vndb_progress_help()}</p>
      <Field>
        <FieldLabel htmlFor={`${id}-occurrence`}>{m.library_vndb_progress_occurrence()}</FieldLabel>
        <select
          id={`${id}-occurrence`}
          className="min-h-11 w-full rounded-md border bg-background px-3"
          disabled={busy || !targetId}
          value={occurrence}
          onChange={(event) => {
            setOccurrence(event.currentTarget.value);
            setAction('adopt');
            setConsent(false);
          }}
        >
          <option value="">{m.library_vndb_progress_choose()}</option>
          <option value="start">{m.library_vndb_progress_start()}</option>
          {eligible.map((session) => (
            <option key={session.id} value={session.id}>
              {session.startedAt} ·{' '}
              {(session.unit === 'minute'
                ? session.amount
                : session.measures?.find((measure) => measure.unit === 'minute')?.amount) ?? '—'}{' '}
              minute · {session.id}
            </option>
          ))}
        </select>
      </Field>
      {current?.kind === 'unavailable' ? <p role="status">{m.library_vndb_progress_read_unavailable()}</p> : null}
      {current?.kind === 'occurrences' && current.next ? <p>{m.library_vndb_progress_more()}</p> : null}
      {occurrence && occurrence !== 'start' ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-action`}>{m.library_vndb_review_action()}</FieldLabel>
            <select
              id={`${id}-action`}
              className="min-h-11 w-full rounded-md border bg-background px-3"
              value={action}
              disabled={busy}
              onChange={(event) => {
                setAction(event.currentTarget.value as 'adopt' | 'clear');
                setConsent(false);
              }}
            >
              <option value="adopt">{m.library_vndb_progress_adopt()}</option>
              <option value="clear">{m.library_vndb_progress_clear()}</option>
            </select>
          </Field>
          {action === 'adopt' ? (
            <VndbCheck
              id={`${id}-replace`}
              checked={replace}
              disabled={busy}
              label={m.library_vndb_progress_replace()}
              onToggle={(value) => {
                setReplace(value);
                setConsent(false);
              }}
            />
          ) : null}
        </>
      ) : null}
      <VndbCheck
        id={`${id}-consent`}
        checked={consent}
        disabled={busy || !occurrence}
        label={m.library_vndb_progress_consent()}
        onToggle={setConsent}
      />
      <VndbAction type="button" disabled={busy || !targetId || !occurrence || !consent} onClick={save}>
        {m.library_bangumi_save_review()}
      </VndbAction>
      {progress ? (
        <ul className="space-y-1" data-vndb-progress-outcomes>
          {progress.measures.map((measure) => (
            <li key={measure.field}>
              {measure.field}: {measure.status} · {measure.currentAmount ?? '—'} {measure.unit}
              {measure.reason ? ` · ${measure.reason}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
