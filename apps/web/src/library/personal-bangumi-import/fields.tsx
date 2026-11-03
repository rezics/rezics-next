import { m } from '../../paraglide/messages.js';
import type { BangumiEvidence, BangumiRetainedField, BangumiRow } from './contract';
import {
  bangumiEmptyFields,
  bangumiFieldLabel,
  bangumiFieldValue,
  bangumiKnownFields,
  bangumiMeaningLabel,
  bangumiPrivateNote,
  bangumiUnknownFields,
} from './meaning';

function Fact({ label, value, reason }: { label: string; value: string; reason?: string }) {
  return (
    <div>
      <dt className="text-sm font-medium [overflow-wrap:anywhere]">{label}</dt>
      <dd className="whitespace-normal [overflow-wrap:anywhere]">{value}</dd>
      {reason ? <dd className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{reason}</dd> : null}
    </div>
  );
}

function FieldList({ fields, medium }: { fields: BangumiRetainedField[]; medium: string }) {
  return (
    <ul className="mt-2 space-y-2">
      {fields.map((field) => (
        <li key={field.field} className="[overflow-wrap:anywhere]">
          <span className="font-medium">{bangumiFieldLabel(field, medium)}</span>
          {': '}
          {bangumiFieldValue(field)}
          {' · '}
          {bangumiMeaningLabel(field.meaning)}
          {' · '}
          {field.reason}
        </li>
      ))}
    </ul>
  );
}

export function BangumiEvidencePanel({ row }: { row: BangumiRow }) {
  const evidence: BangumiEvidence = row.evidence;
  const known = bangumiKnownFields(evidence);
  const unknown = bangumiUnknownFields(evidence);
  const note = bangumiPrivateNote(evidence);
  const rate = evidence.fields.find((field) => field.field === 'rate');
  const ep = evidence.fields.find((field) => field.field === 'ep_status');
  const vol = evidence.fields.find((field) => field.field === 'vol_status');
  const privacy = evidence.fields.find((field) => field.field === 'private');
  const updated = evidence.fields.find((field) => field.field === 'updated_at');
  const subjectId = evidence.fields.find((field) => field.field === 'subject_id');
  const type = evidence.fields.find((field) => field.field === 'type');
  return (
    <div className="space-y-4">
      {bangumiEmptyFields(evidence) ? <p>{m.library_bangumi_empty_fields()}</p> : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        {subjectId ? (
          <Fact
            label={bangumiFieldLabel(subjectId, evidence.medium)}
            value={bangumiFieldValue(subjectId)}
            reason={subjectId.reason}
          />
        ) : null}
        {type ? (
          <Fact
            label={bangumiFieldLabel(type, evidence.medium)}
            value={evidence.stateRole ?? bangumiFieldValue(type)}
            reason={type.reason}
          />
        ) : null}
        {rate ? (
          <Fact label={bangumiFieldLabel(rate, evidence.medium)} value={bangumiFieldValue(rate)} reason={rate.reason} />
        ) : (
          <Fact label={m.library_bangumi_rate()} value={m.library_bangumi_rate_absent()} />
        )}
        {ep ? (
          <Fact label={bangumiFieldLabel(ep, evidence.medium)} value={bangumiFieldValue(ep)} reason={ep.reason} />
        ) : null}
        {vol ? (
          <Fact label={bangumiFieldLabel(vol, evidence.medium)} value={bangumiFieldValue(vol)} reason={vol.reason} />
        ) : null}
        {privacy ? (
          <Fact
            label={bangumiFieldLabel(privacy, evidence.medium)}
            value={bangumiFieldValue(privacy)}
            reason={privacy.reason}
          />
        ) : null}
        {updated ? (
          <Fact
            label={bangumiFieldLabel(updated, evidence.medium)}
            value={bangumiFieldValue(updated)}
            reason={updated.reason}
          />
        ) : null}
      </dl>
      <p>{m.library_bangumi_not_vote()}</p>
      <p>{m.library_bangumi_not_session()}</p>
      <p>{m.library_bangumi_not_clock()}</p>
      <p>{m.library_bangumi_not_public()}</p>
      {note ? (
        <details className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_bangumi_notes_summary()}</summary>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{bangumiFieldValue(note)}</p>
          <p className="mt-2 text-sm text-muted-foreground">{note.reason}</p>
          <p className="mt-2 text-sm text-muted-foreground">{m.library_bangumi_not_review()}</p>
        </details>
      ) : null}
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_bangumi_retained_summary()}</summary>
        <FieldList fields={known} medium={evidence.medium} />
      </details>
      {unknown.length ? (
        <details className="rounded-md border p-3" data-bangumi-unknown-fields>
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_bangumi_unknown_summary()}</summary>
          <FieldList fields={unknown} medium={evidence.medium} />
        </details>
      ) : null}
    </div>
  );
}
