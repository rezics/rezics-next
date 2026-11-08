import { creditAssertion } from '../catalogue/credit-inspection/model';
import { countFromLinks, hasMore, type Count } from '../count';
import type { SubjectSummary } from '../../media/summary';
import { qualifiedNotes } from './qualified-relations';
import { relationItemRows } from './relation-item-identity';
import { isRecord, spoilerLevel, type Stmt } from './shared';
import type { Item } from './overview';

/** The holders in the body of a `links` read, with its exact or "at least" count. */
export function holderItems(
  body: Record<string, unknown>,
  limit: number,
  locale = 'en',
  readerLevel = 0,
): { items: Item[]; count?: Count; more: boolean } | undefined {
  const rows = relationItemRows(body.links, 'links');
  if (!rows) return;
  const links = rows.slice(0, limit);
  const count = isRecord(body.count) ? body.count : undefined;
  const items = links.flatMap((link): Item[] =>
    typeof link.subject === 'string' && link.summary !== null
      ? [
          {
            id: link.subject,
            label: { text: typeof link.label === 'string' ? link.label : '', lang: undefined },
            ...(isRecord(link.summary) ? { summary: link.summary as unknown as SubjectSummary } : {}),
            ...(typeof link.type === 'string' ? { type: link.type } : {}),
            ...(typeof link.property === 'string' ? { property: link.property } : {}),
            ...(typeof link.date === 'string' ? { date: link.date } : {}),
            statement:
              typeof link.statement === 'string'
                ? link.statement
                : isRecord(link.assertion) && typeof link.assertion.id === 'string'
                  ? link.assertion.id
                  : undefined,
            notes: [],
            credit: creditAssertion(link),
            ...(isRecord(link.assertion) && Array.isArray(link.assertion.qualifiers)
              ? { qualified: qualifiedNotes(link.assertion as unknown as Stmt, link.related, locale) }
              : {}),
            gated:
              isRecord(link.assertion) && Array.isArray(link.assertion.qualifiers)
                ? spoilerLevel(link.assertion as unknown as Stmt) > readerLevel
                : false,
          },
        ]
      : [],
  );
  const total = countFromLinks(
    typeof count?.value === 'number' ? { value: count.value, exact: count.exact === true } : undefined,
    rows.length,
  );
  return {
    items,
    ...(total ? { count: total } : {}),
    more: hasMore(total, items.length) || body.next != null || rows.length > items.length,
  };
}
