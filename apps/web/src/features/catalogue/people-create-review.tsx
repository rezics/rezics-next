import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
import type { PeopleItem, PeopleRead } from './people-profile';
import type { StatementInput } from './statement-editor';

const wrap =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

function rankLabel(rank: string | undefined, locale: string) {
  const o = { locale: locale as never };
  return rank === 'preferred'
    ? m.candidate_rank_preferred({}, o)
    : rank === 'deprecated'
      ? m.changes_rank_deprecated({}, o)
      : m.candidate_rank_normal({}, o);
}

function Assertion({
  statement,
  read,
  locale,
}: {
  statement: StatementInput;
  read: StatementFieldsRead;
  locale: string;
}) {
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-3">
      <div className="min-w-0 text-base leading-relaxed">
        <PartValue part={statement} read={read} locale={locale} />
      </div>
      <p className="text-sm">
        {m.candidate_rank({}, o)}: {rankLabel(statement.rank, locale)}
      </p>
      <dl className="min-w-0 space-y-2 text-sm">
        {(statement.qualifiers ?? []).map((part, index) => (
          <div key={index} className="min-w-0 space-y-1">
            <dt
              className="text-muted-foreground"
              lang={pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).lang}
            >
              {pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).text ||
                m.subject_value_unlabelled({}, o)}
            </dt>
            <dd className="min-w-0">
              <PartValue part={part} read={read} locale={locale} />
            </dd>
          </div>
        ))}
      </dl>
      <ol className="min-w-0 space-y-3">
        {statement.references.map((reference, index) => (
          <li key={index} className="min-w-0 space-y-1 border-s-2 border-border ps-3 text-sm">
            <p className="text-muted-foreground">
              {m.correction_references({}, o)} {index + 1}
            </p>
            {reference.parts.length ? (
              <ul className="min-w-0 space-y-1">
                {reference.parts.map((part, partIndex) => (
                  <li key={partIndex} className="min-w-0">
                    <PartValue part={part} read={read} locale={locale} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{m.facts_reuse_empty({}, o)}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PeopleCreateReview({
  item,
  read,
  locale,
  stale,
  onJump,
}: {
  item: PeopleItem;
  read: Extract<PeopleRead, { ok: true }>;
  locale: string;
  stale: boolean;
  onJump: (id: string) => void;
}) {
  const o = { locale: locale as never };
  const profile = read.profiles.find((entry) => entry.id === item.type);
  const context: StatementFieldsRead = {
    release: read.release,
    source: null,
    public: { related: {}, subject: { type: item.type } },
  };
  const languages = [
    ...new Set([...Object.keys(item.labels), ...Object.keys(item.descriptions ?? {}), ...Object.keys(item.aliases ?? {})]),
  ];
  return (
    <section
      data-people-create-review
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={m.people_profile_review_title({}, o)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.people_profile_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.people_profile_review_intro({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.people_profile_review_credit({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.people_profile_review_stale({}, o)}
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{m.people_profile_review_type({}, o)}</h3>
        <p lang={profile?.lang ?? undefined}>{profile?.label || item.type}</p>
        <p>
          <code className="break-all">{item.type}</code>
        </p>
        <Button type="button" variant="outline" className={wrap} onClick={() => onJump('create-type')}>
          {m.people_profile_review_open({}, o)}
        </Button>
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.people_profile_review_terms({}, o)}</h3>
        {languages.map((language, index) => (
          <ContentItemFrame key={language} as="div" className="min-w-0 space-y-1 rounded-xl bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground">{language}</p>
            {item.labels[language] && (
              <p lang={language} className="font-medium">
                {item.labels[language]}
              </p>
            )}
            {item.descriptions?.[language] && (
              <p lang={language} className="text-sm">
                {item.descriptions[language]}
              </p>
            )}
            {!!item.aliases?.[language]?.length && (
              <p lang={language} className="text-sm">
                {item.aliases[language]!.join(' · ')}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className={wrap}
              onClick={() => onJump(`create-label-${index}`)}
            >
              {m.people_profile_review_open({}, o)}
            </Button>
          </ContentItemFrame>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.people_profile_review_facts({}, o)}</h3>
        {Object.entries(item.statements ?? {}).map(([property, rows]) => {
          const label = pickText(read.release.properties[property]?.labels ?? {}, locale);
          return (
            <ContentItemFrame key={property} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang}>
                {label.text || property}
              </ContentItemHeading>
              {rows.map((statement, index) => (
                <Assertion key={index} statement={statement} read={context} locale={locale} />
              ))}
              <Button
                type="button"
                variant="outline"
                className={wrap}
                onClick={() => onJump(`people-fact-${property}`)}
              >
                {m.people_profile_review_open({}, o)}
              </Button>
            </ContentItemFrame>
          );
        })}
      </div>
    </section>
  );
}
