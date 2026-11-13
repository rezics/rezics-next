import type { Related, Subject } from '../../../subject/read-contract';
import type { Reader } from '../../../subject/reader';
import type { ReleasedRelationDirectionResult } from '@rezics/definitions';
import { m } from '../../../paraglide/messages.js';
import { pageText, type PageLink } from '../../pages/shared';
import { literarySelected, literaryWorkIdentity, type LiteraryDefinitions } from './model';
import { literaryFields, type LiteraryView } from './presentation';
import { LiteraryAssertionView, LiteraryStatus } from './sections';
import { literaryStyle as style } from './style';

export function LiteraryFacts({
  work,
  related,
  definitions,
  directions,
  digest,
  reader,
  locale,
  view,
  returnToFor,
  linkFor,
  currentFocus,
  properties,
}: {
  work: Subject;
  related: Related;
  definitions: LiteraryDefinitions;
  directions: ReleasedRelationDirectionResult[] | undefined;
  digest: string | undefined;
  reader: Reader;
  locale: string;
  view: LiteraryView;
  returnToFor: (focus: string) => string;
  linkFor: (returnTo: string) => PageLink;
  currentFocus: string | undefined;
  properties?: readonly string[];
}) {
  const o = { locale: locale as never };
  const facts = (properties ?? literaryFields(view)).flatMap((property) => {
    if (!definitions.types[work.type]?.properties.includes(property)) return [];
    const statements = literarySelected(work, property, reader);
    const label = pageText(definitions.properties[property]?.labels, locale);
    const membership = property === 'wdt:P179' || property === 'schema:isPartOf';
    const canonical = property === 'schema:exampleOfWork';
    const wordCount = property === 'schema:wordCount';
    if (!statements.length && !canonical && !wordCount) return [];
    const relation = definitions.properties[property]?.relation;
    const admitted = directions?.find(
      (direction) => direction.property === property && direction.direction === 'forward',
    );
    const unavailable = relation && (admitted?.state !== 'admitted' || admitted.release !== digest);
    const withheld = !statements.length && (work.relationCounts?.[property] ?? 0) > 0;
    const assertion = (statement: (typeof statements)[number]) => {
      const target =
        statement.value.type === 'value' && typeof statement.value.content === 'string'
          ? related[statement.value.content]
          : undefined;
      const focus = `direct:${property}:${statement.id}`;
      return (
        <LiteraryAssertionView
          key={statement.id}
          assertion={{ statement, related }}
          definitions={definitions}
          locale={locale}
          link={linkFor(returnToFor(focus))}
          membership={membership}
          focusId={focus}
          {...(membership || canonical
            ? {
                inspection: {
                  holder: literaryWorkIdentity(work, locale).title.text,
                  candidate: (target && pageText(target.labels, locale).text) || m.literary_grain_withheld({}, o),
                },
              }
            : {})}
        />
      );
    };
    const visible = view === 'overview' ? statements.slice(0, 3) : statements;
    const remainder = view === 'overview' ? statements.slice(3) : [];
    return [
      <div key={property} className="min-w-0 space-y-1" data-property={property}>
        <dt lang={label.lang} className="text-sm text-muted-foreground">
          {label.text || m.subject_value_unlabelled({}, o)}
        </dt>
        <dd className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
          {unavailable ? (
            <LiteraryStatus state={admitted?.state === 'unsupported' ? 'unsupported' : 'unavailable'} locale={locale} />
          ) : (
            <>
              {visible.map(assertion)}
              {remainder.length > 0 && (
                <details
                  open={
                    remainder.some((statement) => currentFocus === `direct:${property}:${statement.id}`) || undefined
                  }
                >
                  <summary className={style.disclosure}>{m.literary_reader_more_values({}, o)}</summary>
                  <div className="space-y-3">{remainder.map(assertion)}</div>
                </details>
              )}
              {!statements.length &&
                (withheld ? (
                  <LiteraryStatus state="withheld" locale={locale} />
                ) : (
                  <p role="status">
                    {wordCount ? m.subject_value_unknown({}, o) : m.literary_grain_mapping_missing({}, o)}
                  </p>
                ))}
            </>
          )}
        </dd>
      </div>,
    ];
  });
  if (!facts.length) return null;
  return (
    <section className={style.separator} aria-label={m.literary_reader_facts({}, o)}>
      <dl className="grid min-w-0 gap-x-10 gap-y-6 sm:grid-cols-2">{facts}</dl>
    </section>
  );
}
