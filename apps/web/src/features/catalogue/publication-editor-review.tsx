import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import type { StatementFieldsRead } from './statement-editor-view';
import { StatementSummary } from './statement-summary';
import type { PublicationItem, PublicationProfile } from './publication-editor';
import {
  publicationFactId,
  publicationTermControl,
  publicationWorkId,
  type PublicationFactRow,
  type PublicationTerm,
} from './publication-editor-guidance';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';

export function PublicationReview({
  id,
  item,
  profile,
  relation,
  terms,
  facts,
  read,
  locale,
  onEdit,
}: {
  id: string;
  item: PublicationItem;
  profile: PublicationProfile;
  relation: string;
  terms: PublicationTerm[];
  facts: PublicationFactRow[];
  read: StatementFieldsRead;
  locale: string;
  onEdit: (target: string) => void;
}) {
  const o = { locale: locale as never };
  const name = (property: string) => pickText(read.release.properties[property]?.labels ?? {}, locale);
  const workStatement = item.statements[relation]?.[0];
  const reviewedFacts = Object.entries(item.statements).flatMap(([property, statements]) => {
    if (property === relation) return [];
    const rows = facts.filter((row) => row.statement.property.id === property);
    return statements.map((statement, index) => ({
      property,
      statement,
      target: publicationFactId(id, rows[index]?.key ?? `${property}-${index}`),
    }));
  });
  return (
    <ContentItemFrame as="div" className="min-w-0 space-y-5 p-4 sm:p-6">
      <ContentItemHeading id={`${id}-whole-review`} tabIndex={-1} className="text-xl font-semibold">
        {m.publication_review({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.publication_review_intro({}, o)}</p>
      <section className="min-w-0 space-y-3">
        <ContentItemHeading level={3} lang={profile.labelLang ?? undefined} className="text-lg font-semibold">
          {profile.label}
        </ContentItemHeading>
        {profile.description && (
          <p lang={profile.descriptionLang ?? undefined} className="text-sm text-muted-foreground">
            {profile.description}
          </p>
        )}
      </section>
      <ol className="min-w-0 space-y-4">
        {terms.map((term, index) => (
          <li key={term.id} className="min-w-0 space-y-2 rounded-xl border border-border p-4">
            <ContentItemHeading level={3} className="text-base font-semibold">
              {m.catalogue_create_terms({}, o)} · {index + 1} · {term.language}
            </ContentItemHeading>
            <p>
              {m.catalogue_create_label({}, o)}: {item.labels[term.language.trim()] || term.label}
            </p>
            {item.descriptions?.[term.language.trim()] && (
              <p>
                {m.catalogue_create_description({}, o)}: {item.descriptions[term.language.trim()]}
              </p>
            )}
            {item.aliases?.[term.language.trim()]?.length ? (
              <p>
                {m.catalogue_create_aliases({}, o)}: {item.aliases[term.language.trim()]!.join(', ')}
              </p>
            ) : null}
            <Button
              className={actionClassName}
              type="button"
              variant="outline"
              onClick={() => onEdit(publicationTermControl(id, 'label', term.id))}
            >
              {m.publication_edit({}, o)}
            </Button>
          </li>
        ))}
      </ol>
      {workStatement && (
        <section className="min-w-0 space-y-3 rounded-xl border border-border p-4">
          <ContentItemHeading level={3} lang={name(relation).lang ?? undefined} className="text-base font-semibold">
            {m.publication_work_link({}, o)} · {name(relation).text || relation}
          </ContentItemHeading>
          <StatementSummary statement={workStatement} read={read} locale={locale} />
          <Button
            className={actionClassName}
            type="button"
            variant="outline"
            onClick={() => onEdit(publicationWorkId(id))}
          >
            {m.publication_edit({}, o)}
          </Button>
        </section>
      )}
      {reviewedFacts.map((entry) => (
        <section
          key={`${entry.property}-${entry.target}`}
          className="min-w-0 space-y-3 rounded-xl border border-border p-4"
        >
          <ContentItemHeading
            level={3}
            lang={name(entry.property).lang ?? undefined}
            className="text-base font-semibold"
          >
            {name(entry.property).text || entry.property}
          </ContentItemHeading>
          <StatementSummary statement={entry.statement} read={read} locale={locale} />
          <Button className={actionClassName} type="button" variant="outline" onClick={() => onEdit(entry.target)}>
            {m.publication_edit({}, o)}
          </Button>
        </section>
      ))}
    </ContentItemFrame>
  );
}
