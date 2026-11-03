import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { addonBase, addonFields } from './addon-profile';
import { addonBaseElementId, addonFactElementId, type AddonCapturedHolder } from './addon-create-address';
import { addonIncludedBase, addonUnsupportedProperties } from './addon-create-review-model';
import type { GameItem } from './game-profile';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
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
              lang={pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).lang ?? undefined}
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

function holderFor(
  property: string,
  index: number,
  captured: readonly AddonCapturedHolder[],
): AddonCapturedHolder | undefined {
  return captured.filter((holder) => holder.property === property)[index];
}

export function AddonCreateReview({
  item,
  captured,
  release,
  locale,
  stale,
  suggested,
  chosen,
  factsId,
  onJump,
}: {
  item: GameItem;
  captured: readonly AddonCapturedHolder[];
  release: Release;
  locale: string;
  stale: boolean;
  suggested: SubjectRead | null;
  chosen: SubjectRead | undefined;
  factsId: string;
  onJump: (id: string) => void;
}) {
  const o = { locale: locale as never };
  const typeLabel = pageText(release.types[item.type]?.labels, locale);
  const typeMeaning = pageText(release.types[item.type]?.descriptions, locale);
  const context: StatementFieldsRead = {
    release,
    source: null,
    public: { related: {}, subject: { type: item.type } },
  };
  const languages = [
    ...new Set([
      ...Object.keys(item.labels),
      ...Object.keys(item.descriptions ?? {}),
      ...Object.keys(item.aliases ?? {}),
    ]),
  ];
  const included = addonIncludedBase(item.statements, chosen?.subject ?? suggested?.subject);
  const includedTarget =
    included?.statement.value.type === 'value' ? String(included.statement.value.content) : undefined;
  const suggestionShown = suggested && suggested.subject.id !== includedTarget;
  const withdrawn = addonUnsupportedProperties(release, item.statements);
  const admitted = addonFields(release);
  return (
    <section
      data-addon-create-review
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={m.addon_create_review_title({}, o)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.addon_create_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.addon_create_review_intro({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.addon_create_review_reuse_base({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.addon_create_review_stale({}, o)}
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{m.addon_create_review_type({}, o)}</h3>
        <p lang={typeLabel.lang ?? undefined}>{typeLabel.text || item.type}</p>
        {typeMeaning.text && (
          <p className="text-sm text-muted-foreground" lang={typeMeaning.lang ?? undefined}>
            {typeMeaning.text}
          </p>
        )}
        <p>
          <code className="break-all">{item.type}</code>
        </p>
        <Button type="button" variant="outline" className={wrap} onClick={() => onJump('create-type')}>
          {m.addon_create_review_open({}, o)}
        </Button>
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.addon_create_review_terms({}, o)}</h3>
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
            <Button type="button" variant="outline" className={wrap} onClick={() => onJump(`create-label-${index}`)}>
              {m.addon_create_review_open({}, o)}
            </Button>
          </ContentItemFrame>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.addon_create_review_base({}, o)}</h3>
        {included ? (
          <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
            <p>{m.addon_create_review_base_included({}, o)}</p>
            <p>
              <code className="break-all">
                {included.statement.value.type === 'value' ? String(included.statement.value.content) : ''}
              </code>
              {included.subject ? ` · ${included.subject.type}` : ''}
            </p>
            {included.subject && (
              <p lang={pageText(included.subject.labels, locale).lang ?? undefined}>
                {pageText(included.subject.labels, locale).text || m.subject_value_unlabelled({}, o)}
              </p>
            )}
            <Assertion statement={included.statement} read={context} locale={locale} />
            {!admitted.includes(addonBase) && (
              <p role="status" className="text-sm">
                {m.addon_create_review_unsupported({}, o)}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className={wrap}
              onClick={() => {
                const holder = holderFor(addonBase, 0, captured);
                onJump(holder ? `${addonBaseElementId(holder.key)}-fact` : factsId);
              }}
            >
              {m.addon_create_review_open({}, o)}
            </Button>
          </ContentItemFrame>
        ) : (
          <p>{m.addon_create_review_base_omitted({}, o)}</p>
        )}
        {suggestionShown && (
          <p className="text-sm text-muted-foreground">
            {m.addon_create_review_suggestion({}, o)} <code className="break-all">{suggested.subject.id}</code>
          </p>
        )}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.addon_create_review_facts({}, o)}</h3>
        {Object.entries(item.statements ?? {})
          .filter(([property]) => property !== addonBase)
          .map(([property, rows]) => {
            const label = pickText(release.properties[property]?.labels ?? {}, locale);
            return (
              <ContentItemFrame key={property} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
                <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang ?? undefined}>
                  {label.text || property}
                </ContentItemHeading>
                {!admitted.includes(property) && (
                  <p role="status" className="text-sm">
                    {m.addon_create_review_unsupported({}, o)}
                  </p>
                )}
                {rows.map((statement, index) => {
                  const holder = holderFor(property, index, captured);
                  return (
                    <div key={holder?.key ?? index} className="min-w-0 space-y-2">
                      <Assertion statement={statement} read={context} locale={locale} />
                      <Button
                        type="button"
                        variant="outline"
                        className={wrap}
                        onClick={() => onJump(holder ? `${addonFactElementId(holder.key)}-fact` : factsId)}
                      >
                        {m.addon_create_review_open({}, o)}
                      </Button>
                    </div>
                  );
                })}
              </ContentItemFrame>
            );
          })}
      </div>
      {!!withdrawn.length && (
        <p className="text-sm text-muted-foreground">
          {m.addon_create_review_unsupported({}, o)}{' '}
          {withdrawn.map((id) => {
            const name = pickText(release.properties[id]?.labels ?? {}, locale);
            return (
              <span key={id} className="me-2" lang={name.lang ?? undefined}>
                {name.text || id}
              </span>
            );
          })}
        </p>
      )}
    </section>
  );
}
