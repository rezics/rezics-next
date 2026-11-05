import { useEffect, useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { MalAssignment, MalLabelReview, MalLabelSelection, MalPreviewRow } from './contract';
import { useMalImportPort } from './port';

/** Render only the native evidence projection. Never tokenize a display value or XML here. */
export function MalLabelsReview({
  row,
  labels,
  disabled,
  onChange,
}: {
  row: MalPreviewRow;
  labels: MalLabelSelection[] | undefined;
  disabled: boolean;
  onChange: (labels: MalLabelSelection[]) => void;
}) {
  const evidence = row.tagEvidence;
  const base = useId();
  if (!evidence) return null;
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded-md border p-3">
      <legend>{m.library_mal_label_adoption()}</legend>
      <p>{m.library_mal_label_help()}</p>
      <p>
        {evidence.grammar} · {evidence.kind} · {evidence.reason}
      </p>
      {evidence.raw !== undefined ? (
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{evidence.raw}</pre>
      ) : null}
      {evidence.values.map((value) => {
        const selected = labels?.find((s) => s.value === value.index);
        return (
          <div key={value.index} className="space-y-2 border-t pt-2">
            <p className="[overflow-wrap:anywhere]">
              #{value.index}: {value.value}
            </p>
            <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value.raw}</pre>
            {value.duplicateOf !== null ? <p>{m.library_mal_label_duplicate({ index: value.duplicateOf })}</p> : null}
            <label className="flex min-h-11 items-center gap-2" htmlFor={`${base}-${value.index}`}>
              <input
                id={`${base}-${value.index}`}
                type="checkbox"
                checked={!!selected}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...(labels ?? []), { value: value.index, target: { name: '' } }]
                      : (labels ?? []).filter((s) => s.value !== value.index),
                  )
                }
              />
              {m.library_mal_label_select({ index: value.index })}
            </label>
            {selected ? (
              <LabelTarget
                selection={selected}
                onChange={(selection) =>
                  onChange((labels ?? []).map((s) => (s.value === selection.value ? selection : s)))
                }
              />
            ) : null}
          </div>
        );
      })}
      <MalReviewedLabels review={row.review?.labels} />
    </fieldset>
  );
}

function LabelTarget({
  selection,
  onChange,
}: {
  selection: MalLabelSelection;
  onChange: (s: MalLabelSelection) => void;
}) {
  const id = useId();
  const target = selection.target;
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor={`${id}-mode`}>{m.library_mal_label_target()}</label>
      <select
        id={`${id}-mode`}
        className="min-h-11 w-full border"
        value={'name' in target ? 'new' : 'existing'}
        onChange={(e) =>
          onChange({ ...selection, target: e.target.value === 'new' ? { name: '' } : { labelId: '', revision: 1 } })
        }
      >
        <option value="new">{m.library_mal_label_new()}</option>
        <option value="existing">{m.library_mal_label_existing()}</option>
      </select>
      {'name' in target ? (
        <>
          <label htmlFor={`${id}-name`}>{m.library_mal_label_name()}</label>
          <input
            id={`${id}-name`}
            className="min-h-11 min-w-0 border p-2"
            value={target.name}
            onChange={(e) => onChange({ ...selection, target: { name: e.target.value } })}
          />
        </>
      ) : (
        <>
          <label htmlFor={`${id}-identity`}>{m.library_mal_label_id()}</label>
          <input
            id={`${id}-identity`}
            className="min-h-11 min-w-0 border p-2"
            value={target.labelId}
            onChange={(e) => onChange({ ...selection, target: { ...target, labelId: e.target.value } })}
          />
          <label htmlFor={`${id}-revision`}>{m.library_mal_label_revision()}</label>
          <input
            id={`${id}-revision`}
            className="min-h-11 min-w-0 border p-2"
            type="number"
            min={1}
            value={target.revision}
            onChange={(e) => onChange({ ...selection, target: { ...target, revision: e.target.valueAsNumber } })}
          />
        </>
      )}
    </div>
  );
}

export function MalReviewedLabels({ review }: { review: MalLabelReview | undefined }) {
  if (!review) return null;
  return (
    <ul className="space-y-2 [overflow-wrap:anywhere]" aria-label={m.library_mal_label_adoption()}>
      {review.selections.map((selection) => (
        <li key={selection.value}>
          #{selection.value}: {selection.sourceValue} · {selection.status} · {selection.reason}
          {selection.target ? (
            <p>
              {'name' in selection.target
                ? selection.target.name
                : `${selection.target.labelId} · ${selection.target.revision}`}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A receipt is an effect acknowledgement. This separate current read never settles delivery uncertainty. */
export function MalCurrentAssignments({ subjectId }: { subjectId: string }) {
  const port = useMalImportPort();
  const [current, setCurrent] = useState<MalAssignment[] | null>(null);
  useEffect(() => {
    let active = true;
    setCurrent(null);
    void port.assignments?.(subjectId).then((result) => {
      if (active && result.kind === 'assignments') setCurrent(result.assignments);
    });
    return () => {
      active = false;
    };
  }, [port, subjectId]);
  return (
    <section className="mt-3 [overflow-wrap:anywhere]" aria-label={m.library_mal_label_current()}>
      <h4>{m.library_mal_label_current()}</h4>
      <p>{subjectId}</p>
      {current === null ? (
        <p role="status">{m.library_mal_unavailable()}</p>
      ) : (
        <>
          {!current.length ? <p>{m.library_mal_label_none()}</p> : null}
          <ul>
            {current.map((assignment) => (
              <li key={assignment.id}>
                {assignment.labelId} · {assignment.id} · {assignment.revision}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function MalRetainedSource({ id }: { id: string }) {
  const port = useMalImportPort();
  const [xml, setXml] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    let active = true;
    if (opened)
      void port.source?.(id).then((result) => {
        if (active && result.kind === 'source') setXml(result.xml);
      });
    return () => {
      active = false;
    };
  }, [port, id, opened]);
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-2">{m.library_mal_label_source()}</summary>
      {xml === null ? (
        <p>{m.library_mal_unavailable()}</p>
      ) : (
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{xml}</pre>
      )}
    </details>
  );
}
