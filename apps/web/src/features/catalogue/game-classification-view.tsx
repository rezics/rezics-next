import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
import type { SnakInput, StatementInput } from './statement-editor';
import { gameUuid } from './game-profile';

function asRank(rank: string | undefined): NonNullable<StatementInput['rank']> {
  return rank === 'preferred' ? 'preferred' : 'normal';
}

function rankLabel(rank: string | undefined, locale: string) {
  const o = { locale: locale as never };
  return rank === 'preferred'
    ? m.candidate_rank_preferred({}, o)
    : rank === 'deprecated'
      ? m.changes_rank_deprecated({}, o)
      : m.candidate_rank_normal({}, o);
}

function itemId(value: SnakInput['value']): string | undefined {
  return value.type === 'value' && typeof value.content === 'string' && gameUuid.test(value.content)
    ? value.content
    : undefined;
}

/** Current selected Game classification: native identity, rank, qualifiers and grouped evidence. */
export function GameClassificationAssertion({
  statement,
  rank,
  read,
  locale,
  missing,
}: {
  statement: StatementInput | SnakInput | null | undefined;
  rank?: string | undefined;
  read: StatementFieldsRead;
  locale: string;
  missing: string;
}) {
  const o = { locale: locale as never };
  if (!statement) return <p className="text-sm text-muted-foreground">{missing}</p>;
  const shownRank = rank ?? ('rank' in statement ? (statement.rank as string | undefined) : undefined) ?? 'normal';
  const current: StatementInput =
    'references' in statement
      ? {
          property: { id: statement.property.id },
          value: statement.value,
          qualifiers: statement.qualifiers ?? [],
          references: statement.references.map((reference) => ({ parts: reference.parts })),
          rank: asRank(shownRank),
        }
      : {
          property: { id: statement.property.id },
          value: statement.value,
          qualifiers: [],
          references: [],
          rank: asRank(shownRank),
        };
  const target = itemId(current.value);
  const related = target ? read.public.related[target] : undefined;
  return (
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <div className="min-w-0 text-base leading-relaxed">
        <PartValue part={current} read={read} locale={locale} />
      </div>
      {target && (
        <p className="text-sm text-muted-foreground">
          {m.game_classification_target({ id: target }, o)}
          {!related && <> {m.candidate_value_unavailable({}, o)}</>}
        </p>
      )}
      <p className="text-sm">
        {m.candidate_rank({}, o)}: {rankLabel(shownRank, locale)}
      </p>
      <dl className="min-w-0 space-y-2 text-sm">
        {(current.qualifiers ?? []).map((part, index) => {
          const label = pickText(read.release.properties[part.property.id]?.labels ?? {}, locale);
          return (
            <div key={index} className="min-w-0 space-y-1">
              <dt className="text-muted-foreground" lang={label.lang ?? undefined}>
                {label.text || m.subject_value_unlabelled({}, o)}:{' '}
              </dt>
              <dd className="min-w-0">
                <PartValue part={part} read={read} locale={locale} />
              </dd>
            </div>
          );
        })}
      </dl>
      <ol className="min-w-0 space-y-3">
        {current.references.map((reference, index) => (
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

export function GameClassificationReuseNotes({
  copies,
  drafts,
  read,
  locale,
}: {
  copies: { holder: string; sourceProperty: string; index: number }[];
  drafts: { holder?: string; property: string; statement: StatementInput }[];
  read: StatementFieldsRead;
  locale: string;
}) {
  const o = { locale: locale as never };
  if (!copies.length) return null;
  return (
    <ul className="min-w-0 list-disc space-y-1 ps-5 text-sm">
      {copies.map((copy) => {
        const draft = drafts.find((item) => (item.holder ?? item.property) === copy.holder);
        const field =
          pageText(read.release.properties[draft?.property ?? copy.holder]?.labels, locale).text ||
          draft?.property ||
          copy.holder;
        const source =
          pageText(read.release.properties[copy.sourceProperty]?.labels, locale).text || copy.sourceProperty;
        const remaining = (draft?.statement.references.length ?? 0) - 1;
        return (
          <li key={`${copy.holder}:${copy.index}`}>
            {m.game_classification_reused_group({ number: copy.index + 1, field, source }, o)}
            {remaining > 0 ? ` ${m.game_classification_retained_groups({ field }, o)}` : ''}
          </li>
        );
      })}
    </ul>
  );
}
