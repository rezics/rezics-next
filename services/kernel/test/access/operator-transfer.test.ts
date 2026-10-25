import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AccountOperation, WorkflowResponsibility } from '@rezics/auth';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const context = () => ({ pool, deadline: Date.now() + 10000 });
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
type Fixture = Awaited<ReturnType<typeof nativeFixture>>;
type Person = Awaited<ReturnType<Fixture['person']>>;
let source: Person;
let destination: typeof source;
let both: typeof source;
let otherDestination: typeof source;
let operatedSubject: Awaited<ReturnType<Fixture['automated']>>;

async function grant(resourceId: string, humanId: string) {
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:manage','(,)'::tstzrange,$4)`,
    [routeOf(resourceId), resourceId, humanId, newId(routeOf(resourceId)!)],
  );
}

async function revokeGrant(resourceId: string, humanId: string) {
  await pool.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='account:manage'",
    [routeOf(resourceId), resourceId, humanId],
  );
}

async function responsibility(subjectAccountId: string): Promise<WorkflowResponsibility & { version: string }> {
  const row = (
    await pool.query<{
      operator_account_id: string;
      operator_reservation_id: string;
      operator_relation_version: string;
    }>(
      `SELECT operator_account_id::text,operator_reservation_id::text,operator_relation_version::text
      FROM access.account WHERE route=$1 AND account_id=$2`,
      [routeOf(subjectAccountId), subjectAccountId],
    )
  ).rows[0];
  if (!row?.operator_account_id || !row.operator_reservation_id) throw new Error('Missing operator responsibility');
  return {
    operatorAccountId: row.operator_account_id,
    subjectAccountId,
    reservationId: row.operator_reservation_id,
    version: row.operator_relation_version,
  };
}

async function held(operatorAccountId: string, subjectAccountId: string): Promise<string[]> {
  return (
    await pool.query<{ reservation_id: string }>(
      `SELECT reservation_id::text FROM access.lifecycle_coordination
      WHERE route=$1 AND account_id=$2 AND related_account_id=$3 AND purpose='operator' ORDER BY reservation_id`,
      [routeOf(operatorAccountId), operatorAccountId, subjectAccountId],
    )
  ).rows.map((row) => row.reservation_id);
}

async function slot(subjectAccountId: string, reservationId: string) {
  return (
    await pool.query<{ operator_account_id: string; terminal: boolean }>(
      `SELECT operator_account_id::text,terminal FROM access.operator_relation_slot
      WHERE route=$1 AND subject_account_id=$2 AND reservation_id=$3`,
      [routeOf(subjectAccountId), subjectAccountId, reservationId],
    )
  ).rows[0];
}

function responsibilityRecord(value: WorkflowResponsibility): WorkflowResponsibility {
  return {
    operatorAccountId: value.operatorAccountId,
    subjectAccountId: value.subjectAccountId,
    reservationId: value.reservationId,
  };
}

async function automated(name: string) {
  return fixture.automated(key(name), source);
}

function transferRecord(
  previous: WorkflowResponsibility,
  version: string,
  operatorAccountId: string,
  acceptance?: string,
): Extract<AccountOperation, { kind: 'transfer' }> {
  return {
    kind: 'transfer',
    previous: responsibilityRecord(previous),
    expectedVersion: version,
    operatorAccountId,
    authorization: 'approval-request',
    ...(acceptance === undefined ? {} : { acceptance }),
  };
}

async function destinationAcceptance(
  previous: WorkflowResponsibility,
  expectedVersion: string,
  operatorAccountId: string,
  operationKey: string,
  actor: Person = destination,
) {
  const operation: AccountOperation = {
    kind: 'transfer-acceptance',
    previous: responsibilityRecord(previous),
    expectedVersion,
    operatorAccountId,
    sourceOperationKey: operationKey,
    authorization: 'acceptance-request',
  };
  return fixture.approval().approve(actor.bearer, { operationKey, operation }, context());
}

async function runTransfer(
  previous: WorkflowResponsibility,
  expectedVersion: string,
  operatorAccountId: string,
  options: { sourceBearer?: string; acceptance?: string; workflowKey?: string } = {},
) {
  const workflowKey = options.workflowKey ?? key('operator-transfer');
  const operation = transferRecord(previous, expectedVersion, operatorAccountId, options.acceptance);
  const sourceApproval = await fixture
    .approval()
    .approve(options.sourceBearer ?? source.bearer, { operationKey: workflowKey, operation }, context());
  return fixture.host.workflows.transferOperator({
    key: workflowKey,
    authorization: sourceApproval.reference,
    previous,
    expectedVersion,
    operatorAccountId,
    ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
  });
}

beforeAll(async () => {
  fixture = await nativeFixture(pool);
  source = await fixture.person(key('source-manager'));
  destination = await fixture.person(key('destination-manager'));
  both = await fixture.person(key('both-manager'));
  otherDestination = await fixture.person(key('other-destination'));
  await grant(source.accountId, both.accountId);
  await grant(destination.accountId, both.accountId);
  await grant(otherDestination.accountId, destination.accountId);
});

afterAll(async () => {
  await fixture?.close();
  await pool.end();
});

test('two managers co-approve one immutable transfer and terminalize the old slot before release', async () => {
  const subject = await automated('coapproved-subject');
  const previous = await responsibility(subject.accountId);
  const operationKey = key('coapproved-transfer');
  const accepted = await destinationAcceptance(previous, previous.version, destination.accountId, operationKey);
  const record = transferRecord(previous, previous.version, destination.accountId, accepted.reference);
  const sourceApproval = await fixture
    .approval()
    .approve(source.bearer, { operationKey, operation: record }, context());

  let heldBeforeRelation = false;
  let oldSlotTerminalBeforeRelease = false;
  let delayedLinkDenied = false;
  const ports = fixture.bindings.workflowPorts;
  const recordRelation = ports.recordOperatorRelation!;
  const releaseResponsibility = ports.releaseResponsibility!;
  const authorizeOperation = ports.authorizeOperation!;
  let authorityChecks = 0;
  ports.authorizeOperation = async (...args) => {
    authorityChecks++;
    return authorizeOperation(...args);
  };
  ports.recordOperatorRelation = async (input, pending) => {
    if (input.subjectAccountId === subject.accountId && input.operatorAccountId === destination.accountId) {
      const now = await responsibility(subject.accountId);
      heldBeforeRelation =
        (await held(destination.accountId, subject.accountId)).includes(input.reservationId) &&
        (await held(source.accountId, subject.accountId)).includes(previous.reservationId) &&
        now.operatorAccountId === source.accountId &&
        now.version === previous.version;
    }
    return recordRelation(input, pending);
  };
  ports.releaseResponsibility = async (input) => {
    if (input.subjectAccountId === subject.accountId && input.reservationId === previous.reservationId) {
      const current = await responsibility(subject.accountId);
      const oldSlot = await slot(subject.accountId, previous.reservationId);
      oldSlotTerminalBeforeRelease =
        current.operatorAccountId === destination.accountId &&
        oldSlot?.terminal === true &&
        oldSlot.operator_account_id === source.accountId &&
        (await held(source.accountId, subject.accountId)).includes(previous.reservationId);
      try {
        await fixture.bindings.operators.recordOperatorRelation({
          operatorAccountId: source.accountId,
          subjectAccountId: subject.accountId,
          reservationId: previous.reservationId,
          expectedOperatorAccountId: destination.accountId,
          expectedVersion: current.version,
          key: key('delayed-old-link'),
        });
      } catch {
        delayedLinkDenied = true;
      }
    }
    return releaseResponsibility(input);
  };

  try {
    await fixture.host.workflows.transferOperator({
      key: operationKey,
      authorization: sourceApproval.reference,
      previous,
      expectedVersion: previous.version,
      operatorAccountId: destination.accountId,
      acceptance: accepted.reference,
    });
  } finally {
    ports.recordOperatorRelation = recordRelation;
    ports.releaseResponsibility = releaseResponsibility;
    ports.authorizeOperation = authorizeOperation;
  }

  expect(authorityChecks).toBe(7);
  expect(heldBeforeRelation).toBe(true);
  expect(oldSlotTerminalBeforeRelease).toBe(true);
  expect(delayedLinkDenied).toBe(true);
  expect(await responsibility(subject.accountId)).toMatchObject({
    operatorAccountId: destination.accountId,
    version: String(BigInt(previous.version) + 1n),
  });
  expect(await held(source.accountId, subject.accountId)).toEqual([]);
  expect(await held(destination.accountId, subject.accountId)).toHaveLength(1);
  await expect(
    fixture.approval().resolve(
      accepted.reference,
      {
        kind: 'transfer-acceptance',
        previous,
        expectedVersion: previous.version,
        operatorAccountId: destination.accountId,
        sourceOperationKey: operationKey,
        authorization: accepted.reference,
      },
      context(),
    ),
  ).rejects.toThrow();
}, 60000);

test('transfer result disclosure rechecks both authorities after the terminal steps', async () => {
  const subject = await automated('result-boundary-subject');
  const previous = await responsibility(subject.accountId);
  const operationKey = key('result-boundary');
  const accepted = await destinationAcceptance(previous, previous.version, destination.accountId, operationKey);
  const ports = fixture.bindings.workflowPorts;
  const releaseResponsibility = ports.releaseResponsibility!;
  ports.releaseResponsibility = async (input) => {
    const result = await releaseResponsibility(input);
    if (input.subjectAccountId === subject.accountId && input.reservationId === previous.reservationId)
      await revokeGrant(destination.accountId, destination.accountId);
    return result;
  };
  try {
    await expect(
      runTransfer(previous, previous.version, destination.accountId, {
        acceptance: accepted.reference,
        workflowKey: operationKey,
      }),
    ).rejects.toThrow();
  } finally {
    ports.releaseResponsibility = releaseResponsibility;
    await grant(destination.accountId, destination.accountId);
  }
  expect(await responsibility(subject.accountId)).toMatchObject({
    operatorAccountId: destination.accountId,
    version: String(BigInt(previous.version) + 1n),
  });
  expect(await held(source.accountId, subject.accountId)).toEqual([]);
  expect(await held(destination.accountId, subject.accountId)).toHaveLength(1);
}, 60000);

test('one approval covers both authorities for one manager; a source-only manager cannot transfer alone', async () => {
  const bothSubject = await automated('both-authorities-subject');
  const bothPrevious = await responsibility(bothSubject.accountId);
  await runTransfer(bothPrevious, bothPrevious.version, destination.accountId, { sourceBearer: both.bearer });
  expect((await responsibility(bothSubject.accountId)).operatorAccountId).toBe(destination.accountId);

  const deniedSubject = await automated('source-only-subject');
  operatedSubject = deniedSubject;
  const deniedPrevious = await responsibility(deniedSubject.accountId);
  const workflowKey = key('source-only-transfer');
  await expect(
    runTransfer(deniedPrevious, deniedPrevious.version, destination.accountId, { workflowKey }),
  ).rejects.toThrow();
  expect(await responsibility(deniedSubject.accountId)).toMatchObject({
    operatorAccountId: source.accountId,
    version: deniedPrevious.version,
  });
  expect(await held(source.accountId, deniedSubject.accountId)).toEqual([deniedPrevious.reservationId]);
  expect(await held(destination.accountId, deniedSubject.accountId)).toEqual([]);
});

test('mismatched acceptance records, stale versions, wrong reservations, self links and operated destinations deny', async () => {
  const mismatchSubject = await automated('acceptance-mismatch-subject');
  const mismatchPrevious = await responsibility(mismatchSubject.accountId);
  const mismatches: {
    previous?: WorkflowResponsibility;
    expectedVersion?: string;
    operatorAccountId?: string;
  }[] = [
    { previous: { ...mismatchPrevious, subjectAccountId: otherDestination.accountId, reservationId: key('other') } },
    { expectedVersion: String(BigInt(mismatchPrevious.version) + 1n) },
    { operatorAccountId: otherDestination.accountId },
  ];
  for (const mismatch of mismatches) {
    const operationKey = key('mismatched-acceptance');
    const accepted = await destinationAcceptance(
      mismatch.previous ?? mismatchPrevious,
      mismatch.expectedVersion ?? mismatchPrevious.version,
      mismatch.operatorAccountId ?? destination.accountId,
      operationKey,
    );
    const record = transferRecord(
      mismatchPrevious,
      mismatchPrevious.version,
      destination.accountId,
      accepted.reference,
    );
    const sourceApproval = await fixture
      .approval()
      .approve(source.bearer, { operationKey, operation: record }, context());
    await expect(
      fixture.host.workflows.transferOperator({
        key: operationKey,
        authorization: sourceApproval.reference,
        previous: mismatchPrevious,
        expectedVersion: mismatchPrevious.version,
        operatorAccountId: destination.accountId,
        acceptance: accepted.reference,
      }),
    ).rejects.toThrow();
    expect(await responsibility(mismatchSubject.accountId)).toMatchObject({
      operatorAccountId: source.accountId,
      version: mismatchPrevious.version,
    });
    expect(await held(destination.accountId, mismatchSubject.accountId)).toEqual([]);
  }

  for (const field of ['version', 'reservation'] as const) {
    const subject = await automated(`stale-${field}`);
    const current = await responsibility(subject.accountId);
    const wrongPrevious = {
      ...current,
      ...(field === 'reservation' ? { reservationId: key('wrong-reservation') } : {}),
    };
    const expectedVersion = field === 'version' ? String(BigInt(current.version) - 1n) : current.version;
    const operationKey = key(`stale-${field}`);
    const accepted = await destinationAcceptance(wrongPrevious, expectedVersion, destination.accountId, operationKey);
    await expect(
      runTransfer(wrongPrevious, expectedVersion, destination.accountId, {
        workflowKey: operationKey,
        acceptance: accepted.reference,
      }),
    ).rejects.toThrow();
    expect(await responsibility(subject.accountId)).toMatchObject({
      operatorAccountId: source.accountId,
      version: current.version,
      reservationId: current.reservationId,
    });
    expect(await held(destination.accountId, subject.accountId)).toEqual([]);
  }

  const selfSubject = await automated('self-link-subject');
  const selfPrevious = await responsibility(selfSubject.accountId);
  const selfRecord = transferRecord(selfPrevious, selfPrevious.version, selfPrevious.subjectAccountId);
  await expect(
    fixture.approval().approve(source.bearer, { operationKey: key('self-link'), operation: selfRecord }, context()),
  ).rejects.toThrow();
  expect(await held(source.accountId, selfSubject.accountId)).toEqual([selfPrevious.reservationId]);

  const operatedDestination = await fixture.automated(key('operated-destination'), source);
  await grant(operatedDestination.accountId, destination.accountId);
  const operatedPrevious = await responsibility(operatedSubject.accountId);
  const operationKey = key('operated-destination-transfer');
  const accepted = await destinationAcceptance(
    operatedPrevious,
    operatedPrevious.version,
    operatedDestination.accountId,
    operationKey,
  );
  await expect(
    runTransfer(operatedPrevious, operatedPrevious.version, operatedDestination.accountId, {
      workflowKey: operationKey,
      acceptance: accepted.reference,
    }),
  ).rejects.toThrow();
  expect(await responsibility(operatedSubject.accountId)).toMatchObject({
    operatorAccountId: source.accountId,
    version: operatedPrevious.version,
  });
  expect(await held(operatedDestination.accountId, operatedSubject.accountId)).toEqual([]);
}, 60000);

test('either revoked authority preserves both holds until authorized cancellation terminalizes its slot', async () => {
  const ports = fixture.bindings.workflowPorts;
  for (const authority of [
    { name: 'source', resourceId: source.accountId, actorId: source.accountId },
    { name: 'destination', resourceId: destination.accountId, actorId: destination.accountId },
  ]) {
    const subject = await automated(`revoked-${authority.name}-subject`);
    const previous = await responsibility(subject.accountId);
    const operationKey = key(`revoked-${authority.name}-transfer`);
    const accepted = await destinationAcceptance(previous, previous.version, destination.accountId, operationKey);
    const record = transferRecord(previous, previous.version, destination.accountId, accepted.reference);
    const sourceApproval = await fixture
      .approval()
      .approve(source.bearer, { operationKey, operation: record }, context());
    const reserveResponsibility = ports.reserveResponsibility!;
    ports.reserveResponsibility = async (input) => {
      const result = await reserveResponsibility(input);
      if (input.subjectAccountId === subject.accountId) await revokeGrant(authority.resourceId, authority.actorId);
      return result;
    };
    try {
      await expect(
        fixture.host.workflows.transferOperator({
          key: operationKey,
          authorization: sourceApproval.reference,
          previous,
          expectedVersion: previous.version,
          operatorAccountId: destination.accountId,
          acceptance: accepted.reference,
        }),
      ).rejects.toThrow();
    } finally {
      ports.reserveResponsibility = reserveResponsibility;
    }
    expect(await responsibility(subject.accountId)).toMatchObject({
      operatorAccountId: source.accountId,
      version: previous.version,
    });
    expect(await held(source.accountId, subject.accountId)).toEqual([previous.reservationId]);
    expect(await held(destination.accountId, subject.accountId)).toHaveLength(1);

    await grant(authority.resourceId, authority.actorId);
    const destinationReservation = (await held(destination.accountId, subject.accountId))[0]!;
    const recordRelation = ports.recordOperatorRelation!;
    ports.recordOperatorRelation = async (input, pending) => {
      if (input.subjectAccountId === subject.accountId) throw new Error('Injected pre-publication failure');
      return recordRelation(input, pending);
    };
    try {
      await expect(fixture.host.workflows.resumeOperation(operationKey)).rejects.toThrow();
    } finally {
      ports.recordOperatorRelation = recordRelation;
    }
    expect(await responsibility(subject.accountId)).toMatchObject({
      operatorAccountId: source.accountId,
      version: previous.version,
    });
    expect(await held(source.accountId, subject.accountId)).toEqual([previous.reservationId]);
    expect(await held(destination.accountId, subject.accountId)).toEqual([]);
    expect(await slot(subject.accountId, destinationReservation)).toMatchObject({
      operator_account_id: destination.accountId,
      terminal: true,
    });
  }
}, 60000);
