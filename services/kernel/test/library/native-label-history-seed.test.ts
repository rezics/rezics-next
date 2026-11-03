import { expect, test } from 'bun:test';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { createLibraryLabelsDriver } from './support/native-labels-driver.ts';
import {
  seedNativeLabelHistory,
  type NativeLabelHistoryCommand,
  type NativeLabelHistorySeed,
} from './support/native-label-history-seed.ts';

const scales = [64, 512, 4096] as const;

function checkSeed(seed: NativeLabelHistorySeed, totalCount: number) {
  const parents = new Map(seed.observed.labels.map((label) => [label.labelId, label]));
  const history = seed.observed.retainedAssignments;
  const reservations = history.filter((assignment) => assignment.slotNo !== null);
  const parentTombstones = history.filter(
    (assignment) =>
      assignment.slotNo !== null && assignment.deletedAt === null && parents.get(assignment.labelId)?.deletedAt,
  );
  const individualUnassigns = history.filter(
    (assignment) => assignment.slotNo === null && assignment.deletedAt !== null,
  );
  const effective = history.filter(
    (assignment) =>
      assignment.slotNo !== null &&
      assignment.deletedAt === null &&
      parents.get(assignment.labelId)?.deletedAt === null,
  );

  expect(history.length).toBeGreaterThanOrEqual(totalCount);
  expect(reservations).toHaveLength(32);
  expect(parentTombstones.length).toBeGreaterThan(0);
  expect(individualUnassigns.length).toBeGreaterThan(0);
  expect(effective).toEqual([]);
}

async function everythingSubjects(driver: Awaited<ReturnType<typeof createLibraryLabelsDriver>>, collectionId: string) {
  const subjects: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const response = await driver.request('owner', {
      method: 'GET',
      path: `/v1/collections/${collectionId}/members?${query}`,
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { members: { subjectId: string }[]; next: string | null };
    subjects.push(...page.members.map((member) => member.subjectId));
    cursor = page.next;
  } while (cursor);
  return subjects;
}

function assignmentId(command: NativeLabelHistoryCommand): string {
  const receipt = command.receipt as { assignment?: { id?: unknown } };
  if (typeof receipt.assignment?.id !== 'string') throw new Error('Native assignment receipt omitted its ID');
  return receipt.assignment.id;
}

test('native label history seed grows mixed retained rows to the requested scales and keeps Everything effective-only', async () => {
  const driver = await createLibraryLabelsDriver();
  try {
    const everythingId = builtinCollectionId(driver.accounts.owner.id, { kind: 'everything' });
    const subject = await driver.provisionSubject();
    const commands: NativeLabelHistoryCommand[] = [];
    let last: NativeLabelHistorySeed | undefined;

    for (const scale of scales) {
      last = await seedNativeLabelHistory(driver, subject.id, scale);
      commands.push(...last.commands);
      if (scale === scales[0]) expect(last.baseline.retainedAssignments).toEqual([]);
      checkSeed(last, scale);

      const rerun = await seedNativeLabelHistory(driver, subject.id, scale);
      expect(rerun.commands).toEqual([]);
      expect(rerun.observed.retainedAssignments).toHaveLength(last.observed.retainedAssignments.length);
      checkSeed(rerun, scale);

      const listed = await driver.invoke('owner', 'library_label.assignment_list', {
        subjectId: subject.id,
        limit: 100,
        view: 'FULL',
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ assignments: [], next: null });
      expect(await everythingSubjects(driver, everythingId)).not.toContain(subject.id);
    }

    const finalHistory = last!.observed.retainedAssignments;
    const reservationIds = finalHistory
      .filter((assignment) => assignment.slotNo !== null)
      .map((assignment) => assignment.assignmentId);
    expect(reservationIds.every((id): id is string => typeof id === 'string')).toBe(true);
    expect(new Set(reservationIds).size).toBe(32);

    const assignmentIds = new Map<string, string>();
    const reservedLabelIds = new Set<string>();
    for (const command of commands) {
      const labelId = command.input.labelId;
      if (typeof labelId !== 'string') continue;
      if (command.action === 'library_label.assign') assignmentIds.set(labelId, assignmentId(command));
      if (command.action === 'library_label.delete') reservedLabelIds.add(labelId);
      if (command.action === 'library_label.unassign') reservedLabelIds.delete(labelId);
    }
    const expectedReservationIds = [...reservedLabelIds]
      .map((labelId) => {
        const id = assignmentIds.get(labelId);
        if (!id) throw new Error(`Native reservation ${labelId} has no original assignment receipt`);
        return id;
      })
      .sort();
    expect(expectedReservationIds).toHaveLength(32);
    expect(reservationIds.sort()).toEqual(expectedReservationIds);

    for (const action of [
      'library_label.create',
      'library_label.assign',
      'library_label.unassign',
      'library_label.delete',
    ] as const) {
      const original = commands.find((command) => command.action === action)!;
      const replay = await driver.invoke('owner', original.action, original.input, original.key);
      expect(replay.status).toBe(original.status);
      expect(await replay.json()).toEqual(original.receipt);
      expect(replay.headers.get('Library-Label-Revision')).toBe(original.headers.labelRevision);
      expect(replay.headers.get('Library-Label-Assignment-Revision')).toBe(original.headers.assignmentRevision);
    }
  } finally {
    await driver.close();
  }
}, 900_000);
