import { m } from '../../paraglide/messages.js';
import type { VndbRow, VndbSourceValue } from './contract';

function valueText(value: VndbSourceValue): string {
  if (value.kind === 'missing') return m.library_vndb_value_missing();
  if (value.kind === 'unknown') return m.library_vndb_value_unknown();
  if (value.kind === 'invalid') return m.library_vndb_value_invalid();
  return value.value === undefined ? value.raw ?? '' : String(value.value);
}

function fieldLabel(name: string): string {
  if (name === 'vote') return m.library_vndb_field_score();
  if (name === 'started' || name === 'finished') return name === 'started' ? m.library_vndb_field_started() : m.library_vndb_field_finished();
  if (name === 'notes') return m.library_vndb_field_notes();
  if (name === 'private') return m.library_vndb_field_privacy();
  if (name === 'labels') return m.library_vndb_field_labels();
  if (name === 'progress' || name === 'played' || name === 'length') return m.library_vndb_field_progress();
  return m.library_vndb_field_other({ name });
}

function FieldValue({ name, value }: { name: string; value: VndbSourceValue }) {
  const privateNote = name === 'notes';
  return (
    <li className="min-w-0 [overflow-wrap:anywhere]" data-vndb-field={name}>
      <span className="font-medium">{fieldLabel(name)}: </span>
      <span className={privateNote ? 'whitespace-pre-wrap' : 'whitespace-normal'}>{valueText(value)}</span>
      {value.raw !== null && value.kind !== 'value' ? (
        <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">{m.library_vndb_raw({ value: value.raw })}</span>
      ) : null}
      {value.scale ? (
        <span className="block text-sm text-muted-foreground">
          {m.library_vndb_score_scale({ min: value.scale.min, max: value.scale.max, step: value.scale.step })}
        </span>
      ) : null}
      {value.precision ? (
        <span className="block text-sm text-muted-foreground">{m.library_vndb_date_precision({ precision: value.precision })}</span>
      ) : null}
    </li>
  );
}

export function VndbEvidence({ row }: { row: VndbRow }) {
  const notes = Object.entries(row.fields).filter(([name]) => name === 'notes');
  const ordinary = Object.entries(row.fields).filter(([name]) => name !== 'notes');
  const evidence = JSON.stringify(row.evidence, null, 2);
  return (
    <div className="space-y-3">
      {row.labels.length ? <p>{m.library_vndb_source_labels({ labels: row.labels.join(', ') })}</p> : null}
      {row.suggestedRole ? <p>{m.library_vndb_role_suggestion({ role: row.suggestedRole })}</p> : null}
      {ordinary.length ? (
        <ul className="space-y-2">
          {ordinary.map(([name, value]) => <FieldValue key={name} name={name} value={value} />)}
        </ul>
      ) : null}
      {notes.length ? (
        <details className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_vndb_notes_summary()}</summary>
          <ul className="space-y-2">{notes.map(([name, value]) => <FieldValue key={name} name={name} value={value} />)}</ul>
          <p className="mt-2 text-sm text-muted-foreground">{m.library_vndb_notes_private()}</p>
        </details>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.library_vndb_private_facts()}</p>
      <details className="rounded-md border p-3" data-vndb-unmapped>
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_vndb_unmapped_summary()}</summary>
        <p className="mb-2 text-sm text-muted-foreground">{row.retainedReason}</p>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{evidence}</pre>
      </details>
    </div>
  );
}
