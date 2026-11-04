import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import { StatementSummary } from './statement-summary';
import { characterDraft, characterGroups, type CharacterItem } from './character-profile';
import type { TermDraft } from './create-subject';
import { creationStatement, type StatementInput } from './statement-editor';
import type { FactDraft } from './subject-facts';

export function characterCreateFingerprint(release: Release, terms: TermDraft[], facts: StatementInput[]) {
  const { item } = characterDraft(release, terms, facts);
  return JSON.stringify({ item, admitted: characterGroups(release) });
}

export function characterCreateDrafts(facts: readonly { id: number; fact: StatementInput }[]): FactDraft[] {
  return facts.map(({ id, fact }) => ({
    holder: String(id),
    property: fact.property.id,
    source: null,
    baseline: null,
    statement: fact,
    included: true,
  }));
}

const wrap =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';

export function CharacterCreateReview({
  item,
  facts,
  release,
  locale,
  stale,
  onJumpTerm,
  onJumpFact,
  onBack,
}: {
  item: CharacterItem;
  facts: readonly { id: number; fact: StatementInput }[];
  release: Release;
  locale: string;
  stale: boolean;
  onJumpTerm: (language: string) => void;
  onJumpFact: (id: number) => void;
  onBack: () => void;
}) {
  const o = { locale: locale as never };
  const languages = Object.keys(item.labels);
  const descriptions: Record<string, string> = item.descriptions ?? {};
  const aliases: Record<string, string[]> = item.aliases ?? {};
  return (
    <section
      data-slot="character-create-review"
      className="min-w-0 space-y-4"
      aria-label={m.character_create_review_title({}, o)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.character_create_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.character_create_review_intro({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.character_create_review_stale({}, o)}
        </p>
      )}
      <section className="min-w-0 space-y-3">
        <ContentItemHeading level={3} className="text-base font-semibold">
          {m.character_create_review_terms({}, o)}
        </ContentItemHeading>
        <ol className="min-w-0 space-y-3">
          {languages.map((language) => (
            <li key={language}>
              <ContentItemFrame as="div" className="min-w-0 space-y-2 rounded-xl bg-muted/30 p-4">
                <p className="font-medium" lang={language}>
                  {item.labels[language]}
                </p>
                <p className="text-sm text-muted-foreground">{language}</p>
                {descriptions[language] && (
                  <p className="text-sm" lang={language}>
                    {descriptions[language]}
                  </p>
                )}
                {(aliases[language] ?? []).length > 0 && (
                  <ul className="list-disc ps-5 text-sm">
                    {aliases[language]!.map((alias) => (
                      <li key={alias} lang={language}>
                        {alias}
                      </li>
                    ))}
                  </ul>
                )}
                <Button type="button" variant="outline" className={wrap} onClick={() => onJumpTerm(language)}>
                  {m.character_create_review_open({}, o)}
                </Button>
              </ContentItemFrame>
            </li>
          ))}
        </ol>
      </section>
      <ol className="min-w-0 space-y-4">
        {facts.map(({ id, fact }, index) => {
          const definition = release.properties[fact.property.id];
          const name = pickText(definition?.labels ?? {}, locale);
          return (
            <li key={id}>
              <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
                <ContentItemHeading level={3} className="text-base font-semibold" lang={name.lang ?? undefined}>
                  {m.character_create_correction_fact({ number: index + 1 }, o)}
                  {name.text ? ` · ${name.text}` : ''}
                </ContentItemHeading>
                <StatementSummary
                  statement={creationStatement(fact, release)}
                  read={{ release, source: null, public: { related: {}, subject: { type: item.type } } }}
                  locale={locale}
                />
                <Button type="button" variant="outline" className={wrap} onClick={() => onJumpFact(id)}>
                  {m.character_create_review_open({}, o)}
                </Button>
              </ContentItemFrame>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-muted-foreground">{m.character_create_review_native({}, o)}</p>
      <Button type="button" variant="outline" className={wrap} onClick={onBack}>
        {m.character_create_back({}, o)}
      </Button>
    </section>
  );
}
