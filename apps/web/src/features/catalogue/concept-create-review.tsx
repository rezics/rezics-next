import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
import type { SnakInput, StatementInput } from './statement-editor';
import {
  conceptCreateHolder,
  conceptCreateUnsupported,
  conceptGrain,
  type ConceptCreateHolder,
  type ConceptCreateItem,
} from './concept-create';
import type { Release } from '@rezics/definitions';

const actionClass =
  'h-auto min-h-8 min-w-8 max-w-full whitespace-normal break-words py-2 [@media(max-width:639px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:639px)_and_(pointer:coarse)]:min-w-11';

function partLabel(part: SnakInput, release: Pick<Release, 'properties'>, locale: string) {
  const definition = release.properties[part.property.id];
  return {
    text: pickText(definition?.labels ?? {}, locale).text || part.property.id,
    language: pickText(definition?.labels ?? {}, locale).lang,
  };
}

export function ConceptStatementSummary({
  statement,
  read,
  locale,
}: {
  statement: StatementInput;
  read: StatementFieldsRead;
  locale: string;
}) {
  const o = { locale: locale as never };
  const property = partLabel(statement, read.release, locale);
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <dl className="min-w-0 space-y-2">
        <div>
          <dt lang={property.language ?? undefined} className="text-muted-foreground">
            {property.text}
          </dt>
          <dd>
            <code className="break-all">{statement.property.id}</code>
            <PartValue part={statement} read={read} locale={locale} />
          </dd>
        </div>
        {(statement.qualifiers ?? []).map((part, index) => {
          const label = partLabel(part, read.release, locale);
          return (
            <div key={index}>
              <dt lang={label.language ?? undefined} className="text-muted-foreground">
                {m.correction_qualifiers({}, o)} {index + 1}: {label.text}
              </dt>
              <dd>
                <code className="break-all">{part.property.id}</code>
                <PartValue part={part} read={read} locale={locale} />
              </dd>
            </div>
          );
        })}
      </dl>
      <ol className="min-w-0 space-y-3">
        {statement.references.map((group, groupIndex) => (
          <li key={groupIndex} className="min-w-0 space-y-1 border-s-2 border-border ps-3">
            <p className="text-muted-foreground">
              {m.correction_references({}, o)} {groupIndex + 1}
            </p>
            {group.parts.length ? (
              <ul className="min-w-0 space-y-1">
                {group.parts.map((part, partIndex) => {
                  const label = partLabel(part, read.release, locale);
                  return (
                    <li key={partIndex} className="min-w-0">
                      <span lang={label.language ?? undefined}>{label.text}: </span>
                      <code className="break-all">{part.property.id}</code>
                      <PartValue part={part} read={read} locale={locale} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-muted-foreground">{m.facts_reuse_empty({}, o)}</p>
            )}
          </li>
        ))}
      </ol>
      <p>
        {m.candidate_rank_normal({}, o)}
        {statement.rank !== 'normal' && (
          <>
            {' '}
            · <code>{statement.rank}</code>
          </>
        )}
      </p>
    </div>
  );
}

export function ConceptCreateReview({
  item,
  holders,
  release,
  locale,
  stale,
  factsId,
  onJump,
}: {
  item: ConceptCreateItem;
  holders: readonly ConceptCreateHolder[];
  release: Release;
  locale: string;
  stale: boolean;
  factsId: string;
  onJump: (id: string) => void;
}) {
  const o = { locale: locale as never };
  const typeLabel = pageText(release.types[item.type]?.labels, locale);
  const typeMeaning = pageText(release.types[item.type]?.descriptions, locale);
  const grain = conceptGrain(release, item.type);
  const read: StatementFieldsRead = {
    release,
    source: null,
    public: { subject: { type: item.type }, related: {} },
  };
  const languages = [
    ...new Set([
      ...Object.keys(item.labels),
      ...Object.keys(item.descriptions ?? {}),
      ...Object.keys(item.aliases ?? {}),
    ]),
  ];
  const withdrawn = conceptCreateUnsupported(item, release);
  const statements = item.statements ?? {};
  return (
    <section
      data-concept-create-review
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={m.concept_create_review_title({}, o)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.concept_create_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.concept_create_review_intro({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.concept_create_review_stale({}, o)}
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="font-semibold">{m.concept_create_review_type({}, o)}</h3>
        <p lang={typeLabel.lang ?? undefined}>{typeLabel.text || item.type}</p>
        <p>{grain === 'scheme' ? m.concept_create_grain_scheme({}, o) : m.concept_create_grain_concept({}, o)}</p>
        {typeMeaning.text && (
          <p lang={typeMeaning.lang ?? undefined} className="text-sm text-muted-foreground">
            {typeMeaning.text}
          </p>
        )}
        <p>
          <code className="break-all">{item.type}</code>
        </p>
        <Button type="button" variant="outline" className={actionClass} onClick={() => onJump('create-type')}>
          {m.concept_create_review_open({}, o)}
        </Button>
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="font-semibold">{m.concept_create_review_terms({}, o)}</h3>
        {languages.map((language, index) => (
          <ContentItemFrame key={language} as="div" className="min-w-0 space-y-2 rounded-xl bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground">{language}</p>
            {item.labels[language] && (
              <p lang={language} className="font-medium">
                {item.labels[language]}
              </p>
            )}
            {item.descriptions?.[language] && <p lang={language}>{item.descriptions[language]}</p>}
            {!!item.aliases?.[language]?.length && (
              <ul lang={language} className="list-disc ps-5">
                {item.aliases[language]!.map((alias: string, aliasIndex: number) => (
                  <li key={aliasIndex}>{alias}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              {item.labels[language] && (
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  onClick={() => onJump(`create-label-${index}`)}
                >
                  {m.concept_create_review_open({}, o)} · {m.catalogue_create_label({}, o)}
                </Button>
              )}
              {item.descriptions?.[language] && (
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  onClick={() => onJump(`create-description-${index}`)}
                >
                  {m.concept_create_review_open({}, o)} · {m.catalogue_create_description({}, o)}
                </Button>
              )}
              {!!item.aliases?.[language]?.length && (
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  onClick={() => onJump(`create-aliases-${index}`)}
                >
                  {m.concept_create_review_open({}, o)} · {m.catalogue_create_aliases({}, o)}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                onClick={() => onJump(`create-language-${index}`)}
              >
                {m.concept_create_review_open({}, o)} · {m.catalogue_create_language({}, o)}
              </Button>
            </div>
          </ContentItemFrame>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="font-semibold">{m.concept_create_review_facts({}, o)}</h3>
        {!Object.keys(statements).length && <p>{m.concept_create_no_fields({}, o)}</p>}
        {Object.entries(statements).map(([property, rows]) => {
          const label = pickText(release.properties[property]?.labels ?? {}, locale);
          const sameProperty = holders.filter((holder) => holder.property === property);
          return (
            <ContentItemFrame key={property} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang ?? undefined}>
                {label.text || property}
              </ContentItemHeading>
              {!release.types[item.type]?.properties.includes(property) && (
                <p role="status" className="text-sm">
                  {m.concept_create_review_unsupported({}, o)}
                </p>
              )}
              {rows.map((statement, index) => {
                const holder = sameProperty[index];
                const target = holder ? conceptCreateHolder(holder.key) : factsId;
                return (
                  <div key={holder?.key ?? index} className="min-w-0 space-y-2">
                    <ConceptStatementSummary statement={statement} read={read} locale={locale} />
                    <Button type="button" variant="outline" className={actionClass} onClick={() => onJump(target)}>
                      {m.concept_create_review_open({}, o)}
                    </Button>
                  </div>
                );
              })}
            </ContentItemFrame>
          );
        })}
        {!!withdrawn.length && (
          <p role="status" className="text-sm">
            {m.concept_create_review_unsupported({}, o)}{' '}
            {withdrawn.map((property) => (
              <code key={property} className="me-2 break-all">
                {property}
              </code>
            ))}
          </p>
        )}
      </div>
    </section>
  );
}
