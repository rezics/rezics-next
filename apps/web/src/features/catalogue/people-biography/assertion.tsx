import { useEffect, useState, type SyntheticEvent } from 'react';
import { m } from '../../../paraglide/messages.js';
import { PartValue } from '../statement-editor-view';
import { useCurrentReadingVisible } from '../editor-lifetime';
import { valueExplanationHref } from '../value-explanation';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { peopleBiographyAddress, peopleBiographyTargetHref } from './current-visit';
import { peopleLabel, type PeopleBiographyFact, type PeopleBiographyField } from './index';
import type { FactsCurrent } from '../subject-facts';

const control =
  'inline-flex min-h-11 min-w-11 max-w-full items-center py-2 underline whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type Part = PeopleBiographyFact['statement'] | PeopleBiographyFact['statement']['qualifiers'][number];

function targetFor(part: Part, read: FactsCurrent, locale: string) {
  const definition = read.release.properties[part.property.id];
  if (
    part.property.data_type !== 'wikibase-item' ||
    definition?.datatype !== part.property.data_type ||
    part.value.type !== 'value'
  )
    return;
  const id = part.value.content;
  if (typeof id !== 'string' || !Object.hasOwn(read.public.related, id)) return;
  const summary = read.public.related[id];
  if (!summary || !('labels' in summary)) return;
  return { id, label: peopleLabel(summary.labels ?? {}, locale) };
}

/** Item evidence links are built only from disclosed related summaries and preserve the visit address. */
function EvidenceValue({
  part,
  fact,
  field,
  read,
  locale,
  title,
}: {
  part: Part;
  fact: PeopleBiographyFact;
  field: PeopleBiographyField;
  read: FactsCurrent;
  locale: string;
  title: string;
}) {
  const target = targetFor(part, read, locale);
  if (part.property.data_type === 'wikibase-item' && part.value.type === 'value') {
    if (!target) return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
    const returnHref = peopleBiographyAddress(
      read.public.subject.id,
      title,
      locale,
      read.public.subject.context,
      field.kind,
      field.id,
      fact.id,
    );
    return (
      <a
        className={control}
        lang={target.label.lang ?? undefined}
        href={peopleBiographyTargetHref(target.id, target.label.text, locale, read.public.subject.context, returnHref)}
      >
        {target.label.text || m.subject_value_unlabelled({}, { locale: locale as never })}
      </a>
    );
  }
  return <PartValue part={part} read={read} locale={locale} />;
}

/** Exact selected assertion and its admitted evidence stay inside the same disclosure gate. */
export function PeopleBiographyAssertion({
  fact,
  field,
  read,
  locale,
  restored,
  title,
}: {
  fact: PeopleBiographyFact;
  field: PeopleBiographyField;
  read: FactsCurrent;
  locale: string;
  restored: boolean;
  title: string;
}) {
  const visible = useCurrentReadingVisible();
  const [open, setOpen] = useState(false);
  const o = { locale: locale as never };
  const statement = fact.statement;
  const propertyLabel = peopleLabel(read.release.properties[field.id]?.labels, locale);
  const assertionHref = withSubjectVisitReturn(
    valueExplanationHref(
      {
        id: read.public.subject.id,
        property: fact.property,
        statement: fact.id,
        context: read.public.subject.context,
        title,
      },
      locale,
    ),
    peopleBiographyAddress(
      read.public.subject.id,
      title,
      locale,
      read.public.subject.context,
      field.kind,
      field.id,
      fact.id,
    ),
    locale,
  );
  useEffect(() => {
    if (restored) setOpen(true);
  }, [restored]);
  function toggle(event: SyntheticEvent<HTMLDetailsElement>) {
    setOpen(event.currentTarget.open);
  }
  if (!visible) return null;
  return (
    <details className="min-w-0 space-y-2" open={open} onToggle={toggle}>
      <summary className={control}>{m.value_why({}, o)}</summary>
      <dl className="grid min-w-0 gap-2">
        <div>
          <dt lang={propertyLabel.lang ?? undefined} className="text-sm text-muted-foreground">
            {propertyLabel.text || m.candidate_value_unavailable({}, o)}
          </dt>
          <dd>
            <a className={control} href={assertionHref}>
              {m.value_why({}, o)}
            </a>
          </dd>
        </div>
        {statement.qualifiers.map((part, index) => {
          const label = peopleLabel(read.release.properties[part.property.id]?.labels, locale);
          return (
            <div key={`q-${index}`}>
              <dt lang={label.lang ?? undefined} className="text-sm text-muted-foreground">
                {label.text || m.candidate_value_unavailable({}, o)}
              </dt>
              <dd>
                <EvidenceValue part={part} fact={fact} field={field} read={read} locale={locale} title={title} />
              </dd>
            </div>
          );
        })}
        {statement.references.map((reference, referenceIndex) => (
          <div key={`r-${referenceIndex}`}>
            <dt className="text-sm text-muted-foreground">{m.correction_references({}, o)}</dt>
            <dd>
              <dl className="grid min-w-0 gap-2">
                {reference.parts.map((part, partIndex) => {
                  const label = peopleLabel(read.release.properties[part.property.id]?.labels, locale);
                  return (
                    <div key={partIndex}>
                      <dt lang={label.lang ?? undefined} className="text-sm text-muted-foreground">
                        {label.text || m.candidate_value_unavailable({}, o)}
                      </dt>
                      <dd>
                        <EvidenceValue
                          part={part}
                          fact={fact}
                          field={field}
                          read={read}
                          locale={locale}
                          title={title}
                        />
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function peopleBiographyAssertionAnchor(id: string): string {
  return `people-assertion-${id}`;
}

export function peopleBiographyFieldAnchor(id: string): string {
  return `people-field-${encodeURIComponent(id)}`;
}
