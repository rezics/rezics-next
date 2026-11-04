import type { Item } from '../../pages/overview';
import type { ConnectionSection } from '../../pages/subject-connections';
import { isRecord } from '../../pages/shared';

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function displayable(item: Item): boolean {
  return subjectId.test(item.id) && !!item.summary && item.summary.id === item.id;
}

function publicCard(item: Item): Item {
  return {
    ...item,
    notes: [...item.notes, ...(item.qualified ?? []).map((note) => note.text)],
    qualified: undefined,
    credit: undefined,
    supportSlot: undefined,
    gated: false,
  };
}

/** Keep an association out of the rendered tree until its whole statement is admitted. */
export function characterAssociationDisclosure(
  current: ConnectionSection,
  items: readonly Item[],
): { visible: Item[]; spoiler: Item[]; withheld: boolean } {
  const { stream, section } = current;
  if (!section.ok) return { visible: [], spoiler: [], withheld: false };
  const raw = section.body[stream.direction === 'in' ? 'links' : 'relations'];
  if (!Array.isArray(raw)) return { visible: [], spoiler: [], withheld: true };
  const expectedTarget = (row: unknown) => {
    if (!isRecord(row)) return undefined;
    return stream.direction === 'in' ? row.subject : row.target;
  };
  const targets = raw.map(expectedTarget);
  const withheld =
    raw.length > items.length ||
    raw.some((row) => {
      const target = expectedTarget(row);
      return (
        typeof target !== 'string' ||
        !subjectId.test(target) ||
        !isRecord(row) ||
        !isRecord(row.summary) ||
        row.summary.id !== target
      );
    });
  const admitted = items.filter((item) => displayable(item) && targets.includes(item.id));
  return {
    visible: admitted.filter((item) => !item.gated).map(publicCard),
    spoiler: admitted.filter((item) => item.gated).map(publicCard),
    withheld: withheld || admitted.length < items.length,
  };
}

export function exactAssertionId(value: string | undefined): value is string {
  return typeof value === 'string' && subjectId.test(value);
}
