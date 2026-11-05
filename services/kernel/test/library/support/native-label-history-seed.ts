import { requestKey } from './native-conformance.ts';
import type {
  LabelAction,
  LibraryLabelsDriver,
  LibraryLabelsInspection,
  NativeLabelRow,
  RetainedAssignmentRow,
} from '../../../../../specs/library-labels-driver.ts';

type Mutation = Extract<
  LabelAction,
  'library_label.create' | 'library_label.assign' | 'library_label.unassign' | 'library_label.delete'
>;

export interface NativeLabelHistoryCommand {
  action: Mutation;
  input: Record<string, unknown>;
  key: string;
  status: number;
  receipt: unknown;
  headers: { labelRevision: string | null; assignmentRevision: string | null };
}

export interface NativeLabelHistorySnapshot {
  labels: NativeLabelRow[];
  retainedAssignments: RetainedAssignmentRow[];
}

export interface NativeLabelHistorySeed {
  baseline: NativeLabelHistorySnapshot;
  observed: NativeLabelHistorySnapshot;
  commands: NativeLabelHistoryCommand[];
  clock: string;
}

type SeedDriver = Pick<LibraryLabelsDriver, 'invoke' | 'inspect' | 'now'>;

function snapshot(observation: LibraryLabelsInspection, subjectId: string): NativeLabelHistorySnapshot {
  const retainedAssignments = observation.retainedAssignments.filter((row) => row.subjectId === subjectId);
  const labelIds = new Set(retainedAssignments.map((row) => row.labelId));
  return {
    labels: observation.labels.filter((row) => labelIds.has(row.labelId)),
    retainedAssignments,
  };
}

function parentsById(labels: readonly NativeLabelRow[]) {
  return new Map(labels.map((label) => [label.labelId, label]));
}

function assignmentRows(snapshot: NativeLabelHistorySnapshot) {
  const parents = parentsById(snapshot.labels);
  return snapshot.retainedAssignments.map((assignment) => {
    const parent = parents.get(assignment.labelId);
    if (!parent) throw new Error(`Native label history is missing parent ${assignment.labelId}`);
    return { assignment, parent };
  });
}

function receiptObject(value: unknown, name: 'label' | 'assignment') {
  if (typeof value !== 'object' || value === null || !(name in value))
    throw new Error(`Native ${name} command receipt is missing its ${name}`);
  const result = (value as Record<string, unknown>)[name];
  if (typeof result !== 'object' || result === null) throw new Error(`Native ${name} receipt is malformed`);
  return result as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Native label history ${field} is absent`);
  return value;
}

function requiredRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`Native label history ${field} is not a positive observed revision`);
  return value;
}

/** Grow actual same-subject history with 32 reserved parent tombstones and individual unassigns. */
export async function seedNativeLabelHistory(
  driver: SeedDriver,
  subjectId: string,
  totalCount: number,
): Promise<NativeLabelHistorySeed> {
  if (!Number.isSafeInteger(totalCount) || totalCount < 33)
    throw new RangeError('Native label history needs at least 33 retained rows to mix 32 reservations and an unassign');

  const clock = driver.now();
  const before = snapshot(await driver.inspect({ owner: 'owner', subjectIds: [subjectId] }), subjectId);
  const existing = assignmentRows(before);
  const effectiveBefore = existing.filter(
    ({ assignment, parent }) =>
      assignment.slotNo !== null && assignment.deletedAt === null && parent.deletedAt === null,
  );
  if (effectiveBefore.length > 0) throw new Error('Native label history seed requires an inactive baseline subject');

  const commands: NativeLabelHistoryCommand[] = [];
  async function command(action: Mutation, input: Record<string, unknown>, expectedStatus: number) {
    const key = requestKey().slice(1, -1);
    const response = await driver.invoke('owner', action, input, key);
    const raw = await response.text();
    let receipt: unknown;
    try {
      receipt = JSON.parse(raw);
    } catch {
      receipt = raw;
    }
    const recorded: NativeLabelHistoryCommand = {
      action,
      input,
      key,
      status: response.status,
      receipt,
      headers: {
        labelRevision: response.headers.get('Library-Label-Revision'),
        assignmentRevision: response.headers.get('Library-Label-Assignment-Revision'),
      },
    };
    if (response.status !== expectedStatus)
      throw new Error(`Native ${action} returned HTTP ${response.status}, expected ${expectedStatus}: ${raw}`);
    commands.push(recorded);
    return recorded;
  }

  let existingReservations = existing.filter(({ assignment }) => assignment.slotNo !== null).length;
  if (existingReservations > 32) throw new Error('Native label history baseline already exceeds 32 reserved slots');

  const missingCount = Math.max(0, totalCount - existing.length);
  if (missingCount > 0 && existingReservations === 32) {
    const release = existing.find(
      ({ assignment, parent }) =>
        assignment.slotNo !== null && assignment.deletedAt === null && parent.deletedAt !== null,
    );
    if (!release) throw new Error('Native label history cannot free a reserved slot through an inactive parent');
    await command(
      'library_label.unassign',
      {
        labelId: release.assignment.labelId,
        subjectId,
        assignmentId: requiredString(release.assignment.assignmentId, 'assignment ID'),
        expectedRevision: requiredRevision(release.assignment.revision, 'assignment revision'),
      },
      200,
    );
    existingReservations -= 1;
  }

  const parentTombstonesNeeded = 32 - existingReservations;
  if (parentTombstonesNeeded > missingCount)
    throw new Error('Native label history cannot reach 32 reservations without exceeding the requested total');
  const finalParentTombstone = parentTombstonesNeeded > 0;
  const distributedParentTombstones = parentTombstonesNeeded - Number(finalParentTombstone);
  const distributedRows = missingCount - 1;

  for (let offset = 0; offset < missingCount; offset++) {
    const index = existing.length + offset;
    const parentTombstone =
      offset === missingCount - 1
        ? finalParentTombstone
        : distributedRows > 0 &&
          Math.floor(((offset + 1) * distributedParentTombstones) / distributedRows) >
            Math.floor((offset * distributedParentTombstones) / distributedRows);
    const created = await command('library_label.create', { name: `history ${subjectId} ${index}` }, 201);
    const label = receiptObject(created.receipt, 'label');
    const labelId = requiredString(label.id, 'label ID');
    const labelRevision = requiredRevision(label.revision, 'label revision');
    const assigned = await command('library_label.assign', { labelId, subjectId }, 200);
    const assignment = receiptObject(assigned.receipt, 'assignment');
    const assignmentId = requiredString(assignment.id, 'assignment ID');
    const assignmentRevision = requiredRevision(assignment.revision, 'assignment revision');

    if (parentTombstone) {
      await command('library_label.delete', { labelId, expectedRevision: labelRevision }, 200);
    } else {
      await command(
        'library_label.unassign',
        { labelId, subjectId, assignmentId, expectedRevision: assignmentRevision },
        200,
      );
    }
  }

  const observed = snapshot(await driver.inspect({ owner: 'owner', subjectIds: [subjectId] }), subjectId);
  const rows = assignmentRows(observed);
  const reservations = rows.filter(({ assignment }) => assignment.slotNo !== null);
  const parentTombstones = rows.filter(
    ({ assignment, parent }) =>
      assignment.slotNo !== null && assignment.deletedAt === null && parent.deletedAt !== null,
  );
  const individualUnassigns = rows.filter(
    ({ assignment }) => assignment.slotNo === null && assignment.deletedAt !== null,
  );
  const effective = rows.filter(
    ({ assignment, parent }) =>
      assignment.slotNo !== null && assignment.deletedAt === null && parent.deletedAt === null,
  );
  if (observed.retainedAssignments.length < totalCount)
    throw new Error(
      `Native label history retained ${observed.retainedAssignments.length} rows, expected at least ${totalCount}`,
    );
  if (reservations.length !== 32)
    throw new Error(`Native label history retained ${reservations.length} reserved slots, expected exactly 32`);
  if (new Set(reservations.map(({ assignment }) => assignment.assignmentId)).size !== 32)
    throw new Error('Native label history reservation identities are not unique');
  if (parentTombstones.length === 0 || individualUnassigns.length === 0)
    throw new Error('Native label history must contain both parent tombstones and individual unassigns');
  if (effective.length !== 0) throw new Error('Native label history left an effective assignment');
  if (driver.now() !== clock) throw new Error('Native label history seed changed the controlled clock');

  return { baseline: before, observed, commands, clock };
}
