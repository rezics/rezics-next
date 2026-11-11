import { useEffect, useId, useState } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
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
  const occurrenceOptions = [
    { value: null, label: m.library_vndb_progress_choose() },
    { value: 'start', label: m.library_vndb_progress_start() },
    ...eligible.map((session) => ({
      value: session.id,
      label: `${session.startedAt} · ${
        (session.unit === 'minute'
          ? session.amount
          : session.measures?.find((measure) => measure.unit === 'minute')?.amount) ?? '—'
      } minute · ${session.id}`,
    })),
  ];
  const progressActionOptions = [
    { value: 'adopt', label: m.library_vndb_progress_adopt() },
    { value: 'clear', label: m.library_vndb_progress_clear() },
  ];
  return (
    <section className="space-y-3 rounded-md border p-3" data-vndb-progress-review>
      <h4 className="font-medium">{m.library_vndb_progress_title()}</h4>
      <p>{m.library_vndb_progress_help()}</p>
      <Field>
        <FieldLabel id={`${id}-occurrence-label`} htmlFor={`${id}-occurrence`}>
          {m.library_vndb_progress_occurrence()}
        </FieldLabel>
        <Select<string, false>
          items={occurrenceOptions}
          disabled={busy || !targetId}
          value={occurrence || null}
          onValueChange={(value) => {
            setOccurrence(value ?? '');
            setAction('adopt');
            setConsent(false);
          }}
        >
          <SelectTrigger
            id={`${id}-occurrence`}
            aria-labelledby={`${id}-occurrence-label`}
            className="min-h-11 w-full rounded-md border bg-background px-3"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {occurrenceOptions.map(({ value, label, ...itemProps }) => (
                <SelectItem key={value ?? ''} value={value} {...itemProps}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {current?.kind === 'unavailable' ? <p role="status">{m.library_vndb_progress_read_unavailable()}</p> : null}
      {current?.kind === 'occurrences' && current.next ? <p>{m.library_vndb_progress_more()}</p> : null}
      {occurrence && occurrence !== 'start' ? (
        <>
          <Field>
            <FieldLabel id={`${id}-action-label`} htmlFor={`${id}-action`}>
              {m.library_vndb_review_action()}
            </FieldLabel>
            <Select<string, false>
              items={progressActionOptions}
              disabled={busy}
              value={action}
              onValueChange={(value) => {
                if (value === 'adopt' || value === 'clear') setAction(value);
                setConsent(false);
              }}
            >
              <SelectTrigger
                id={`${id}-action`}
                aria-labelledby={`${id}-action-label`}
                className="min-h-11 w-full rounded-md border bg-background px-3"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {progressActionOptions.map(({ value, label, ...itemProps }) => (
                    <SelectItem key={value ?? ''} value={value} {...itemProps}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
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
