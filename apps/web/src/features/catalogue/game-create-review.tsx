import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
import type { GameItem, GameRead } from './game-profile';
import {
  gameCreateGrain,
  gameCreateHolder,
  gameCreateNativeContent,
  gameCreateUnsupported,
  type GameCreateRow,
} from './game-create-review-model';
import type { SnakInput, StatementInput } from './statement-editor';

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

function NativePart({ part, read, locale }: { part: SnakInput; read: StatementFieldsRead; locale: string }) {
  const definition = read.release.properties[part.property.id];
  const datatype = definition?.datatype;
  const native = gameCreateNativeContent(part, datatype);
  const related = datatype === 'wikibase-item' && typeof native === 'string' ? read.public.related[native] : undefined;
  const relatedName = related ? pickText(related.labels, locale) : undefined;
  return (
    <div className="min-w-0 space-y-1">
      {datatype && (
        <p className="text-sm text-muted-foreground">
          <code className="break-all">{datatype}</code>
        </p>
      )}
      {native && (
        <p>
          <code className="break-all">{native}</code>
        </p>
      )}
      {relatedName?.text && (
        <p lang={relatedName.lang ?? undefined} className="text-sm text-muted-foreground">
          {relatedName.text}
        </p>
      )}
      {datatype !== 'wikibase-item' && datatype !== 'time' && datatype !== 'quantity' && (
        <PartValue part={part} read={read} locale={locale} />
      )}
    </div>
  );
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
        <NativePart part={statement} read={read} locale={locale} />
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
              <NativePart part={part} read={read} locale={locale} />
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
                    <NativePart part={part} read={read} locale={locale} />
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

function grainText(grain: ReturnType<typeof gameCreateGrain>, locale: string) {
  const o = { locale: locale as never };
  return grain === 'release'
    ? m.game_profile_review_grain_release({}, o)
    : grain === 'addon'
      ? m.game_profile_review_grain_addon({}, o)
      : m.game_profile_review_grain_work({}, o);
}

export function GameCreateReview({
  item,
  rows,
  read,
  locale,
  stale,
  onJump,
}: {
  item: GameItem;
  rows: readonly GameCreateRow[];
  read: Extract<GameRead, { ok: true }>;
  locale: string;
  stale: boolean;
  onJump: (id: string) => void;
}) {
  const o = { locale: locale as never };
  const type = read.release.types[item.type];
  const label = pickText(type?.labels ?? {}, locale);
  const grain = gameCreateGrain(read.release, item.type);
  const bases = type?.bases ?? [];
  const unsupported = gameCreateUnsupported(item, read.release);
  const context: StatementFieldsRead = {
    release: read.release,
    source: null,
    public: { related: read.public?.related ?? {}, subject: { type: item.type } },
  };
  const languages = [
    ...new Set([
      ...Object.keys(item.labels),
      ...Object.keys(item.descriptions ?? {}),
      ...Object.keys(item.aliases ?? {}),
    ]),
  ];
  const holders = new Map<string, GameCreateRow[]>();
  for (const row of rows) {
    const property = row.statement.property.id;
    const list = holders.get(property) ?? [];
    list.push(row);
    holders.set(property, list);
  }
  return (
    <section
      data-game-create-review
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label={m.game_profile_review_title({}, o)}
    >
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.game_profile_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.game_profile_review_intro({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.game_profile_review_independent({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.game_profile_review_stale({}, o)}
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{m.game_profile_review_type({}, o)}</h3>
        <p lang={label.lang ?? undefined}>{label.text || item.type}</p>
        <p className="text-sm">{grainText(grain, locale)}</p>
        {label.lang && (
          <p className="text-sm text-muted-foreground">
            {m.game_profile_review_type_language({ language: label.lang }, o)}
          </p>
        )}
        <p>
          <code className="break-all">{item.type}</code>
        </p>
        {!!bases.length && <p className="text-sm">{m.game_profile_review_bases({ bases: bases.join(', ') }, o)}</p>}
        <Button type="button" variant="outline" className={wrap} onClick={() => onJump('create-type')}>
          {m.game_profile_review_open({}, o)}
        </Button>
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.game_profile_review_terms({}, o)}</h3>
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
              {m.game_profile_review_open({}, o)}
            </Button>
          </ContentItemFrame>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-semibold">{m.game_profile_review_facts({}, o)}</h3>
        {Object.entries(item.statements).map(([property, statements]) => {
          const name = pickText(read.release.properties[property]?.labels ?? {}, locale);
          const retired = unsupported.includes(property);
          return (
            <ContentItemFrame key={property} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <ContentItemHeading level={3} className="text-base font-semibold" lang={name.lang ?? undefined}>
                {name.text || property}
              </ContentItemHeading>
              {retired && <p className="text-sm">{m.game_profile_review_unsupported({}, o)}</p>}
              {statements.map((statement, index) => {
                const row = holders.get(property)?.[index];
                return (
                  <div key={row?.key ?? `${property}-${index}`} className="min-w-0 space-y-2">
                    <Assertion statement={statement} read={context} locale={locale} />
                    <Button
                      type="button"
                      variant="outline"
                      className={wrap}
                      onClick={() => onJump(row ? `${gameCreateHolder(row.key)}-fact` : 'create-type')}
                    >
                      {m.game_profile_review_open({}, o)}
                    </Button>
                  </div>
                );
              })}
            </ContentItemFrame>
          );
        })}
      </div>
    </section>
  );
}
