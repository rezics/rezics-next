import { m } from '../../paraglide/messages.js';
import type { AniListRow, AniListScoreFormat, AniListSourceField } from './contract';
import {
  aniListEmptyFields,
  aniListFieldLabel,
  aniListFieldValue,
  aniListIdentifierLabel,
  aniListMediaType,
  aniListPrivateNote,
  aniListUnsupportedFields,
  aniListValidityLabel,
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

function FieldList({ fields, row }: { fields: AniListSourceField[]; row: AniListRow }) {
  const mediaType = aniListMediaType(row.source.evidence);
  return (
    <ul className="mt-2 space-y-2">
      {fields.map((field) => (
        <li key={field.field} className="[overflow-wrap:anywhere]" data-anilist-field={field.field}>
          <span className="font-medium">{aniListFieldLabel(field, mediaType)}</span>
          {': '}
          {aniListFieldValue(row.source.evidence, field)}
          {' · '}
          {aniListValidityLabel(field.validity)}
          {' · '}
          {field.reason}
        </li>
      ))}
    </ul>
  );
}

export function AniListEvidencePanel({
  row,
  scoreFormat,
}: {
  row: AniListRow;
  scoreFormat: AniListScoreFormat | null;
}) {
  const source = row.source;
  const mediaType = aniListMediaType(source.evidence);
  const unknown = aniListUnsupportedFields(source);
  const note = aniListPrivateNote(source);
  const status = source.fields.find((field) => field.field === 'status');
  const score = source.fields.find((field) => field.field === 'score');
  const progress = source.fields.find((field) => field.field === 'progress');
  const volumes = source.fields.find((field) => field.field === 'progressVolumes');
  const repeat = source.fields.find((field) => field.field === 'repeat');
  const privacy = source.fields.find((field) => field.field === 'private' || field.field === 'hiddenFromStatusLists');
  const updated = source.fields.find((field) => field.field === 'updatedAt' || field.field === 'createdAt');
  const anilist = source.identifiers.filter((item) => item.source === 'anilist');
  const mal = source.identifiers.filter((item) => item.source === 'myanimelist');
  const entryId = Object.hasOwn(source.evidence, 'id');
  return (
    <div className="space-y-4">
      {aniListEmptyFields(source) ? <p>{m.library_anilist_empty_fields()}</p> : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        {anilist.map((identifier) => (
          <Fact
            key={`${identifier.source}-${identifier.externalId}`}
            label={m.library_anilist_media_id()}
            value={aniListIdentifierLabel(identifier)}
          />
        ))}
        {mal.map((identifier) => (
          <Fact
            key={`${identifier.source}-${identifier.externalId}`}
            label={m.library_anilist_mal_id()}
            value={aniListIdentifierLabel(identifier)}
          />
        ))}
        {entryId ? <Fact label={m.library_anilist_entry_id()} value={m.library_anilist_entry_not_identity()} /> : null}
        {status ? (
          <Fact
            label={aniListFieldLabel(status, mediaType)}
            value={aniListFieldValue(source.evidence, status)}
            reason={status.reason}
          />
        ) : null}
        {score ? (
          <Fact
            label={aniListFieldLabel(score, mediaType)}
            value={aniListFieldValue(source.evidence, score)}
            reason={score.reason}
          />
        ) : (
          <Fact
            label={m.library_anilist_score()}
            value={scoreFormat ? m.library_anilist_score_absent() : m.library_anilist_score_scale_unknown()}
          />
        )}
        {progress ? (
          <Fact
            label={aniListFieldLabel(progress, mediaType)}
            value={aniListFieldValue(source.evidence, progress)}
            reason={progress.reason}
          />
        ) : null}
        {volumes ? (
          <Fact
            label={aniListFieldLabel(volumes, mediaType)}
            value={aniListFieldValue(source.evidence, volumes)}
            reason={volumes.reason}
          />
        ) : null}
        {repeat ? (
          <Fact
            label={aniListFieldLabel(repeat, mediaType)}
            value={aniListFieldValue(source.evidence, repeat)}
            reason={repeat.reason}
          />
        ) : null}
        {privacy ? (
          <Fact
            label={aniListFieldLabel(privacy, mediaType)}
            value={aniListFieldValue(source.evidence, privacy)}
            reason={privacy.reason}
          />
        ) : null}
        {updated ? (
          <Fact
            label={aniListFieldLabel(updated, mediaType)}
            value={aniListFieldValue(source.evidence, updated)}
            reason={updated.reason}
          />
        ) : null}
      </dl>
      {source.group ? (
        <details className="rounded-md border p-3" data-anilist-group>
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_anilist_group_summary()}</summary>
          <pre className="overflow-x-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
            {JSON.stringify(source.group, null, 2)}
          </pre>
        </details>
      ) : null}
      <p>{m.library_anilist_not_vote()}</p>
      <p>{m.library_anilist_not_session()}</p>
      <p>{m.library_anilist_not_clock()}</p>
      <p>{m.library_anilist_not_public()}</p>
      {note ? (
        <details className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_anilist_notes_summary()}</summary>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{aniListFieldValue(source.evidence, note)}</p>
          <p className="mt-2 text-sm text-muted-foreground">{note.reason}</p>
          <p className="mt-2 text-sm text-muted-foreground">{m.library_anilist_not_review()}</p>
        </details>
      ) : null}
      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_anilist_retained_summary()}</summary>
        <FieldList fields={source.fields} row={row} />
      </details>
      {unknown.length ? (
        <details className="rounded-md border p-3" data-anilist-unknown-fields>
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_anilist_unknown_summary()}</summary>
          <FieldList fields={unknown} row={row} />
        </details>
      ) : null}
    </div>
  );
}
