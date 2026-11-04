import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { LanguageTag } from '../values';

/** Terms belong to this Subject. Matching a person's and a character's names never joins their identities. */
export function SuppliedNames({ reading }: { reading: { public: SubjectRead; locale: string } }) {
  const { subject } = reading.public;
  const { locale } = reading;
  const o = { locale: locale as never };
  const languages = [...new Set([...Object.keys(subject.labels), ...Object.keys(subject.aliases)])];
  const bounded = languages.slice(0, 15);
  const label = pickText(subject.labels, locale);
  const more =
    languages.length > bounded.length || bounded.some((language) => (subject.aliases[language]?.length ?? 0) > 32);
  return (
    <section className="min-w-0 space-y-3" data-slot="supplied-names">
      <h3 className="text-xl font-semibold">{m.showcase_people_names({}, o)}</h3>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
        {bounded.map((language) => (
          <div key={language} className="min-w-0 space-y-1">
            <dt className="text-sm text-muted-foreground">
              <LanguageTag lang={language} locale={locale} />
            </dt>
            <dd className="space-y-1" lang={language}>
              {subject.labels[language] && <p className="font-medium">{subject.labels[language]}</p>}
              {!!subject.aliases[language]?.length && (
                <div>
                  <span className="text-sm text-muted-foreground">{m.subject_aliases({}, o)}</span>
                  <ul className="space-y-1">
                    {subject.aliases[language]!.slice(0, 32).map((alias, index) => (
                      <li key={index}>{alias}</li>
                    ))}
                  </ul>
                </div>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {more && (
        <a
          className="inline-flex min-h-11 items-center underline"
          href={`${subjectHref({ id: subject.id, label: label.text }, locale).href}/details`}
        >
          {m.person_reader_more({}, o)}
        </a>
      )}
    </section>
  );
}
