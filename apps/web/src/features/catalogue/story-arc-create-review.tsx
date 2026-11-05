import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
import { definitionText } from './definition-guide';
import type { Release } from '@rezics/definitions';
import type { StoryArcInitialItem, StoryArcPreparedIdentity } from './story-arc-create-model';
import { storyArcType } from './story-arc-profile';

const action =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

export function StoryArcCreateReview({
  item,
  release,
  locale,
  stale,
  identity,
  onOpen,
}: {
  item: StoryArcInitialItem;
  release: Release;
  locale: string;
  stale: boolean;
  identity?: StoryArcPreparedIdentity;
  onOpen: (id: string) => void;
}) {
  const o = { locale: locale as never };
  const context: StatementFieldsRead = {
    release,
    source: null,
    public: { related: {}, subject: { type: storyArcType } },
  };
  const aliases = Object.entries(item.aliases ?? {}) as [string, string[]][];
  const terms: { kind: string; language: string; value: string }[] = [
    ...Object.entries(item.labels).map(([language, value]) => ({
      kind: m.catalogue_create_label({}, o),
      language,
      value,
    })),
    ...Object.entries(item.descriptions ?? {}).map(([language, value]) => ({
      kind: m.catalogue_create_description({}, o),
      language,
      value,
    })),
    ...aliases.flatMap(([language, values]) =>
      values.map((value) => ({ kind: m.catalogue_create_aliases({}, o), language, value })),
    ),
  ];
  const facts = Object.entries(item.statements ?? {}).flatMap(([property, statements]) =>
    statements.map((statement, ordinal) => {
      const id = identity?.byProperty[property]?.[ordinal] ?? `${property}-${ordinal}`;
      const identityFact = identity?.facts.find((fact) => fact.id === id);
      const name = definitionText(release.properties[property]?.labels, locale).text || property;
      return { id, property, statement, identityFact, name };
    }),
  );

  return (
    <section
      data-slot="story-arc-create-review"
      aria-label={m.story_arc_create_review_title({}, o)}
      className="min-w-0 space-y-4 rounded-xl border border-border p-4 [overflow-wrap:anywhere] sm:p-5"
    >
      <h2 className="text-xl font-semibold">{m.story_arc_create_review_title({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.story_arc_create_review_intro({}, o)}</p>
      {stale && <p role="alert">{m.story_arc_create_review_stale({}, o)}</p>}
      <section aria-labelledby="story-arc-create-review-terms" className="space-y-2">
        <h3 id="story-arc-create-review-terms" className="font-semibold">
          {m.character_create_review_terms({}, o)}
        </h3>
        <ul className="space-y-2">
          {terms.map((term, index) => (
            <li key={`${term.kind}-${term.language}-${index}`} className="min-w-0 rounded-md bg-muted/50 p-3">
              <span className="font-medium">{term.kind}</span>
              <span className="ms-2 text-muted-foreground">{term.language}</span>
              <p lang={term.language} className="break-words">
                {term.value}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="story-arc-create-review-facts" className="space-y-2">
        <h3 id="story-arc-create-review-facts" className="font-semibold">
          {m.people_profile_initial({}, o)}
        </h3>
        {facts.length ? (
          <ol className="space-y-3">
            {facts.map(({ id, property, statement, identityFact, name }) => (
              <li key={id} data-statement-id={id} className="min-w-0 rounded-md bg-muted/50 p-3">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="font-medium">{name}</h4>
                    <p className="text-sm">
                      <PartValue part={statement} read={context} locale={locale} />
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {property} · {statement.rank ?? 'normal'}
                    </p>
                  </div>
                  <Button type="button" variant="outline" className={action} onClick={() => onOpen(id)}>
                    {m.character_create_review_open({}, o)}
                  </Button>
                </div>
                {!!statement.qualifiers?.length && (
                  <ul className="mt-2 space-y-1 border-s-2 border-border ps-3 text-sm">
                    {statement.qualifiers.map((part, index) => {
                      const qualifierId = identityFact?.qualifiers[index] ?? `${id}-qualifier-${index}`;
                      return (
                        <li key={qualifierId} data-part-id={qualifierId} className="min-w-0">
                          <span className="font-medium">
                            {definitionText(release.properties[part.property.id]?.labels, locale).text ||
                              part.property.id}
                          </span>
                          <span className="ms-2">
                            <PartValue part={part} read={context} locale={locale} />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!!statement.references.length && (
                  <ol className="mt-2 space-y-2 border-s-2 border-border ps-3 text-sm">
                    {statement.references.map((group, groupIndex) => {
                      const reference = identityFact?.references[groupIndex];
                      return (
                        <li key={reference?.id ?? `${id}-reference-${groupIndex}`} data-reference-id={reference?.id}>
                          <ol className="space-y-1">
                            {group.parts.map((part, partIndex) => {
                              const partId =
                                reference?.parts[partIndex] ?? `${id}-reference-${groupIndex}-part-${partIndex}`;
                              return (
                                <li key={partId} data-part-id={partId} className="min-w-0">
                                  <span className="font-medium">
                                    {definitionText(release.properties[part.property.id]?.labels, locale).text ||
                                      part.property.id}
                                  </span>
                                  <span className="ms-2">
                                    <PartValue part={part} read={context} locale={locale} />
                                  </span>
                                </li>
                              );
                            })}
                          </ol>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p>{m.story_arc_create_review_no_facts({}, o)}</p>
        )}
      </section>
      <p className="text-sm text-muted-foreground">{m.story_arc_create_review_native({}, o)}</p>
    </section>
  );
}
