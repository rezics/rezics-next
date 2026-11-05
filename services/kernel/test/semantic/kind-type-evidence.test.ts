import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { Access } from '../../src/request/access.ts';
import type { OperationalTransaction } from '../../src/command/operational.ts';
import type { CollectionKindPreparationLocator } from '../../src/library/collection-kind-work-admission.ts';
import type { WorkAllowance } from '../../src/library/collection-source.ts';
import { createNativeKindTypeEvidence } from '../../src/semantic/kind-type-evidence.ts';
import { newId } from '../../src/route/route.ts';
import { createCollectionKindFixture, type CollectionKindFixture } from '../library/support/collection-kind-fixture.ts';
import { identityFixture } from './identity-fixture.ts';

function allowance(): WorkAllowance {
  return {
    reservationId: crypto.randomUUID(),
    remaining: {
      candidateKeys: 100,
      nativeRows: 10000,
      identityMetadataRows: 8192,
      nativePoints: 10000,
      witnessKeys: 100,
      statements: 1000,
      bytes: 1024 * 1024,
      emptySeeks: 1000,
    },
  };
}

test('a Kind locator, audience namespace and structural transaction cannot issue native Type evidence', async () => {
  let io = 0;
  const pool = {
    connect() {
      io++;
      throw new Error('Unadmitted Kind reached Source I/O');
    },
  } as unknown as Pool;
  const locator: CollectionKindPreparationLocator = {
    route: 0xc100,
    collectionId: newId(0xc100),
    ownerAccountId: newId(0xc100),
    preparationId: crypto.randomUUID(),
  };
  const tx = {
    query() {
      io++;
      throw new Error('Unadmitted Kind reached native I/O');
    },
  } as unknown as OperationalTransaction;
  const evidence = createNativeKindTypeEvidence({ pool, access: {} as Access });
  const budget = allowance();
  // An audience label cannot extend the original closed Library locator. A
  // valid locator will require paid native owner lookup once that owner exists.
  const forgedLocator = { ...locator, audience: 'public' };
  const read = await evidence.read({ locator: forgedLocator, allowance: budget, deadline: Date.now() + 10000 });
  expect(read.status).toBe('unavailable');
  expect(read.work.reservationId).toBe(budget.reservationId);
  expect(Object.values(read.work.used).every((value) => value === 0)).toBe(true);
  const verified = await evidence.verify({
    work: { kind: 'collection-kind-preparation', tx, locator },
    evidence: { locator, evidenceId: crypto.randomUUID() },
    allowance: budget,
    deadline: Date.now() + 10000,
  });
  expect(verified.status).toBe('unavailable');
  expect(verified).not.toHaveProperty('contributions');
  expect(io).toBe(0);
});

let f: CollectionKindFixture;
beforeAll(async () => {
  f = await createCollectionKindFixture();
}, 120000);

test('native Type anchor declaration covers JSON escaping before contribution rejection', async () => {
  const { kindTypeAnchorFootprint, KIND_TYPE_MAX_BYTES } = await import('../../src/semantic/scope-leaf-selection.ts');
  const anchor = { ...structuralAnchor(newId(0xc100)), type: '\u0001'.repeat(KIND_TYPE_MAX_BYTES) };
  const inputBytes = 4096;
  const bound = kindTypeAnchorFootprint(inputBytes);
  expect(Buffer.byteLength(anchor.type)).toBe(KIND_TYPE_MAX_BYTES);
  expect(Buffer.byteLength(JSON.stringify([anchor]))).toBeGreaterThan(KIND_TYPE_MAX_BYTES + 2048);
  expect(bound.bytes).toBeGreaterThanOrEqual(inputBytes + Buffer.byteLength(JSON.stringify([anchor])));
});
afterAll(async () => {
  await f?.close();
});

/** The named native outcome remains red until all ORIGINAL owner producers are
 * bound. Never replace it with the refusal test above or synthetic evidence.
 * Existing native APIs/fixtures and default maintenance own all successful work.
 */
test('Native Kind Type evidence requires genuine purpose-bound audience origin and admitted per-home attempt and remains current across original terminal negative and disclosure changes', async () => {
  const identities = await identityFixture(f.database.pool, f.database.admin);
  const collection = await f.collection({ visibility: 'public' });
  const root = await identities.create(0x6e00);
  const originals = [await identities.create(0x6e10), await identities.create(0x6e20), await identities.create(0x6e30)];
  const movies = [await f.subject('schema:Movie'), await f.subject('schema:Movie')];
  for (const id of [...originals, ...movies]) await f.add(collection.id, id);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  for (const original of originals) {
    await identities.merge(original, root);
    await identities.finishMove(original, root);
  }
  // Three actual stored supports now name ONE canonical Type vote, less than
  // the two Movie terminals. Counting the aliases would choose Person.
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    const row = await f.complete(collection.id, bearer);
    expect(row).toMatchObject({ presentationKind: 'schema:Movie', presentationKindSource: 'members' });
    expect(row).not.toHaveProperty('typeCounts');
    expect(row).not.toHaveProperty('typeEvidence');
  }
  for (const movie of movies) await f.hide(movie);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  for (const original of originals) await identities.hide(original);
  expect((await f.send(null, 'GET', `/v1/subjects/${root}`)).status).toBe(200);
  // A readable terminal cannot rescue any of its three hidden originals.
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    const row = await f.complete(collection.id, bearer);
    expect(row).toMatchObject({ presentationKind: null, presentationKindSource: 'empty' });
    expect(row).not.toHaveProperty('typeCounts');
  }
  // An excluded original is a retained negative dependency. Restoring it must
  // invalidate the old empty proof even though canonical identity is unchanged.
  await identities.hide(originals[0]!, 'restore');
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  await identities.hide(root);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'empty',
  });
  await identities.hide(root, 'restore');
  expect(await f.complete(collection.id, f.other.bearer)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
}, 120000);

test('a private native Kind audience cannot be borrowed by anonymous or unrelated readers', async () => {
  await f.refresh();
  const collection = await f.collection({ visibility: 'private' });
  await f.add(collection.id, await f.subject('schema:Book'));
  expect(await f.complete(collection.id, f.owner.bearer)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  for (const bearer of [null, f.other.bearer]) {
    const response = await f.send(bearer, 'GET', f.path(collection.id));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).not.toHaveProperty('presentationKind');
    expect(body).not.toHaveProperty('typeCounts');
  }
}, 120000);

// Additional regressions are authored for integrated native verification; UNRUN.
import {
  captureNativeKindTypeDependency,
  compareNativeKindTypeDependencyBody,
  retainNativeKindTypeDependencyBody,
  readNativeKindTypeDependencyBody,
  selectNativeKindTypeDependency,
  kindTypeEvidenceLocalFootprint,
  type NativeKindTypeRetainedBody,
} from '../../src/semantic/kind-type-evidence.ts';
import type { NativeKindTypeAnchor } from '../../src/semantic/scope-leaf-selection.ts';
import { NativeCollectionWork } from '../../src/work-ledger/native-collection-work.ts';
import { routeOf } from '../../src/route/route.ts';

function structuralAnchor(subjectId: string): NativeKindTypeAnchor {
  return {
    subject_id: subjectId,
    present: true,
    writer_enrolled: true,
    writer_version: '1',
    visibility: 'visible',
    security_revision: '1',
    current_release: `sha256:${'a'.repeat(64)}`,
    type: 'schema:Person',
    type_oversized: false,
    revision: 1,
    revision_transaction: crypto.randomUUID(),
    revision_epoch: 1,
    revision_position: '1',
    redirect: null,
    redirect_sequence: null,
    redirect_transaction: null,
    redirect_epoch: null,
    redirect_position: null,
    account_id: null,
  };
}

test('native Type dependency selection retains negative, one-hop and duplicate original semantics', () => {
  const id = newId(0xc100);
  const other = newId(0xc100);
  const reference = {
    canonicalSubjectId: id,
    key: { driver: 'member' as const, storedSubjectId: id, factId: newId(0xc100) },
  };
  const original = { ...structuralAnchor(id), type: null };
  const terminal = structuralAnchor(id);
  const select = (patch: Partial<NativeKindTypeAnchor>, target: NativeKindTypeAnchor | null = terminal) =>
    selectNativeKindTypeDependency({ reference, original: { ...original, ...patch }, terminal: target });
  expect(select({}).state).toBe('candidate');
  expect(select({ present: false, revision: null, current_release: null }).state).toBe('excluded');
  expect(select({ visibility: 'hidden' }).state).toBe('excluded');
  expect(select({ writer_enrolled: false }).state).toBe('unavailable');
  expect(select({ revision_transaction: null }).state).toBe('unavailable');
  expect(select({ redirect: other }).state).toBe('unavailable');
  expect(select({}, null).state).toBe('unavailable');
  expect(select({}, { ...terminal, redirect: other }).state).toBe('unavailable');
  expect(select({}, { ...terminal, present: false }).state).toBe('excluded');
  expect(select({}, { ...terminal, visibility: 'hidden', type: null }).state).toBe('excluded');
  expect(select({}, { ...terminal, type_oversized: true, type: null }).state).toBe('unavailable');
  expect(select({}, { ...terminal, type: 'a'.repeat(4096) }).state).toBe('unavailable');
  const duplicate = { ...reference, key: { ...reference.key, factId: newId(0xc100) } };
  const first = selectNativeKindTypeDependency({ reference, original, terminal });
  const second = selectNativeKindTypeDependency({ reference: duplicate, original, terminal });
  expect(first.state).toBe('candidate');
  expect(second.state).toBe('candidate');
  expect(second.dependencies.reference.key.factId).not.toBe(first.dependencies.reference.key.factId);
  // Both raw dependencies survive. Native Library terminal uniqueness, rather
  // than this structural projection, determines the single canonical vote.
  expect(second.dependencies.reference.canonicalSubjectId).toBe(first.dependencies.reference.canonicalSubjectId);
});

test('local Type body quote includes every repeated anchor lock and retained record point', () => {
  const quote = kindTypeEvidenceLocalFootprint({
    anchorInputBytes: 1000,
    lockInputBytes: 200,
    writeValues: [],
    readValues: [],
  });
  expect(quote).toMatchObject({
    candidateKeys: 11,
    nativeRows: 58,
    nativePoints: 58,
    identityMetadataRows: 0,
    witnessKeys: 0,
    statements: 11,
    emptySeeks: 11,
  });
  expect(quote.bytes).toBeGreaterThan(2 * 6 * (16384 + 16384 + 4096));
});

test('unknown native anchor state cannot become an excluded dependency or a Type contribution', () => {
  const id = newId(0xc100);
  const reference = {
    canonicalSubjectId: id,
    key: { driver: 'member' as const, storedSubjectId: id, factId: newId(0xc100) },
  };
  const original = { ...structuralAnchor(id), type: null };
  const terminal = structuralAnchor(id);
  for (const patch of [{ visibility: null }, { visibility: 'unknown' }, { current_release: 'unknown' }]) {
    expect(selectNativeKindTypeDependency({ reference, original: { ...original, ...patch }, terminal }).state).toBe(
      'unavailable',
    );
    expect(selectNativeKindTypeDependency({ reference, original, terminal: { ...terminal, ...patch } }).state).toBe(
      'unavailable',
    );
  }
  expect(
    selectNativeKindTypeDependency({ reference, original: { ...original, visibility: 'taken_down' }, terminal }).state,
  ).toBe('excluded');
  expect(
    selectNativeKindTypeDependency({
      reference,
      original,
      terminal: { ...terminal, visibility: 'taken_down', type: null },
    }).state,
  ).toBe('excluded');
});

test('native dependency bodies cannot bypass original admission with a structural home', async () => {
  let io = 0;
  const pool = {
    connect() {
      io++;
      throw new Error('Unadmitted checkout');
    },
  } as unknown as Pool;
  const tx = {
    query() {
      io++;
      throw new Error('Unadmitted native body');
    },
  } as unknown as OperationalTransaction;
  const locator = {
    route: 0xc100,
    ownerAccountId: newId(0xc100),
    collectionId: newId(0xc100),
    preparationId: crypto.randomUUID(),
  };
  const context = { kind: 'collection-kind-preparation' as const, tx, locator };
  const deadline = Date.now() + 10000;
  const work = new NativeCollectionWork(allowance(), deadline);
  const id = newId(0xc100);
  await expect(
    captureNativeKindTypeDependency(
      pool,
      context,
      {
        reference: { canonicalSubjectId: id, key: { driver: 'member', storedSubjectId: id, factId: newId(0xc100) } },
        originalDisclosure: 'readable',
        terminalDisclosure: 'readable',
        releaseDigest: `sha256:${'a'.repeat(64)}`,
      },
      work,
      deadline,
    ),
  ).rejects.toThrow();
  const ref = { locator, evidenceId: crypto.randomUUID() };
  // No projected source binding, including one copied from a retained record,
  // is consulted before rejecting the unadmitted native transaction.
  const forged = {} as NativeKindTypeRetainedBody;
  await expect(retainNativeKindTypeDependencyBody(pool, context, ref, forged, work, deadline)).rejects.toThrow();
  await expect(compareNativeKindTypeDependencyBody(pool, context, ref, forged, work, deadline)).rejects.toThrow();
  await expect(readNativeKindTypeDependencyBody(pool, context, ref, forged.binding, work, deadline)).rejects.toThrow();
  expect(Object.values(work.receipt().used).every((value) => value === 0)).toBe(true);
  expect(io).toBe(0);
});

test('Native Kind-Type original and terminal retained dependency read and final same-home verification', async () => {
  await f.refresh();
  const collection = await f.collection({ visibility: 'public' });
  const route = routeOf(collection.id)!;
  const identities = await identityFixture(f.database.pool, f.database.admin);
  const original = await identities.create(route);
  const terminal = await identities.create(route);
  await f.add(collection.id, original);
  await f.add(collection.id, original);
  await identities.merge(original, terminal);
  await identities.finishMove(original, terminal);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  const retained = await f.database.admin.query<{
    body: { dependencies: { original: NativeKindTypeAnchor; terminal: NativeKindTypeAnchor } };
    producer_transaction: string;
  }>(
    `SELECT body, producer_transaction FROM semantic.kind_type_evidence_body
      WHERE route=$1 AND collection_id=$2`,
    [route, collection.id],
  );
  expect(retained.rows.length).toBeGreaterThan(0);
  const body = retained.rows.find((row) => row.body.dependencies.original.subject_id === original);
  expect(body).toBeDefined();
  expect(body!.body.dependencies.original.type).toBeNull();
  expect(body!.body.dependencies.terminal.subject_id).toBe(terminal);
  expect(body!.body.dependencies.terminal.type).toBe('schema:Person');
  expect(body!.producer_transaction).toMatch(/^[0-9]+$/);
  // Same-home subject writers share the exact anchor fence held by final
  // verification. Neither an old retained body nor its readable terminal may
  // rescue the now-hidden original on the next native adoption.
  await identities.hide(original);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'empty',
  });
  await identities.hide(original, 'restore');
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  await identities.hide(terminal);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'empty',
  });
  await identities.hide(terminal, 'restore');
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
}, 120000);
