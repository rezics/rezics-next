import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { PartValue, statementPartLabel } from './statement-reading';
import type { SnakInput, StatementFieldsRead, StatementInput } from './statement-editor-contract';

export function StatementSummary({
  statement,
  read,
  locale,
  notice,
}: {
  statement: Omit<StatementInput, 'rank'> & { rank?: StatementInput['rank'] | 'deprecated' };
  read: StatementFieldsRead;
  locale: string;
  notice?: ReactNode;
}) {
  const o = { locale: locale as never };
  const property = statementPartLabel(statement, read.release, locale);
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
        {(statement.qualifiers ?? []).map((part: SnakInput, index: number) => {
          const label = statementPartLabel(part, read.release, locale);
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
      {notice}
      <ol className="min-w-0 space-y-3">
        {statement.references.map((group, groupIndex) => (
          <li key={groupIndex} className="min-w-0 space-y-1 border-s-2 border-border ps-3">
            <p className="text-muted-foreground">
              {m.correction_references({}, o)} {groupIndex + 1}
            </p>
            {group.parts.length ? (
              <ul className="min-w-0 space-y-1">
                {group.parts.map((part, partIndex) => {
                  const label = statementPartLabel(part, read.release, locale);
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
        {statement.rank === 'preferred'
          ? m.candidate_rank_preferred({}, o)
          : statement.rank === 'deprecated'
            ? m.changes_rank_deprecated({}, o)
            : m.candidate_rank_normal({}, o)}
      </p>
    </div>
  );
}
