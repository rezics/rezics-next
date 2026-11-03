import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import { PartValue } from './statement-editor-view';
import { characterDraft, characterGroups, type CharacterItem } from './character-profile';
import type { TermDraft } from './create-subject';
import { creationStatement, type StatementInput, type SnakInput } from './statement-editor';
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

function rankLabel(rank: string | undefined, locale: string) {
  const o = { locale: locale as never };
  return rank === 'preferred' ? m.candidate_rank_preferred({}, o) : m.candidate_rank_normal({}, o);
}

function StatementReadout({
  statement,
  release,
  locale,
}: {
  statement: StatementInput;
  release: Release;
  locale: string;
}) {
  const o = { locale: locale as never };
  const read = { release, public: { related: {} } };
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
              lang={pickText(release.properties[part.property.id]?.labels ?? {}, locale).lang ?? undefined}
            >
              {pickText(release.properties[part.property.id]?.labels ?? {}, locale).text ||
                m.subject_value_unlabelled({}, o)}
              :{' '}
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
                {reference.parts.map((part: SnakInput, partIndex: number) => (
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
  const descriptions = item.descriptions ?? {};
  const aliases = item.aliases ?? {};
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
                <StatementReadout statement={creationStatement(fact, release)} release={release} locale={locale} />
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
