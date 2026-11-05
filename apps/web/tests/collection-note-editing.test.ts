import { expect, test } from 'bun:test';
import {
  applyCollectionMemberEditPlan,
  buildCollectionMemberEditPlan,
  type CollectionMemberEditOperation,
} from '../src/library/collection-editor';
import type { CollectionMember } from '../src/library/reads';

const occurrence = (id: string, note: string | null) =>
  ({ id, note, subject: { id: 'same-subject' } }) as unknown as CollectionMember;

test('note plans use occurrence IDs and stay within the loaded-page command bound', async () => {
  const initial = Array.from({ length: 100 }, (_, index) =>
    occurrence(`occurrence-${index}`, index === 3 ? 'keep this note' : null),
  );
  const draft = initial.map((member, index) => (index === 50 ? { ...member, note: 'separate draft' } : member));
  expect(buildCollectionMemberEditPlan(initial, draft, true)).toEqual([
    { kind: 'note', memberId: 'occurrence-50', note: 'separate draft' },
  ]);

  const reversed = initial.toReversed().map((member, index) => ({ ...member, note: `note-${index}` }));
  const plan = buildCollectionMemberEditPlan(initial, reversed, true);
  expect(plan).toHaveLength(199);
  expect(plan.filter((operation) => operation.kind === 'note')).toHaveLength(100);
  expect(plan.filter((operation) => operation.kind === 'move')).toHaveLength(99);
  const commands: CollectionMemberEditOperation[] = Array.from({ length: 300 }, (_, index) => ({
    kind: 'note',
    memberId: `occurrence-${index}`,
    note: null,
  }));
  await expect(applyCollectionMemberEditPlan(commands, async () => ({ ok: true }))).rejects.toThrow(
    'Collection edit plan exceeds its per-page bound',
  );
});
