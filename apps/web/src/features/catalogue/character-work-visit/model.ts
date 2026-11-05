import { CONNECTION_LIMIT, type ConnectionSection } from '../../pages/subject-connections';
import { holderItems, type Item } from '../../pages/overview';
import { isRecord, type Stmt } from '../../pages/shared';
import { relationRelated } from '../../pages/showcase-work/model';
import type { Related } from '../../../subject/types';

import { characterWorkStream } from './intent';
export { characterWorkStream, type CharacterWorkKind } from './intent';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CharacterWorkRow = {
  item: Item;
  holder: string;
  statement?: string;
  original?: Stmt;
  related: Related;
  performer?: { id: string; label: string };
};

/** One current native window; never pair assertions, hydrate targets or retain a discarded page. */
export function characterWorkRows(current: ConnectionSection, character: string, locale: string, level: number) {
  const kind = characterWorkStream(current.stream, character);
  if (!kind || !current.section.ok || !Array.isArray(current.section.body.links)) return [];
  return current.section.body.links.slice(0, CONNECTION_LIMIT).flatMap((row): CharacterWorkRow[] => {
    if (
      !isRecord(row) ||
      typeof row.subject !== 'string' ||
      !uuid.test(row.subject) ||
      !isRecord(row.summary) ||
      row.summary.id !== row.subject ||
      row.property !== current.stream.property
    )
      return [];
    // A summary, including its localized title and cover, must belong to this exact disclosed holder.
    const label = row.summary.label;
    const title =
      typeof label === 'string' ? label : isRecord(label) && typeof label.value === 'string' ? label.value : '';
    const item = holderItems({ links: [{ ...row, label: title }] }, 1, locale, level)?.items[0];
    if (!item) return [];
    const statement = typeof row.statement === 'string' && uuid.test(row.statement) ? row.statement : undefined;
    const assertion = row.assertion;
    const original =
      statement &&
      isRecord(assertion) &&
      assertion.id === statement &&
      isRecord(assertion.property) &&
      assertion.property.id === current.stream.property &&
      isRecord(assertion.value) &&
      Array.isArray(assertion.qualifiers) &&
      Array.isArray(assertion.references) &&
      (kind === 'appearance'
        ? assertion.value.type === 'value' && assertion.value.content === character
        : assertion.qualifiers.some(
            (part) =>
              isRecord(part) &&
              isRecord(part.property) &&
              part.property.id === 'wdt:P453' &&
              isRecord(part.value) &&
              part.value.type === 'value' &&
              part.value.content === character,
          ))
        ? (assertion as unknown as Stmt)
        : undefined;
    const related = relationRelated(row.related);
    const performerId =
      kind === 'performance' && original?.value.type === 'value' && typeof original.value.content === 'string'
        ? original.value.content
        : undefined;
    const performer = performerId && isRecord(row.related) ? row.related[performerId] : undefined;
    const performerLabel =
      isRecord(performer) &&
      performer.id === performerId &&
      isRecord(performer.label) &&
      typeof performer.label.value === 'string'
        ? performer.label.value
        : undefined;
    return [
      {
        item: { ...item, ...(original ? {} : { qualified: [] }) },
        holder: row.subject,
        ...(statement ? { statement } : {}),
        ...(original ? { original } : {}),
        related,
        ...(performerId && performerLabel ? { performer: { id: performerId, label: performerLabel } } : {}),
      },
    ];
  });
}
