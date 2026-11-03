import type { SubjectRead } from '@rezics/client';
import { pageDocumentReferences, pickText } from '@rezics/composition';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { defaultReader, type Reader } from '../../../subject/reader';
import { CandidateValue } from '../../pages/data';
import { PlainLink, spoilerLevel, type PageLink } from '../../pages/shared';
import { LanguageTag, SpoilerGate } from '../../pages/values';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { catalogueEntries } from '../catalogue-entry';
import { loadPersonDefinitions } from './actions';
import { personEvidenceFits, personGroups, type PersonDefinitions, type PersonStatement } from './model';

export const personReaderAnchor = 'person-biography';
const control =
  'inline-flex min-h-11 min-w-11 max-w-full items-center py-2 underline whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const options = (locale: string) => ({ locale: locale as never });
const title = (kind: 'biography' | 'occupations' | 'languages', locale: string) =>
  kind === 'biography'
    ? m.people_biography_title({}, options(locale))
    : kind === 'occupations'
      ? m.people_occupations_title({}, options(locale))
      : m.people_languages_title({}, options(locale));

type Reading = {
  public: SubjectRead;
  documents?: unknown;
  locale: string;
  release: PersonDefinitions;
  link?: PageLink;
  reader?: Reader;
};

/** Every item, including a qualifier or citation, needs its own disclosed summary. */
function Value({ part, reading }: { part: PersonStatement | PersonStatement['qualifiers'][number]; reading: Reading }) {
  const { release, public: read, locale, link: Link = PlainLink } = reading;
  const unavailable = <span>{m.candidate_value_unavailable({}, options(locale))}</span>;
  const definition = release.properties[part.property.id];
  if (!definition || definition.datatype !== part.property.data_type) return unavailable;
  if (
    part.property.data_type === 'document' &&
    part.value.type === 'value' &&
    (!('id' in part) || pageDocumentReferences(read.subject, [part.property.id], locale)[0]?.candidate !== part.id)
  )
    return unavailable;
  if (part.value.type === 'value' && part.property.data_type === 'wikibase-item') {
    const id = part.value.content;
    if (typeof id !== 'string' || !Object.hasOwn(read.related, id)) return unavailable;
    const summary = read.related[id];
    if (!summary || !('labels' in summary)) return unavailable;
    const label = pickText(summary.labels ?? {}, locale);
    return (
      <Link className={control} href={subjectHref({ id, label: label.text }, locale).href}>
        <span lang={label.lang ?? undefined}>{label.text || m.subject_value_unlabelled({}, options(locale))}</span>
      </Link>
    );
  }
  return (
    <CandidateValue
      snak={part}
      related={read.related}
      subject={read.subject.id}
      documents={reading.documents}
      locale={locale}
      link={Link}
    />
  );
}

function Evidence({ statement, reading }: { statement: PersonStatement; reading: Reading }) {
  const { locale, release } = reading;
  const o = options(locale);
  const label = (id: string) => pickText(release.properties[id]?.labels ?? {}, locale);
  if (!personEvidenceFits(statement)) return <p role="status">{m.candidate_value_unavailable({}, o)}</p>;
  return (
    <>
      {!!statement.qualifiers.length && (
        <section className="space-y-2" aria-label={m.correction_qualifiers({}, o)}>
          <h5 className="font-medium">{m.correction_qualifiers({}, o)}</h5>
          <dl className="space-y-2">
            {statement.qualifiers.map((part, index) => (
              <div key={index}>
                <dt lang={label(part.property.id).lang ?? undefined} className="text-sm text-muted-foreground">
                  {label(part.property.id).text || m.candidate_value_unavailable({}, o)}
                </dt>
                <dd>
                  <Value part={part} reading={reading} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {!!statement.references.length && (
        <details>
          <summary className={control}>{m.correction_references({}, o)}</summary>
          <ol className="space-y-3">
            {statement.references.map((reference, index) => (
              <li key={index}>
                <dl className="space-y-2">
                  {reference.parts.map((part, index) => (
                    <div key={index}>
                      <dt className="text-sm text-muted-foreground" lang={label(part.property.id).lang ?? undefined}>
                        {label(part.property.id).text || m.candidate_value_unavailable({}, o)}
                      </dt>
                      <dd>
                        <Value part={part} reading={reading} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

function Fact({ statement, reading }: { statement: PersonStatement; reading: Reading }) {
  const o = options(reading.locale);
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  const language =
    typeof content === 'object' && content && 'language' in content && typeof content.language === 'string'
      ? content.language
      : undefined;
  const fact = (
    <div className="space-y-2">
      <Value part={statement} reading={reading} />
      {language && <LanguageTag lang={language} locale={reading.locale} />}
      <Evidence statement={statement} reading={reading} />
      <details>
        <summary className={control}>{m.person_reader_statement({}, o)}</summary>
        <code className="block break-all">{statement.id}</code>
      </details>
    </div>
  );
  return spoilerLevel(statement) > (reading.reader ?? defaultReader).spoilerLevel ? (
    <SpoilerGate label={m.subject_spoiler_show({}, o)} hideLabel={m.subject_spoiler_hide({}, o)}>
      {fact}
    </SpoilerGate>
  ) : (
    fact
  );
}

/** Presentation of one current composition read; no Subject, target or document fetches. */
export function PersonReader(reading: Reading) {
  const { public: read, release, locale } = reading;
  const o = options(locale);
  const groups = personGroups(release, read, locale);
  const label = pickText(read.subject.labels, locale).text;
  const href = subjectHref({ id: read.subject.id, label }, locale).href;
  if (!groups.length) return null;
  return (
    <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]" data-slot="person-reader-facts">
      {groups.map((group) => (
        <section key={group.kind} className="min-w-0 space-y-3" data-slot={`person-reader-${group.kind}`}>
          <h3 className="text-xl font-semibold">{title(group.kind, locale)}</h3>
          {!group.fields.length && <p role="status">{m.people_biography_unsupported({}, o)}</p>}
          {group.fields.map((field) => (
            <section key={field.id} className="min-w-0 space-y-3">
              {group.fields.length > 1 && (
                <h4 className="font-medium" lang={field.label.lang ?? undefined}>
                  {field.label.text || title(group.kind, locale)}
                </h4>
              )}
              {!field.presentable ? (
                <p role="status">{m.candidate_value_unavailable({}, o)}</p>
              ) : (
                !field.facts.length && <p role="status">{m.people_biography_absent({}, o)}</p>
              )}
              <ul className="space-y-4">
                {field.presentable &&
                  field.facts.map((statement) => (
                    <li key={statement.id} className="min-w-0">
                      <Fact statement={statement} reading={reading} />
                    </li>
                  ))}
              </ul>
              {field.more && (
                <a className={control} href={`${href}/details`}>
                  {m.person_reader_more({}, o)}
                </a>
              )}
            </section>
          ))}
          {group.more && (
            <a className={control} href={`${href}/details`}>
              {m.person_reader_more({}, o)}
            </a>
          )}
        </section>
      ))}
      <a className={control} href={catalogueEntries.people({ id: read.subject.id, label, locale }).href}>
        {m.person_reader_correct({}, o)}
      </a>
    </div>
  );
}

export type PersonDefinitionsLoader = (locale: string) => Promise<PersonDefinitions | null>;
const loadDefinitions: PersonDefinitionsLoader = (locale) => loadPersonDefinitions({ data: locale });

function CurrentPerson({ load, ...reading }: Omit<Reading, 'release'> & { load: PersonDefinitionsLoader }) {
  const [result, setResult] = useState<{ release: PersonDefinitions | null }>();
  useEffect(() => {
    let current = true;
    void load(reading.locale).then(
      (release) => {
        if (current) setResult({ release });
      },
      () => {
        if (current) setResult({ release: null });
      },
    );
    return () => {
      current = false;
    };
  }, [load, reading.locale]);
  return result?.release ? (
    <PersonReader {...reading} release={result.release} />
  ) : (
    <p role="status">
      {result
        ? m.candidate_value_unavailable({}, options(reading.locale))
        : m.candidate_loading({}, options(reading.locale))}
    </p>
  );
}

/** A fresh page observation is required after authority, locale or source retirement. */
export function PersonOverview({
  source,
  viewer,
  load = loadDefinitions,
  ...reading
}: Omit<Reading, 'release'> & {
  source: object;
  viewer: string | null;
  load?: PersonDefinitionsLoader;
}) {
  const lifetime = useSubjectCommunityReading({
    source,
    reader: viewer,
    descriptor: JSON.stringify([
      reading.public.subject.id,
      reading.public.subject.type,
      reading.public.subject.context,
      reading.locale,
      reading.reader ?? defaultReader,
    ]),
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [lifetime.key, lifetime.available]);
  return (
    <section
      className="min-w-0 space-y-4"
      data-slot="person-reader"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <h2 id={personReaderAnchor} ref={heading} tabIndex={-1} className="text-2xl font-semibold">
        {m.person_reader_title({}, options(reading.locale))}
      </h2>
      {lifetime.available ? (
        <CurrentPerson key={lifetime.key} {...reading} load={load} />
      ) : (
        <p role="status">{m.candidate_value_unavailable({}, options(reading.locale))}</p>
      )}
    </section>
  );
}
