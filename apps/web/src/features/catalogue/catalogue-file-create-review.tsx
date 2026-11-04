import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { type StatementFieldsRead } from './statement-editor-view';
import { StatementSummary } from './statement-summary';
import {
  catalogueFileCreateGrain,
  catalogueFileCreateHolder,
  catalogueFileCreateHashNotice,
  catalogueFileCreateUnsupported,
  type CatalogueFileCreateHolder,
  type CatalogueFileCreateItem,
} from './catalogue-file-create';
import type { Release } from '@rezics/definitions';

const actionClass =
  'h-auto min-h-8 min-w-8 max-w-full whitespace-normal break-words py-2 [@media(max-width:639px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:639px)_and_(pointer:coarse)]:min-w-11';

export function CatalogueFileStatementSummary(props: Parameters<typeof StatementSummary>[0]) {
  const o = { locale: props.locale as never };
  const notice = catalogueFileCreateHashNotice(
    props.read.release,
    props.read.public.subject.type,
    props.statement.property.id,
  );
  return (
    <StatementSummary
      {...props}
      notice={
        notice === 'hash' ? (
          <p className="text-sm text-muted-foreground">{m.catalogue_file_hash_statement({}, o)}</p>
        ) : notice === 'codec' ? (
          <p className="text-sm text-muted-foreground">{m.catalogue_file_unknown_codec({}, o)}</p>
        ) : null
      }
    />
  );
}

export function CatalogueFileCreateReview({
  item,
  holders,
  release,
  locale,
  stale,
  factsId,
  onJump,
}: {
  item: CatalogueFileCreateItem;
  holders: readonly CatalogueFileCreateHolder[];
  release: Release;
  locale: string;
  stale: boolean;
  factsId: string;
  onJump: (id: string) => void;
}) {
  const o = { locale: locale as never };
  const typeLabel = pageText(release.types[item.type]?.labels, locale);
  const typeMeaning = pageText(release.types[item.type]?.descriptions, locale);
  const grain = catalogueFileCreateGrain(release, item.type);
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
  const withdrawn = catalogueFileCreateUnsupported(item, release);
  return (
    <section
      data-catalogue-file-create-review
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={m.catalogue_file_create_review_title({}, o)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.catalogue_file_create_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.catalogue_file_create_review_intro({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.catalogue_file_create_review_stale({}, o)}
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="font-semibold">{m.catalogue_file_create_review_type({}, o)}</h3>
        <p lang={typeLabel.lang ?? undefined}>{typeLabel.text || item.type}</p>
        {typeMeaning.text && (
          <p lang={typeMeaning.lang ?? undefined} className="text-sm text-muted-foreground">
            {typeMeaning.text}
          </p>
        )}
        {grain === 'file' && <p>{m.catalogue_file_create_file_grain({}, o)}</p>}
        {grain === 'group' && <p>{m.catalogue_file_create_group_grain({}, o)}</p>}
        <p className="text-sm text-muted-foreground">{m.catalogue_file_create_identity({}, o)}</p>
        <p>
          <code className="break-all">{item.type}</code>
        </p>
        <Button type="button" variant="outline" className={actionClass} onClick={() => onJump('create-type')}>
          {m.catalogue_file_create_review_open({}, o)}
        </Button>
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="font-semibold">{m.catalogue_file_create_review_terms({}, o)}</h3>
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
                  {m.catalogue_file_create_review_open({}, o)} · {m.catalogue_create_label({}, o)}
                </Button>
              )}
              {item.descriptions?.[language] && (
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  onClick={() => onJump(`create-description-${index}`)}
                >
                  {m.catalogue_file_create_review_open({}, o)} · {m.catalogue_create_description({}, o)}
                </Button>
              )}
              {!!item.aliases?.[language]?.length && (
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  onClick={() => onJump(`create-aliases-${index}`)}
                >
                  {m.catalogue_file_create_review_open({}, o)} · {m.catalogue_create_aliases({}, o)}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                onClick={() => onJump(`create-language-${index}`)}
              >
                {m.catalogue_file_create_review_open({}, o)} · {m.catalogue_create_language({}, o)}
              </Button>
            </div>
          </ContentItemFrame>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="font-semibold">{m.catalogue_file_create_review_facts({}, o)}</h3>
        {!Object.keys(item.statements).length && <p>{m.catalogue_file_create_no_fields({}, o)}</p>}
        {Object.entries(item.statements).map(([property, rows]) => {
          const label = pickText(release.properties[property]?.labels ?? {}, locale);
          const sameProperty = holders.filter((holder) => holder.property === property);
          return (
            <ContentItemFrame key={property} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang ?? undefined}>
                {label.text || property}
              </ContentItemHeading>
              {!release.types[item.type]?.properties.includes(property) && (
                <p role="status" className="text-sm">
                  {m.catalogue_file_create_review_unsupported({}, o)}
                </p>
              )}
              {rows.map((statement, index) => {
                const holder = sameProperty[index];
                const target = holder ? catalogueFileCreateHolder(holder.key) : factsId;
                return (
                  <div key={holder?.key ?? index} className="min-w-0 space-y-2">
                    <CatalogueFileStatementSummary statement={statement} read={read} locale={locale} />
                    <Button type="button" variant="outline" className={actionClass} onClick={() => onJump(target)}>
                      {m.catalogue_file_create_review_open({}, o)}
                    </Button>
                  </div>
                );
              })}
            </ContentItemFrame>
          );
        })}
        {!!withdrawn.length && (
          <p role="status" className="text-sm">
            {m.catalogue_file_create_review_unsupported({}, o)}{' '}
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
