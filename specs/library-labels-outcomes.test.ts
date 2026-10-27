import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LibraryLabelsDriver,
  LibraryLabelsPersona,
  LibraryLabelsInspection,
  NativeAssignmentRow,
  NativeLabelRow,
} from './library-labels-driver.ts';

setDefaultTimeout(240_000);

const missingDriver = 'Library label outcome driver is required';
let driver: LibraryLabelsDriver;
let serial = 0;

beforeEach(async () => {
  const location = process.env.LIBRARY_LABELS_DRIVER;
  if (!location) throw new Error(missingDriver);
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_LABELS_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_LABELS_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryLabelsDriver !== 'function')
    throw new Error('Expected createLibraryLabelsDriver factory');
  driver = await binding.createLibraryLabelsDriver();
});

afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});

const key = () => `library-label-${++serial}`;

interface LabelView {
  id: string;
  name?: string;
  revision: number;
}

interface AssignmentView {
  id: string;
  labelId: string;
  subjectId: string;
  revision: number;
}

interface LabelPage {
  labels: LabelView[];
  next: string | null;
}

interface AssignmentPage {
  assignments: AssignmentView[];
  next: string | null;
}

async function body<T>(response: Response): Promise<T> {
  return (await response.clone().json()) as T;
}

async function createLabel(
  name: string,
  as: LibraryLabelsPersona = 'owner',
  idempotencyKey = key(),
): Promise<{ response: Response; label: LabelView }> {
  const response = await driver.invoke(as, 'library_label.create', { name }, idempotencyKey);
  expect(response.status).toBe(201);
  const value = await body<{ label: LabelView }>(response);
  return { response, label: value.label };
}

async function renameLabel(
  labelId: string,
  expectedRevision: number,
  name: string,
  idempotencyKey = key(),
  as: LibraryLabelsPersona = 'owner',
): Promise<Response> {
  return driver.invoke(as, 'library_label.rename', { labelId, expectedRevision, name }, idempotencyKey);
}

async function deleteLabel(
  labelId: string,
  expectedRevision: number,
  idempotencyKey = key(),
  as: LibraryLabelsPersona = 'owner',
): Promise<Response> {
  return driver.invoke(as, 'library_label.delete', { labelId, expectedRevision }, idempotencyKey);
}

async function assignLabel(
  subjectId: string,
  labelId: string,
  idempotencyKey = key(),
  as: LibraryLabelsPersona = 'owner',
): Promise<{ response: Response; assignment: AssignmentView }> {
  const response = await driver.invoke(as, 'library_label.assign', { subjectId, labelId }, idempotencyKey);
  const value = await body<{ assignment: AssignmentView }>(response);
  return { response, assignment: value.assignment };
}

function assignmentRows(rows: readonly NativeAssignmentRow[], labelId: string, subjectId?: string) {
  return rows.filter((row) => row.labelId === labelId && (subjectId === undefined || row.subjectId === subjectId));
}

function liveLabelRows(rows: readonly NativeLabelRow[], labelId: string) {
  return rows.filter((row) => row.labelId === labelId && row.deletedAt === null);
}

async function labelPage(as: LibraryLabelsPersona, input: Record<string, unknown> = {}) {
  const response = await driver.invoke(as, 'library_label.list', input);
  return { response, page: await body<LabelPage>(response) };
}

async function assignmentPage(as: LibraryLabelsPersona, input: Record<string, unknown>) {
  const response = await driver.invoke(as, 'library_label.assignment_list', input);
  return { response, page: await body<AssignmentPage>(response) };
}

function labelEventRows(state: LibraryLabelsInspection, labelId: string) {
  return state.privateOutbox.filter((event) => event.data.labelId === labelId);
}

test('independent personal labels coexist with exclusive state and disclose nothing without a Collection', async () => {
  const subject = await driver.provisionSubject();
  const first = await createLabel('PRIVATE WANT TO READ');
  const second = await createLabel('PRIVATE REVISIT');
  expect(first.response.status).toBe(201);
  expect(second.response.status).toBe(201);
  expect((await driver.setState('owner', subject.id, 'in_progress')).ok).toBe(true);

  const publicBefore = await driver.publicExposure(subject.id);
  const firstAssignment = await assignLabel(subject.id, first.label.id);
  const secondAssignment = await assignLabel(subject.id, second.label.id);
  expect(firstAssignment.response.status).toBe(200);
  expect(secondAssignment.response.status).toBe(200);
  const bySubject = await driver.invoke('owner', 'library_label.assignment_list', {
    subjectId: subject.id,
    limit: 100,
  });
  expect(bySubject.status).toBe(200);
  expect((await body<AssignmentPage>(bySubject)).assignments.map((assignment) => assignment.labelId).sort()).toEqual(
    [first.label.id, second.label.id].sort(),
  );

  const rows = await driver.inspect({
    owner: 'owner',
    subjectIds: [subject.id],
    labelIds: [first.label.id, second.label.id],
  });
  expect(rows.entries.find((entry) => entry.subjectId === subject.id)?.state).toBe('in_progress');
  expect(assignmentRows(rows.assignments, first.label.id, subject.id)).toHaveLength(1);
  expect(assignmentRows(rows.assignments, second.label.id, subject.id)).toHaveLength(1);
  expect(rows.publicSubjectRows).toEqual([]);

  const publicAfter = await driver.publicExposure(subject.id);
  expect(publicAfter.publicRows).toEqual(publicBefore.publicRows);
  const publicText = JSON.stringify(publicAfter);
  for (const privateValue of [first.label.id, second.label.id, 'PRIVATE WANT TO READ', 'PRIVATE REVISIT'])
    expect(publicText).not.toContain(privateValue);
});

test('reapplying one assignment has one native row and one private assignment effect', async () => {
  const subject = await driver.provisionSubject();
  const { label } = await createLabel('one assignment');
  const first = await assignLabel(subject.id, label.id, key());
  expect(first.response.status).toBe(200);
  const afterFirst = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });
  const outboxAfterFirst = labelEventRows(afterFirst, label.id);

  const [repeated, concurrent] = await Promise.all([
    assignLabel(subject.id, label.id, key()),
    assignLabel(subject.id, label.id, key()),
  ]);
  expect(repeated.response.status).toBe(200);
  expect(concurrent.response.status).toBe(200);
  expect(repeated.assignment).toEqual(first.assignment);
  expect(concurrent.assignment).toEqual(first.assignment);
  const afterRepeated = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });
  expect(assignmentRows(afterRepeated.assignments, label.id, subject.id)).toHaveLength(1);
  expect(afterRepeated.subjectFacts.filter((fact) => fact.kind === 'label' && fact.sourceId === label.id)).toHaveLength(
    1,
  );
  expect(labelEventRows(afterRepeated, label.id)).toEqual(outboxAfterFirst);
});

test('a subject has a race-safe cap of 32 distinct stored labels while duplicate assignment still succeeds', async () => {
  const subject = await driver.provisionSubject();
  const labels: LabelView[] = [];
  for (let index = 0; index < 33; index++) {
    const created = await createLabel(`bounded label ${String(index).padStart(2, '0')}`);
    labels.push(created.label);
  }
  const firstAssignment = await assignLabel(subject.id, labels[0]!.id);
  expect(firstAssignment.response.status).toBe(200);
  for (const label of labels.slice(1, 31)) {
    const assigned = await assignLabel(subject.id, label.id);
    expect(assigned.response.status).toBe(200);
  }

  const [edgeA, edgeB] = await Promise.all([
    assignLabel(subject.id, labels[31]!.id, key()),
    assignLabel(subject.id, labels[32]!.id, key()),
  ]);
  expect([edgeA.response.status, edgeB.response.status].sort()).toEqual([200, 409]);
  const eventsBeforeDuplicate = await driver.inspect({
    owner: 'owner',
    subjectIds: [subject.id],
    labelIds: [labels[0]!.id],
  });
  const duplicate = await assignLabel(subject.id, labels[0]!.id, key());
  expect(duplicate.response.status).toBe(200);
  expect(duplicate.assignment).toEqual(firstAssignment.assignment);
  const rows = await driver.inspect({
    owner: 'owner',
    subjectIds: [subject.id],
    labelIds: labels.slice(0, 33).map((label) => label.id),
  });
  expect(rows.assignments.filter((assignment) => assignment.subjectId === subject.id)).toHaveLength(32);
  expect(
    rows.subjectFacts.filter((fact) => fact.subjectId === subject.id && fact.kind === 'label' && fact.active),
  ).toHaveLength(32);
  expect(labelEventRows(rows, labels[0]!.id)).toEqual(labelEventRows(eventsBeforeDuplicate, labels[0]!.id));
});

test('owner partition and active library admission gate owner other anonymous suspended and scope-less actors', async () => {
  const subject = await driver.provisionSubject();
  const created = await createLabel('owner-only', 'owner');
  expect(created.response.status).toBe(201);
  await assignLabel(subject.id, created.label.id);
  expect(driver.accounts.unscoped.id).toBe(driver.accounts.owner.id);

  for (const persona of ['other', 'anonymous', 'suspended', 'unscoped'] as const) {
    const read = await driver.invoke(persona, 'library_label.assignment_list', {
      labelId: created.label.id,
      limit: 20,
    });
    expect(read.ok).toBe(false);
    const mutation = await renameLabel(created.label.id, created.label.revision, `changed-${persona}`, key(), persona);
    expect(mutation.ok).toBe(false);
    expect((await mutation.clone().text()).includes(created.label.id)).toBe(false);
    expect((await mutation.clone().text()).includes('owner-only')).toBe(false);
  }

  const receiptKey = key();
  const receipt = await createLabel('receipt-private', 'owner', receiptKey);
  expect(receipt.response.status).toBe(201);
  const beforeReplay = await driver.inspect({ owner: 'owner', labelIds: [receipt.label.id] });
  const deniedReplay = await driver.invoke('unscoped', 'library_label.create', { name: 'receipt-private' }, receiptKey);
  expect(deniedReplay.ok).toBe(false);
  expect((await deniedReplay.clone().text()).includes(receipt.label.id)).toBe(false);
  const afterReplay = await driver.inspect({ owner: 'owner', labelIds: [receipt.label.id] });
  expect(afterReplay.receipts).toEqual(beforeReplay.receipts);
});

test('receipt replay completes current authorization before lookup and skips lookup on denial', async () => {
  const receiptKey = key();
  const created = await createLabel('receipt admission order', 'owner', receiptKey);
  const allowed = await driver.traceCommand(() =>
    driver.invoke('owner', 'library_label.create', { name: 'receipt admission order' }, receiptKey),
  );
  expect(allowed.value.status).toBe(201);
  const allowedAdmission = allowed.events.find((event) => event.phase === 'admission_complete');
  const allowedReceiptRead = allowed.events.find((event) => event.phase === 'receipt_read');
  if (allowedAdmission?.phase !== 'admission_complete' || allowedReceiptRead?.phase !== 'receipt_read')
    throw new Error('Expected an admission event followed by a receipt read');
  expect(allowedAdmission.authorized).toBe(true);
  expect(allowedReceiptRead.sequence).toBeGreaterThan(allowedAdmission.sequence);

  const denied = await driver.traceCommand(() =>
    driver.invoke('unscoped', 'library_label.create', { name: 'receipt admission order' }, receiptKey),
  );
  expect(denied.value.ok).toBe(false);
  expect(denied.events.some((event) => event.phase === 'admission_complete' && !event.authorized)).toBe(true);
  expect(denied.events.some((event) => event.phase === 'receipt_read')).toBe(false);
  expect((await denied.value.clone().text()).includes(created.label.id)).toBe(false);
});

test('foreign and unknown owner-scoped label identifiers have the same not-found result', async () => {
  const subject = await driver.provisionSubject();
  const foreign = await createLabel('other account label', 'other');
  expect(foreign.response.status).toBe(201);
  await assignLabel(subject.id, foreign.label.id, key(), 'other');

  const foreignRead = await driver.invoke('owner', 'library_label.assignment_list', {
    labelId: foreign.label.id,
    limit: 20,
  });
  const unknownRead = await driver.invoke('owner', 'library_label.assignment_list', {
    labelId: driver.unknown.labelId,
    limit: 20,
  });
  expect(foreignRead.status).toBe(404);
  expect(await body<unknown>(foreignRead)).toEqual(await body<unknown>(unknownRead));
  expect(unknownRead.status).toBe(404);
});

test('assignment requires an admitted catalogue subject and unknown subjects create no owner fact', async () => {
  const { label } = await createLabel('subject admission');
  const missingSubject = await driver.invoke(
    'owner',
    'library_label.assign',
    {
      subjectId: driver.unknown.subjectId,
      labelId: label.id,
    },
    key(),
  );
  expect(missingSubject.status).toBe(404);
  const rows = await driver.inspect({ owner: 'owner', subjectIds: [driver.unknown.subjectId], labelIds: [label.id] });
  expect(rows.assignments).toEqual([]);
  expect(rows.subjectFacts).toEqual([]);
});

test('a foreign label query is hidden as not-found from another account', async () => {
  const subject = await driver.provisionSubject();
  const ownerLabel = await createLabel('owner private search value');
  await assignLabel(subject.id, ownerLabel.label.id);
  const unknown = driver.unknown.labelId;

  const foreign = await driver.invoke('other', 'library_label.assignment_list', {
    labelId: ownerLabel.label.id,
    limit: 20,
  });
  const absent = await driver.invoke('other', 'library_label.assignment_list', { labelId: unknown, limit: 20 });
  expect(foreign.status).toBe(404);
  expect(await body<unknown>(foreign)).toEqual(await body<unknown>(absent));
  expect((await foreign.clone().text()).includes('owner private search value')).toBe(false);
});

test('normalized same-name labels conflict while rename preserves identity and delete permits a new identity', async () => {
  const subject = await driver.provisionSubject();
  const first = await createLabel('  Caf\u00e9  Shelf ');
  expect(first.response.status).toBe(201);
  const duplicate = await driver.invoke('owner', 'library_label.create', { name: 'Cafe\u0301   Shelf' }, key());
  expect(duplicate.status).toBe(409);
  const caseDistinct = await createLabel('caf\u00e9 shelf');
  expect(caseDistinct.response.status).toBe(201);
  expect(caseDistinct.label.id).not.toBe(first.label.id);

  await assignLabel(subject.id, first.label.id);
  const renamed = await renameLabel(first.label.id, first.label.revision, 'Reading later');
  expect(renamed.status).toBe(200);
  const renamedValue = await body<{ label: LabelView }>(renamed);
  expect(renamedValue.label).toEqual({ id: first.label.id, revision: first.label.revision + 1 });
  const afterRename = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [first.label.id] });
  expect(liveLabelRows(afterRename.labels, first.label.id)).toHaveLength(1);
  expect(assignmentRows(afterRename.assignments, first.label.id, subject.id)).toHaveLength(1);

  expect((await deleteLabel(first.label.id, renamedValue.label.revision)).status).toBe(200);
  const recreated = await createLabel('Caf\u00e9 Shelf');
  expect(recreated.response.status).toBe(201);
  expect(recreated.label.id).not.toBe(first.label.id);
  const listed = await labelPage('owner', { limit: 100 });
  expect(listed.page.labels.some((label) => label.id === first.label.id)).toBe(false);
  expect(listed.page.labels.some((label) => label.id === recreated.label.id)).toBe(true);
});

test('stale label and assignment CAS revisions conflict without changing native rows', async () => {
  const subject = await driver.provisionSubject();
  const { label } = await createLabel('compare and swap');
  const assignment = await assignLabel(subject.id, label.id);
  const rename = await renameLabel(label.id, label.revision, 'current name');
  expect(rename.status).toBe(200);
  const afterRename = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });

  const staleRename = await renameLabel(label.id, label.revision, 'stale name');
  const staleDelete = await deleteLabel(label.id, label.revision);
  expect(staleRename.status).toBe(409);
  expect(staleDelete.status).toBe(409);

  const removed = await driver.invoke(
    'owner',
    'library_label.unassign',
    { labelId: label.id, subjectId: subject.id, expectedRevision: assignment.assignment.revision },
    key(),
  );
  expect(removed.status).toBe(200);
  const reassigned = await assignLabel(subject.id, label.id);
  expect(reassigned.assignment.id).toBe(assignment.assignment.id);
  expect(reassigned.assignment.revision).toBeGreaterThan(assignment.assignment.revision);
  const beforeStaleUnassign = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });
  const staleUnassign = await driver.invoke(
    'owner',
    'library_label.unassign',
    { labelId: label.id, subjectId: subject.id, expectedRevision: assignment.assignment.revision },
    key(),
  );
  expect(staleUnassign.status).toBe(409);
  expect(await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] })).toEqual(
    beforeStaleUnassign,
  );
  expect(afterRename.entries).toEqual(beforeStaleUnassign.entries);
});

test('exact receipt replay is inert and cannot revive a logically deleted label', async () => {
  const subject = await driver.provisionSubject();
  const createKey = key();
  const created = await createLabel('receipt label', 'owner', createKey);
  expect(created.response.status).toBe(201);
  const createReplay = await createLabel('receipt label', 'owner', createKey);
  expect(createReplay.response.status).toBe(created.response.status);
  expect(createReplay.label).toEqual(created.label);

  const assignmentKey = key();
  const firstAssignment = await assignLabel(subject.id, created.label.id, assignmentKey);
  const assignmentReplay = await assignLabel(subject.id, created.label.id, assignmentKey);
  expect(assignmentReplay.assignment).toEqual(firstAssignment.assignment);
  await assignLabel(subject.id, created.label.id, key());
  const beforeDelete = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [created.label.id] });
  expect(assignmentRows(beforeDelete.assignments, created.label.id, subject.id)).toHaveLength(1);

  expect((await deleteLabel(created.label.id, created.label.revision)).status).toBe(200);
  const revoked = await createLabel('receipt label', 'owner', createKey);
  expect(revoked.label).toEqual(created.label);
  const afterReplay = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [created.label.id] });
  expect(liveLabelRows(afterReplay.labels, created.label.id)).toHaveLength(0);
  expect(assignmentRows(afterReplay.assignments, created.label.id, subject.id)).toHaveLength(1);
  expect((await assignmentPage('owner', { labelId: created.label.id, limit: 20 })).response.status).toBe(404);
});

test('state changes leave labels and label changes leave the current exclusive state', async () => {
  const subject = await driver.provisionSubject();
  const first = await createLabel('first independent label');
  const second = await createLabel('second independent label');
  await assignLabel(subject.id, first.label.id);
  await assignLabel(subject.id, second.label.id);
  expect((await driver.setState('owner', subject.id, 'in_progress')).ok).toBe(true);
  expect((await driver.setState('owner', subject.id, 'completed')).ok).toBe(true);

  const completed = await driver.inspect({
    owner: 'owner',
    subjectIds: [subject.id],
    labelIds: [first.label.id, second.label.id],
  });
  expect(completed.entries.find((entry) => entry.subjectId === subject.id)?.state).toBe('completed');
  expect(assignmentRows(completed.assignments, first.label.id, subject.id)).toHaveLength(1);
  expect(assignmentRows(completed.assignments, second.label.id, subject.id)).toHaveLength(1);

  const removed = await driver.invoke(
    'owner',
    'library_label.unassign',
    { labelId: first.label.id, subjectId: subject.id, expectedRevision: 1 },
    key(),
  );
  expect(removed.status).toBe(200);
  const afterUnassign = await driver.inspect({
    owner: 'owner',
    subjectIds: [subject.id],
    labelIds: [first.label.id, second.label.id],
  });
  expect(afterUnassign.entries.find((entry) => entry.subjectId === subject.id)?.state).toBe('completed');
  expect(assignmentRows(afterUnassign.assignments, first.label.id, subject.id)).toHaveLength(0);
  expect(assignmentRows(afterUnassign.assignments, second.label.id, subject.id)).toHaveLength(1);
});

test('creating and assigning a label creates no implicit state session holding follow or entitlement', async () => {
  const subject = await driver.provisionSubject();
  const { label } = await createLabel('plain private label');
  await assignLabel(subject.id, label.id);
  const rows = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });

  expect(rows.entries.filter((entry) => entry.subjectId === subject.id)).toEqual([]);
  expect(rows.sessions.filter((session) => session.subjectId === subject.id)).toEqual([]);
  expect(rows.holdings.filter((holding) => holding.subjectId === subject.id)).toEqual([]);
  expect(rows.follows.filter((follow) => follow.targetId === subject.id && follow.state === 'following')).toEqual([]);
  expect(
    rows.subjectFacts.filter((fact) => fact.subjectId === subject.id && fact.active).map((fact) => fact.kind),
  ).toEqual(['label']);
  expect(rows.privateOutbox.some((event) => event.type.includes('entitlement'))).toBe(false);
});

test('only explicit public Collection visibility may disclose returned subjects and never label values', async () => {
  const subject = await driver.provisionSubject();
  const { label } = await createLabel('NEVER PUBLIC LABEL VALUE');
  await assignLabel(subject.id, label.id);
  const before = await driver.publicExposure(subject.id);

  const collection = await driver.createCollection('owner', 'private');
  await driver.appendCollectionMember('owner', collection.id, subject.id);
  const hidden = await driver.readPublicCollection(collection.id);
  expect(hidden.status).toBe(404);
  expect((await driver.publicExposure(subject.id)).publicRows).toEqual(before.publicRows);

  await driver.setCollectionVisibility('owner', collection.id, 'public');
  await driver.settle();
  const visible = await driver.readPublicCollection(collection.id);
  expect(visible.status).toBe(200);
  const visibleText = await visible.clone().text();
  expect(visibleText).toContain(subject.id);
  expect(visibleText).not.toContain(label.id);
  expect(visibleText).not.toContain('NEVER PUBLIC LABEL VALUE');

  const rows = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });
  expect(
    rows.publicSubjectRows.filter((row) => row.collectionId === collection.id).map((row) => row.multiplicity),
  ).toEqual([1]);
  expect(rows.publicSubjectRows.some((row) => row.table.toLowerCase().includes('label'))).toBe(false);

  await driver.setCollectionVisibility('owner', collection.id, 'private');
  await driver.settle();
  expect((await driver.readPublicCollection(collection.id)).status).toBe(404);
  expect(
    (await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] })).publicSubjectRows,
  ).toEqual([]);
});

test('state-only and label-only subjects contribute distinct source facts while follows contribute none', async () => {
  const stateOnly = await driver.provisionSubject();
  const labelOnly = await driver.provisionSubject();
  const sessionOnly = await driver.provisionSubject();
  const holdingOnly = await driver.provisionSubject();
  const followedOnly = await driver.provisionSubject();
  const label = await createLabel('source fact label');

  expect((await driver.setState('owner', stateOnly.id, 'in_progress')).ok).toBe(true);
  await assignLabel(labelOnly.id, label.label.id);
  expect((await driver.createProgressSession('owner', sessionOnly.id)).ok).toBe(true);
  expect((await driver.createHolding('owner', holdingOnly.id)).ok).toBe(true);
  expect((await driver.followSubject('owner', followedOnly.id)).ok).toBe(true);

  const rows = await driver.inspect({
    owner: 'owner',
    subjectIds: [stateOnly.id, labelOnly.id, sessionOnly.id, holdingOnly.id, followedOnly.id],
    labelIds: [label.label.id],
  });
  const activeKinds = (subjectId: string) =>
    rows.subjectFacts
      .filter((fact) => fact.subjectId === subjectId && fact.active)
      .map((fact) => fact.kind)
      .sort();
  expect(activeKinds(stateOnly.id)).toEqual(['state']);
  expect(activeKinds(labelOnly.id)).toEqual(['label']);
  expect(activeKinds(sessionOnly.id)).toEqual(['session']);
  expect(activeKinds(holdingOnly.id)).toEqual(['holding']);
  expect(activeKinds(followedOnly.id)).toEqual([]);
  expect(rows.entries.some((entry) => entry.subjectId === labelOnly.id)).toBe(false);
  expect(rows.assignments.some((assignment) => assignment.subjectId === stateOnly.id)).toBe(false);
  expect(rows.follows.some((follow) => follow.targetId === followedOnly.id && follow.state === 'following')).toBe(true);
});

test('logical deletion revokes assignment reads and query facts before physical cleanup', async () => {
  const subject = await driver.provisionSubject();
  const { label } = await createLabel('delete me now');
  await assignLabel(subject.id, label.id);
  const before = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });
  expect(before.assignments.filter((row) => row.labelId === label.id)).toHaveLength(1);
  expect(before.subjectFacts.some((fact) => fact.kind === 'label' && fact.sourceId === label.id && fact.active)).toBe(
    true,
  );

  expect((await deleteLabel(label.id, label.revision)).status).toBe(200);
  const catalog = await labelPage('owner', { limit: 100 });
  expect(catalog.page.labels.some((item) => item.id === label.id)).toBe(false);
  expect((await assignmentPage('owner', { labelId: label.id, limit: 20 })).response.status).toBe(404);

  const after = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [label.id] });
  expect(liveLabelRows(after.labels, label.id)).toHaveLength(0);
  expect(assignmentRows(after.assignments, label.id, subject.id)).toHaveLength(1);
  expect(after.subjectFacts.some((fact) => fact.kind === 'label' && fact.sourceId === label.id && fact.active)).toBe(
    false,
  );
  expect(labelEventRows(after, label.id).every((event) => event.subject === driver.accounts.owner.id)).toBe(true);
  expect(after.publicSubjectRows).toEqual([]);
});

test('bounded assignment cleanup survives a committed-page crash and concurrent same-name recreation', async () => {
  const { label } = await createLabel('cleanup and recreate');
  const subjects = await Promise.all(Array.from({ length: 101 }, () => driver.provisionSubject()));
  for (const subject of subjects) await assignLabel(subject.id, label.id);
  expect((await deleteLabel(label.id, label.revision)).status).toBe(200);

  const runId = await driver.startLabelCleanup(label.id);
  const latch = await driver.pauseAfterCleanupCommit(runId);
  const page = driver.runCleanupPage(runId);
  let recreated: LabelView | undefined;
  try {
    await latch.reached;
    const createdAgain = await createLabel('cleanup and recreate');
    recreated = createdAgain.label;
    expect(recreated.id).not.toBe(label.id);
    await assignLabel(subjects[0]!.id, recreated.id);

    await driver.crashCleanupWorker(runId);
    let crashed = false;
    try {
      await page;
    } catch {
      crashed = true;
    }
    expect(crashed).toBe(true);
  } finally {
    latch.resume();
  }

  await driver.resumeCleanup(runId);
  await driver.runCleanupPage(runId); // Replaying the committed cursor is inert.
  await driver.settle();
  expect(recreated).toBeDefined();
  const rows = await driver.inspect({
    owner: 'owner',
    subjectIds: subjects.map((subject) => subject.id),
    labelIds: [label.id, recreated!.id],
  });
  expect(assignmentRows(rows.assignments, label.id)).toHaveLength(0);
  expect(assignmentRows(rows.assignments, recreated!.id)).toHaveLength(1);
  const newAssignment = await assignmentPage('owner', { labelId: recreated!.id, limit: 20 });
  expect(newAssignment.response.status).toBe(200);
  expect(newAssignment.page.assignments.map((assignment) => assignment.subjectId)).toEqual([subjects[0]!.id]);
  expect(rows.cleanup.find((entry) => entry.labelId === label.id)?.committedPages).toBeGreaterThanOrEqual(2);
});

test('the account-deletion barrier fences label writes receipts and cleanup resurrection', async () => {
  const subject = await driver.provisionSubject();
  const createKey = key();
  const created = await createLabel('account deletion fence', 'owner', createKey);
  await assignLabel(subject.id, created.label.id);
  expect((await deleteLabel(created.label.id, created.label.revision)).status).toBe(200);
  const runId = await driver.startLabelCleanup(created.label.id);
  const latch = await driver.pauseAfterCleanupCommit(runId);
  const page = driver.runCleanupPage(runId);
  try {
    await latch.reached;
    expect((await driver.deleteAccount('owner')).ok).toBe(true);
    expect((await driver.invoke('owner', 'library_label.create', { name: 'late write' }, key())).ok).toBe(false);
    expect(
      (await driver.invoke('owner', 'library_label.create', { name: 'account deletion fence' }, createKey)).ok,
    ).toBe(false);
  } finally {
    latch.resume();
  }
  await page.catch(() => undefined);
  await driver.resumeCleanup(runId);
  await driver.settle();

  const rows = await driver.inspect({ owner: 'owner', subjectIds: [subject.id], labelIds: [created.label.id] });
  expect(rows.labels).toEqual([]);
  expect(rows.assignments).toEqual([]);
  expect(rows.subjectFacts).toEqual([]);
  expect(rows.receipts).toEqual([]);
  expect((await driver.invoke('owner', 'library_label.list', { limit: 20 })).ok).toBe(false);
});

test('label commands reject duplicate JSON keys unknown fields and coercion without partial writes', async () => {
  const before = await driver.inspect({ owner: 'owner' });
  const duplicateKey = await driver.invokeRaw(
    'owner',
    'library_label.create',
    '{"name":"first","name":"second"}',
    key(),
  );
  const unknownField = await driver.invokeRaw('owner', 'library_label.create', '{"name":"valid","extra":true}', key());
  const coercion = await driver.invokeRaw('owner', 'library_label.create', '{"name":17}', key());
  expect(duplicateKey.status).toBe(400);
  expect(unknownField.status).toBe(400);
  expect(coercion.status).toBe(400);
  const after = await driver.inspect({ owner: 'owner' });
  expect(after.labels).toEqual(before.labels);
  expect(after.assignments).toEqual(before.assignments);
});

test('deep catalogue and assignment keysets stay within candidate and memory bounds', async () => {
  const target = await createLabel('deep assignment target');
  expect(target.response.status).toBe(201);
  for (let index = 0; index < 105; index++) await createLabel(`catalogue ${String(index).padStart(3, '0')}`);
  const subjects = await Promise.all(Array.from({ length: 105 }, () => driver.provisionSubject()));
  for (const subject of subjects) await assignLabel(subject.id, target.label.id);

  let catalogCursor: string | null = null;
  let catalogPages = 0;
  do {
    const measured = await driver.measurePage(() =>
      driver.invoke('owner', 'library_label.list', { limit: 17, ...(catalogCursor ? { cursor: catalogCursor } : {}) }),
    );
    const responseBody = await body<LabelPage>(measured.value);
    expect(measured.candidatesExamined).toBeLessThanOrEqual(100);
    expect(measured.rowsReturned).toBeLessThanOrEqual(17);
    expect(measured.peakRowsInMemory).toBeLessThanOrEqual(17);
    expect(responseBody.labels.length).toBeLessThanOrEqual(17);
    catalogCursor = responseBody.next;
    catalogPages++;
  } while (catalogCursor !== null);
  expect(catalogPages).toBeGreaterThan(4);

  let assignmentCursor: string | null = null;
  let assignmentPages = 0;
  do {
    const measured = await driver.measurePage(() =>
      driver.invoke('owner', 'library_label.assignment_list', {
        labelId: target.label.id,
        limit: 23,
        ...(assignmentCursor ? { cursor: assignmentCursor } : {}),
      }),
    );
    const responseBody = await body<AssignmentPage>(measured.value);
    expect(measured.candidatesExamined).toBeLessThanOrEqual(100);
    expect(measured.rowsReturned).toBeLessThanOrEqual(23);
    expect(measured.peakRowsInMemory).toBeLessThanOrEqual(23);
    expect(responseBody.assignments.length).toBeLessThanOrEqual(23);
    assignmentCursor = responseBody.next;
    assignmentPages++;
  } while (assignmentCursor !== null);
  expect(assignmentPages).toBeGreaterThan(3);

  const firstPage = await labelPage('owner', { limit: 10 });
  const staleCursor = firstPage.page.next;
  expect(staleCursor).toBeString();
  const labelToRename = firstPage.page.labels[0]!;
  expect((await renameLabel(labelToRename.id, labelToRename.revision, 'renamed in catalog')).status).toBe(200);
  const stalePage = await driver.invoke('owner', 'library_label.list', { limit: 10, cursor: staleCursor });
  expect(stalePage.status).toBe(409);

  const ownerCursor = firstPage.page.next!;
  const crossOwner = await driver.invoke('other', 'library_label.list', { limit: 10, cursor: ownerCursor });
  expect(crossOwner.ok).toBe(false);
});

test('assignment rename and logical delete stay fixed-cost as owner data grows at three scales', async () => {
  const scales = [8, 32, 128] as const;
  const assignmentCosts: { statements: number; rowsRead: number; rowsWritten: number; buffers: number }[] = [];
  const renameCosts: { statements: number; rowsRead: number; rowsWritten: number; buffers: number }[] = [];
  const deleteCosts: { statements: number; rowsRead: number; rowsWritten: number; buffers: number }[] = [];

  for (const scale of scales) {
    await driver.growUnrelated({ labels: scale, assignments: scale });
    const target = await createLabel(`measured target ${scale}`);
    const targets = await Promise.all(Array.from({ length: scale }, () => driver.provisionSubject()));
    for (const subject of targets) await assignLabel(subject.id, target.label.id);

    const unrelatedSubject = await driver.provisionSubject();
    const assignCost = await driver.measure(() =>
      driver.invoke(
        'owner',
        'library_label.assign',
        {
          subjectId: unrelatedSubject.id,
          labelId: target.label.id,
        },
        key(),
      ),
    );
    expect((assignCost.value as Response).status).toBe(200);
    assignmentCosts.push(assignCost);

    const renameCost = await driver.measure(() =>
      renameLabel(target.label.id, target.label.revision, `renamed ${scale}`),
    );
    expect(renameCost.value.status).toBe(200);
    renameCosts.push(renameCost);
    const deleted = await body<{ label: LabelView }>(renameCost.value);
    const deleteCost = await driver.measure(() => deleteLabel(target.label.id, deleted.label.revision));
    expect(deleteCost.value.status).toBe(200);
    deleteCosts.push(deleteCost);

    const pending = await driver.inspect({ owner: 'owner', labelIds: [target.label.id] });
    expect(assignmentRows(pending.assignments, target.label.id)).toHaveLength(scale + 1);
  }

  expect(new Set(assignmentCosts.map((cost) => cost.rowsWritten)).size).toBe(1);
  expect(new Set(assignmentCosts.map((cost) => cost.statements)).size).toBe(1);
  expect(new Set(renameCosts.map((cost) => cost.rowsWritten)).size).toBe(1);
  expect(new Set(deleteCosts.map((cost) => cost.rowsWritten)).size).toBe(1);
  for (const observation of [...assignmentCosts, ...renameCosts, ...deleteCosts]) {
    expect(observation.statements).toBeLessThanOrEqual(24);
    expect(observation.rowsWritten).toBeLessThanOrEqual(12);
    expect(observation.rowsRead).toBeLessThanOrEqual(32);
  }
  const maxScale = scales.at(-1)!;
  const logarithmicAllowance = 32 + 16 * Math.ceil(Math.log2(maxScale + 1));
  expect(
    Math.max(
      ...assignmentCosts.map((cost) => cost.buffers),
      ...renameCosts.map((cost) => cost.buffers),
      ...deleteCosts.map((cost) => cost.buffers),
    ),
  ).toBeLessThanOrEqual(logarithmicAllowance);
});
