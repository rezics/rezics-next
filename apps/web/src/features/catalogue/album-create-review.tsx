import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import { StatementSummary } from './statement-summary';
import { albumDraft, albumFields, albumType, type AlbumItem } from './album-profile';
import type { TermDraft } from './create-subject';
import { creationStatement, type StatementInput } from './statement-editor';
import { DefinitionMeaning } from './definition-meaning';
import { useLayoutEffect, useRef } from 'react';

const wrap =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';

export function albumCreateFingerprint(
  release: Release,
  terms: readonly TermDraft[],
  statements: readonly StatementInput[],
) {
  const { item } = albumDraft(release, [...terms], [...statements]);
  return JSON.stringify({ item, admitted: albumFields(release) });
}

export function AlbumCreateReview({
  item,
  rows,
  release,
  locale,
  stale,
  onJumpTerm,
  onJumpFact,
  onBack,
}: {
  item: AlbumItem;
  rows: readonly { id: string; statement: StatementInput }[];
  release: Release;
  locale: string;
  stale: boolean;
  onJumpTerm: (language: string) => void;
  onJumpFact: (id: string) => void;
  onBack: () => void;
}) {
  const o = { locale: locale as never };
  const staleMessage = useRef<HTMLParagraphElement>(null);
  const wasStale = useRef(false);
  useLayoutEffect(() => {
    if (stale && !wasStale.current && !document.activeElement?.matches('input, textarea, select'))
      staleMessage.current?.focus();
    wasStale.current = stale;
  }, [stale]);
  const languages = [
    ...new Set([
      ...Object.keys(item.labels),
      ...Object.keys(item.descriptions ?? {}),
      ...Object.keys(item.aliases ?? {}),
    ]),
  ];
  return (
    <section
      data-album-create-review
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={m.album_create_review_title({}, o)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.album_create_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.album_create_review_intro({}, o)}</p>
      {stale && (
        <p ref={staleMessage} role="status" tabIndex={-1} className="text-sm">
          {m.catalogue_create_review_stale({}, o)}
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{m.people_profile_review_type({}, o)}</h3>
        <p>
          <DefinitionMeaning values={release.types[albumType]?.labels} locale={locale} />
        </p>
        <p>
          <code className="break-all">{item.type}</code>
        </p>
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.catalogue_create_terms({}, o)}</h3>
        {languages.map((language) => (
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
            <Button type="button" variant="outline" className={wrap} onClick={() => onJumpTerm(language)}>
              {m.people_profile_review_open({}, o)}
            </Button>
          </ContentItemFrame>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.album_initial_facts({}, o)}</h3>
        {rows.map((row, index) => {
          const name = pickText(release.properties[row.statement.property.id]?.labels ?? {}, locale);
          return (
            <ContentItemFrame key={row.id} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <ContentItemHeading level={3} className="text-base font-semibold" lang={name.lang ?? undefined}>
                {name.text || row.statement.property.id}
                {` · ${index + 1}`}
              </ContentItemHeading>
              <StatementSummary
                statement={creationStatement(row.statement, release)}
                read={{ release, source: null, public: { related: {}, subject: { type: item.type } } }}
                locale={locale}
              />
              <Button type="button" variant="outline" className={wrap} onClick={() => onJumpFact(row.id)}>
                {m.people_profile_review_open({}, o)}
              </Button>
            </ContentItemFrame>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">{m.album_create_review_native({}, o)}</p>
      <Button type="button" variant="outline" className={wrap} onClick={onBack}>
        {m.character_create_back({}, o)}
      </Button>
    </section>
  );
}
