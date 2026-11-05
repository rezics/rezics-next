import type { EditionMetadata, EditionSubjectIdentity } from './edition-api';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

export function editionSubjectName(subject?: EditionSubjectIdentity | null): string {
  if (subject?.kind === 'available') return subject.label.value;
  if (subject?.kind === 'withheld') return m.edition_identity_withheld();
  if (subject?.kind === 'missing') return m.edition_identity_missing();
  return m.edition_identity_unavailable();
}

export function editionRevisionDate(value?: string | null): string {
  return value
    ? new Intl.DateTimeFormat(getLocale(), {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value)) + ' UTC'
    : m.edition_identity_date_missing();
}

/** Edition recognition has no shared control equivalent. Native display metadata
 * is separate from the immutable, selectable technical references. */
export function EditionIdentitySummary({ edition }: { edition: EditionMetadata }) {
  const subject = edition.identity?.subject;
  return (
    <div className="min-w-0 space-y-2">
      <p className="break-words text-lg font-semibold" lang={subject?.label?.language}>
        {editionSubjectName(subject)}
      </p>
      <p className="text-sm text-muted-foreground">
        {m.edition_identity_revision_date({ date: editionRevisionDate(edition.identity?.revisionCreatedAt) })}
      </p>
      {subject?.kind !== 'available' && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.edition_identity_recovery()}
        </p>
      )}
    </div>
  );
}

export function EditionTechnicalDetails({ edition }: { edition: EditionMetadata }) {
  return (
    <details className="min-w-0 text-xs">
      <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">{m.edition_identity_details()}</summary>
      <dl className="space-y-3 [overflow-wrap:anywhere]">
        {[
          [m.creator_editions_reference(), edition.editionId],
          [m.creator_editions_subject(), edition.targetSubjectId],
          [m.creator_editions_revision(), edition.revisionId],
          [m.creator_editions_version({ version: edition.editionRevision }), edition.editionRevision],
          ['SHA-256', edition.sha256],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 select-all font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
