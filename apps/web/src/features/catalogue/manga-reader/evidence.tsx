import type { Snak, PageLink } from '../../pages/shared';
import { pageText, linkClass, linkColor } from '../../pages/shared';
import { CandidateValue } from '../../pages/data';
import { m } from '../../../paraglide/messages.js';
import type { RelationDefinition } from '../../../subject/relations';
import { mangaRelatedLabels, type MangaReaderRow } from './model';
import { mangaCorrectionAddress } from './navigation';

export type MangaPropertyLabels = Record<string, { labels?: Record<string, string> }>;
const action = `${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 items-center rounded-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

/** A selection reads this occurrence's assertion. The target's ordinary facts are never substituted. */
export function MangaOccurrenceEvidence({
  row,
  locale,
  definitions,
  propertyLabels,
  link: Link,
  correctionLink: CorrectionLink,
}: {
  row: MangaReaderRow;
  locale: string;
  definitions: Record<string, RelationDefinition>;
  propertyLabels?: MangaPropertyLabels | undefined;
  link: PageLink;
  correctionLink: PageLink;
}) {
  const o = { locale: locale as never };
  const assertion = row.assertion;
  const holder = row.holder;
  if (!assertion || !holder)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.manga_reader_inspection_unavailable({}, o)}
      </p>
    );
  const related = mangaRelatedLabels(row.related);
  const field = (id: string) => {
    const label = pageText(propertyLabels?.[id]?.labels, locale);
    return {
      text: label.text || definitions[id]?.forwardLabel || definitions[id]?.label || id,
      lang: label.lang,
    };
  };
  const value = (part: Snak) => <CandidateValue snak={part} related={related} locale={locale} link={Link} />;
  const directed =
    row.direction === 'forward'
      ? definitions[row.property]?.forwardLabel || definitions[row.property]?.label
      : definitions[row.property]?.label;
  const relation = field(row.property);
  return (
    <div
      className="min-w-0 space-y-4 rounded-lg border border-border bg-muted/30 p-3 sm:p-4"
      data-slot="manga-occurrence-evidence"
    >
      <div className="space-y-1">
        <h4 className="font-semibold">{m.manga_reader_inspection_title({}, o)}</h4>
        <p className="text-sm text-muted-foreground">{m.manga_reader_inspection_scope({}, o)}</p>
      </div>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">{m.manga_reader_selected_part({}, o)}</dt>
          <dd lang={row.labelLanguage} className="[overflow-wrap:anywhere]">
            {row.label || m.subject_value_unlabelled({}, o)}
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.manga_reader_direction({}, o)}</dt>
          <dd>
            {row.direction === 'forward' ? m.manga_reader_forward({}, o) : m.manga_reader_inverse({}, o)}
            {directed ? ` · ${directed}` : ''}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-medium">{m.manga_reader_holder({}, o)}</dt>
          <dd lang={holder.language} className="[overflow-wrap:anywhere]">
            {holder.label || m.subject_value_unlabelled({}, o)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-medium" lang={relation.lang}>
            {relation.text}
          </dt>
          <dd className="[overflow-wrap:anywhere]">{value(assertion)}</dd>
        </div>
      </dl>
      <section className="space-y-2" aria-label={m.manga_reader_qualifiers({}, o)}>
        <h5 className="text-sm font-semibold">{m.manga_reader_qualifiers({}, o)}</h5>
        {assertion.qualifiers.length ? (
          <dl className="space-y-3 text-sm">
            {assertion.qualifiers.map((part, index) => {
              const label = field(part.property.id);
              return (
                <div key={index} className="min-w-0">
                  <dt className="font-medium [overflow-wrap:anywhere]" lang={label.lang}>
                    {label.text}
                  </dt>
                  <dd className="[overflow-wrap:anywhere]">{value(part)}</dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{m.manga_reader_no_qualifiers({}, o)}</p>
        )}
      </section>
      <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
        <h5 className="text-sm font-semibold">{m.sources_citations({}, o)}</h5>
        {assertion.references.length ? (
          <ol className="space-y-3">
            {assertion.references.map((reference, index) => (
              <li key={index} data-reference={reference.hash} className="min-w-0 rounded-md border border-border p-3">
                <h6 className="text-sm font-medium">{m.manga_reader_reference_group({ number: index + 1 }, o)}</h6>
                <dl className="space-y-2 text-sm">
                  {reference.parts.map((part, partIndex) => {
                    const label = field(part.property.id);
                    return (
                      <div key={partIndex} className="min-w-0">
                        <dt className="font-medium [overflow-wrap:anywhere]" lang={label.lang}>
                          {label.text}
                        </dt>
                        <dd className="[overflow-wrap:anywhere]">{value(part)}</dd>
                      </div>
                    );
                  })}
                </dl>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{m.manga_reader_no_references({}, o)}</p>
        )}
      </section>
      <details className="min-w-0 text-sm">
        <summary className={`${action} cursor-pointer`}>{m.manga_reader_association({}, o)}</summary>
        <dl className="space-y-2 [overflow-wrap:anywhere]">
          <div>
            <dt className="font-medium">{m.manga_reader_node({}, o)}</dt>
            <dd>{row.node}</dd>
          </div>
          <div>
            <dt className="font-medium">{m.manga_reader_holder({}, o)}</dt>
            <dd>{holder.id}</dd>
          </div>
          <div>
            <dt className="font-medium">{m.manga_reader_assertion({}, o)}</dt>
            <dd>{assertion.id}</dd>
          </div>
          <div>
            <dt className="font-medium">{relation.text}</dt>
            <dd>{row.property}</dd>
          </div>
          <div>
            <dt className="font-medium">{m.manga_reader_release({}, o)}</dt>
            <dd>
              {assertion.rezics.release} · {assertion.rezics.revision}
            </dd>
          </div>
        </dl>
      </details>
      <p className="text-sm text-muted-foreground">{m.manga_reader_correction_scope({}, o)}</p>
      <CorrectionLink href={mangaCorrectionAddress(holder, locale)} className={action}>
        {m.correction_title({}, o)}
      </CorrectionLink>
    </div>
  );
}
