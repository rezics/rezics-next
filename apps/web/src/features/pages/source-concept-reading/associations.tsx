import type { ReactNode } from 'react';
import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { defaultReader, type Reader } from '../../../subject/reader';
import { languageName } from '../../../subject/language';
import { subjectHref } from '../../../subject/subject-href';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import { FactInspectionEntry } from '../../catalogue/people-facts/visit';
import type { ProfileReading } from '../../catalogue/person-reader/reader';
import { conceptRequested, type ConceptStatement, type ConceptRead } from '../../catalogue/source-concept-explorer';
import { CandidateValue } from '../data';
import { spoilerLevel } from '../shared';
import { SpoilerGate } from '../values';
import { linkClass } from './hierarchy';

/** Each reference value needs its own admitted summary; unavailable labels never become UUID captions. */
function AssociationValue({
  part,
  read,
  locale,
  returnTo,
}: {
  part: ConceptStatement | ConceptStatement['qualifiers'][number];
  read: SubjectRead;
  locale: string;
  returnTo?: string | undefined;
}) {
  const o = { locale: locale as never };
  if (part.property.data_type === 'wikibase-item' && part.value.type === 'value') {
    const id = part.value.content;
    const summary = typeof id === 'string' && Object.hasOwn(read.related, id) ? read.related[id] : undefined;
    const label = summary && 'labels' in summary ? pickText(summary.labels ?? {}, locale) : undefined;
    if (typeof id !== 'string' || !label?.text) return <span>{m.candidate_value_unavailable({}, o)}</span>;
    const entry =
      summary &&
      'type' in summary &&
      (summary.type === conceptRequested.type || summary.type === conceptRequested.scheme)
        ? catalogueEntries.concepts({ id, label: label.text, locale })
        : subjectHref({ id, label: label.text }, locale);
    return (
      <a
        className={linkClass}
        lang={label.lang ?? undefined}
        href={returnTo ? `${entry.href}?${new URLSearchParams({ returnTo })}` : entry.href}
      >
        {label.text}
      </a>
    );
  }
  return <CandidateValue snak={part} related={read.related} subject={read.subject.id} locale={locale} />;
}

function EvidenceParts({
  parts,
  read,
  locale,
}: {
  parts: ConceptStatement['qualifiers'];
  read: SubjectRead;
  locale: string;
}) {
  return (
    <dl className="space-y-2">
      {parts.map((part, index) => {
        const summary = read.related[part.property.id];
        const label = summary && 'labels' in summary ? pickText(summary.labels ?? {}, locale) : undefined;
        return (
          <div key={index}>
            <dt lang={label?.lang ?? undefined} className="text-sm text-muted-foreground">
              {label?.text || m.candidate_value_unavailable({}, { locale: locale as never })}
            </dt>
            <dd>
              <AssociationValue part={part} read={read} locale={locale} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Everything derived from one native assertion, including the inspection link, shares its whole-association gate. */
function Association({
  statement,
  reading,
  children,
}: {
  statement: ConceptStatement;
  reading: ProfileReading;
  children: ReactNode;
}) {
  const { public: read, locale } = reading;
  const o = { locale: locale as never };
  const content = (
    <div className="space-y-2" data-slot="concept-association">
      {children}
      {!!statement.qualifiers.length && (
        <section aria-label={m.correction_qualifiers({}, o)}>
          <h3 className="font-medium">{m.correction_qualifiers({}, o)}</h3>
          <EvidenceParts parts={statement.qualifiers} read={read} locale={locale} />
        </section>
      )}
      {!!statement.references.length && (
        <details>
          <summary className={linkClass}>{m.correction_references({}, o)}</summary>
          <ol className="space-y-3">
            {statement.references.map((reference, index) => (
              <li key={index}>
                <EvidenceParts parts={reference.parts} read={read} locale={locale} />
              </li>
            ))}
          </ol>
        </details>
      )}
      <FactInspectionEntry statement={statement} reading={reading} />
      <details>
        <summary className={linkClass}>{m.concept_visit_assertion({}, o)}</summary>
        <dl className="space-y-1">
          <dt>{m.concept_visit_holder({}, o)}</dt>
          <dd>
            <code>{read.subject.id}</code>
          </dd>
          <dt>{m.concept_visit_property({}, o)}</dt>
          <dd>
            <code>{statement.property.id}</code>
          </dd>
          <dt>{m.settings_verification_statement({}, o)}</dt>
          <dd>
            <code>{statement.id}</code>
          </dd>
          <dt>{m.own_drafts_revision({}, o)}</dt>
          <dd>{read.subject.revision}</dd>
          <dt>{m.prq_context({}, o)}</dt>
          <dd>
            <code>{read.subject.context}</code>
          </dd>
          <dt>{m.concept_explore_source_release({}, o)}</dt>
          <dd>
            <code>{read.subject.release}</code>
          </dd>
        </dl>
        {statement.rezics && (
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(statement.rezics, null, 2)}</pre>
        )}
      </details>
    </div>
  );
  return spoilerLevel(statement) > (reading.reader ?? defaultReader).spoilerLevel ? (
    <SpoilerGate label={m.subject_spoiler_show({}, o)} hideLabel={m.subject_spoiler_hide({}, o)}>
      {content}
    </SpoilerGate>
  ) : (
    content
  );
}

/** Render the admitted original arrays: equal targets and codes never collapse distinct assertions. */
export function ConceptAssociations({
  read,
  locale,
  reader,
  returnTo,
  codes,
}: {
  read: SubjectRead;
  locale: string;
  reader: Reader;
  returnTo?: string | undefined;
  codes: Extract<ConceptRead, { ok: true }>['codes'];
}) {
  // Inspection uses the existing exact value address. No guide or per-row Subject read is added here.
  const reading: ProfileReading = { public: read, locale, reader, release: { types: {}, properties: {} } };
  const codeLabels = new Map(codes.map((code) => [code.property, code]));
  const groups = [
    {
      key: 'scheme',
      title: m.concept_explore_scheme,
      empty: m.concept_explore_no_schemes,
      statements: read.subject.statements[conceptRequested.inScheme] ?? [],
    },
    {
      key: 'code',
      title: m.concept_explore_source_code,
      empty: m.concept_explore_no_codes,
      statements: Object.values(read.subject.statements).flatMap((rows) =>
        rows.filter((statement) => statement.property.data_type === 'external-id'),
      ),
    },
    {
      key: 'broader',
      title: m.concept_explore_broader,
      empty: m.concept_explore_no_broader,
      statements: read.subject.statements[conceptRequested.broader] ?? [],
    },
  ];
  const o = { locale: locale as never };
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className="space-y-3" aria-labelledby={`concept-${group.key}-heading`}>
          <h2 id={`concept-${group.key}-heading`} className="font-sans text-lg font-semibold">
            {group.title({}, o)}
          </h2>
          {group.statements.length ? (
            <ul className="space-y-4">
              {group.statements.map((statement) => (
                <li key={statement.id}>
                  <Association statement={statement} reading={reading}>
                    {group.key === 'code' && (
                      <p lang={codeLabels.get(statement.property.id)?.labelLang ?? undefined}>
                        {codeLabels.get(statement.property.id)?.label !== statement.property.id
                          ? codeLabels.get(statement.property.id)?.label
                          : m.concept_explore_source_code({}, o)}
                      </p>
                    )}
                    <AssociationValue part={statement} read={read} locale={locale} returnTo={returnTo} />
                  </Association>
                </li>
              ))}
            </ul>
          ) : (
            <p>{group.empty({}, o)}</p>
          )}
        </section>
      ))}
    </>
  );
}

export function ConceptAliases({
  aliases,
  locale,
}: {
  aliases: { text: string; lang: string | null }[];
  locale: string;
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2">
      {aliases.map((alias) => (
        <li key={JSON.stringify([alias.lang, alias.text])}>
          <span lang={alias.lang ?? undefined}>{alias.text}</span>{' '}
          <span className="text-sm text-muted-foreground">
            {alias.lang ? (languageName(alias.lang, locale) ?? alias.lang) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
