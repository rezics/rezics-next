import { expect } from 'bun:test';
import { GrantDeniedError } from '../../../src/access/grant-commands.ts';
import { PlatformClosedError } from '../../../src/access/gates/admission.ts';
import { noEffect } from '../../../src/command/command.ts';
import { createLibraryCommandRunner, LibraryNotFoundError } from '../../../src/library/command-support.ts';
import type { Entry } from '../../../src/library/entry-model.ts';
import { prepareEntryRestoration } from '../../../src/library/entry-restore-preparation.ts';
import type { Actor } from '../../../src/request/access.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import { routeOf } from '../../../src/route/route.ts';
import {
  capture,
  catalogStatementBound,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../../support/growth.ts';
import { accountToken, authenticateAccount } from '../../support/admitted-access.ts';
import { createProfileEntryFixture, entryKey, entryTypes, type NativeProfileFixture } from './profile-entry-fixture.ts';

type Slice = 'delete' | 'preparation' | 'restore';
const scopes = ['subject:read', 'library_entry:update', 'library_entry:delete'];
const windowMs = 720 * 60 * 60 * 1000;

type Deleted = { subjectId: string; deletionId: string; revision: number };
async function reject(
  run: () => Promise<unknown>,
  error:
    | typeof GrantDeniedError
    | typeof LibraryNotFoundError
    | typeof PlatformClosedError
    | 'stale'
    | 'occupied'
    | 'expired',
) {
  if (typeof error === 'string') await expect(run()).rejects.toMatchObject({ reason: error });
  else await expect(run()).rejects.toBeInstanceOf(error);
}

/** One real fixture/command path for the three independently checked growth surfaces. */
export async function runEntryUndoGrowth(
  slice: Slice,
  beforeGrowth?: (db: GrowthDatabase, fixture: NativeProfileFixture, setTime: (time?: number) => void) => Promise<void>,
) {
  const db = await openGrowthDatabase();
  let f: NativeProfileFixture | undefined;
  let time: number | undefined;
  const clock = () => new Date(time ?? Date.now());
  try {
    f = await createProfileEntryFixture({ pool: db.pool, clock, singleConnection: true, projectLinks: false });
    const native = f;
    const owner = () => native.owner.actor;
    const renew = async () => {
      for (const identity of [native.owner, native.other, native.steward]) {
        identity.bearer = await accountToken(identity.actor);
        identity.actor = await native.access.authenticate(identity.bearer, {
          pool: db.pool,
          deadline: deadlineFor(30000),
        });
      }
    };
    // A database has one governance bootstrap: related native scenarios share its real identities.
    await beforeGrowth?.(db, native, (value) => {
      time = value;
    });
    await renew();
    const put = async (subjectId: string, actor = owner()) =>
      (await native.commands.putEntry(actor, subjectId, { state: 'planned' }, entryKey())).value.entry;
    const clear = async (entry: Entry, actor = owner()) => {
      const result = await native.commands.deleteEntry(
        actor,
        entry.subjectId,
        entry.revision,
        entryKey(),
        entry.incarnationId!,
      );
      expect(result.value).toEqual({ deletionId: result.transactionId, revision: entry.revision + 1 });
      return { subjectId: entry.subjectId, deletionId: result.transactionId, revision: entry.revision + 1 };
    };
    const undo = (actor: Actor, d: Deleted, key = entryKey()) =>
      native.commands.restoreEntry(
        actor,
        d.subjectId,
        {
          deletionId: d.deletionId,
          revision: d.revision,
        },
        key,
      );
    const target = await native.createSubject('game');
    let fresh = await put(target);
    let deletion = await clear(fresh);
    if (slice === 'delete') fresh = (await undo(owner(), deletion)).value.entry;
    const staleLive = await put(await native.createSubject('game'));
    const occupied = await clear(await put(await native.createSubject('game')));
    await put(occupied.subjectId);
    const hidden = await clear(await put(await native.createSubject('game')));
    const expiring = await clear(await put(await native.createSubject('game')));
    const baselineTime = Date.now() + 60000;
    const replaySubject = await native.createSubject('game');
    const old = await clear(await put(replaySubject));
    const oldKey = entryKey();
    const oldResult = await undo(owner(), old, oldKey);
    const runner = createLibraryCommandRunner({ pool: db.pool, clock });
    const probe = (actor: Actor, selected: Deleted, key = entryKey()) => {
      const deadline = deadlineFor(5000);
      return runner.ownAccountPrepared(
        actor,
        {
          action: 'library_entry:update',
          kind: 'library.fixture.undo_growth',
          requestKey: key,
          input: selected,
          prepare: (attempt) =>
            prepareEntryRestoration(
              { pool: db.pool, access: native.access, clock },
              actor,
              selected,
              attempt,
              deadline,
            ),
        },
        async (_tx, context, prepared) => {
          expect(prepared.at).toBe(context.time);
          if (prepared.kind === 'deferred') throw prepared.error;
          expect(prepared.reference).toMatchObject({
            releaseDigest: native.originalDigest,
            profileId: 'fixture.game',
            stateId: 'planned',
          });
          return noEffect({ observed: true });
        },
      );
    };
    const hiddenKey = entryKey();
    const hiddenReceipt = await probe(owner(), hidden, hiddenKey);
    expect(
      (
        await native.send('steward', 'POST', `/v1/subjects/${hidden.subjectId}:hide`, {
          reason: 'Undo growth visibility',
        })
      ).status,
    ).toBe(200);
    await native.grantLibraryGate(owner().accountId);
    await native.grantLibraryGate(native.other.actor.accountId);
    let noScope: Actor = { kind: 'anonymous' },
      fenced: Actor = noScope,
      suspended: Actor = noScope,
      noGate: Actor = noScope;
    const prepare = async () => {
      time = undefined;
      await renew();
      noScope = await authenticateAccount(
        native.access,
        { pool: db.pool, deadline: deadlineFor(30000) },
        {
          accountId: owner().accountId,
          clientId: owner().clientId,
          scopes: ['subject:read'],
        },
      );
      const fence = await native.identity(scopes);
      fenced = fence.actor;
      await native.revokeIdentity(fence.actor.accountId);
      const suspension = await native.identity(scopes);
      suspended = suspension.actor;
      await native.suspend(suspension.actor.accountId);
      noGate = (await native.identity(scopes)).actor;
      if (slice === 'restore') deletion = await clear(fresh);
      if (
        slice === 'delete' &&
        !(await native.commands.readEntry(owner(), target).catch((error: unknown) => {
          if (error instanceof LibraryNotFoundError) return null;
          throw error;
        }))
      )
        fresh = (await undo(owner(), deletion)).value.entry;
    };
    const main = async () => {
      if (slice === 'delete') {
        const key = entryKey();
        const result = await native.commands.deleteEntry(owner(), target, fresh.revision, key, fresh.incarnationId!);
        deletion = { subjectId: target, deletionId: result.transactionId, revision: fresh.revision + 1 };
        expect(await native.commands.deleteEntry(owner(), target, fresh.revision, key, fresh.incarnationId!)).toEqual({
          ...result,
          replayed: true,
        });
        await reject(
          () =>
            native.commands.deleteEntry(
              owner(),
              staleLive.subjectId,
              staleLive.revision,
              entryKey(),
              fresh.incarnationId!,
            ),
          'stale',
        );
        await reject(
          () => native.commands.deleteEntry(owner(), native.unknownSubject(), 1, entryKey()),
          LibraryNotFoundError,
        );
        await reject(
          () => native.commands.deleteEntry(native.other.actor, staleLive.subjectId, 1, entryKey()),
          LibraryNotFoundError,
        );
      } else if (slice === 'preparation') {
        expect((await probe(owner(), deletion)).value).toEqual({ observed: true });
        await reject(() => probe(owner(), { ...deletion, revision: deletion.revision + 1 }), 'stale');
        await reject(() => probe(owner(), { ...deletion, deletionId: entryKey() }), LibraryNotFoundError);
        await reject(() => probe(owner(), { ...deletion, subjectId: native.unknownSubject() }), LibraryNotFoundError);
        await reject(() => probe(native.other.actor, deletion), LibraryNotFoundError);
        await reject(() => probe(owner(), hidden), LibraryNotFoundError);
        expect(await probe(owner(), hidden, hiddenKey)).toEqual({ ...hiddenReceipt, replayed: true });
      } else {
        const key = entryKey();
        const result = await undo(owner(), deletion, key);
        fresh = result.value.entry;
        expect(fresh.incarnationId).toBe(staleOriginalIncarnation);
        expect(await undo(owner(), deletion, key)).toEqual({ ...result, replayed: true });
        await reject(() => undo(owner(), occupied), 'occupied');
        await reject(() => undo(owner(), { ...occupied, revision: occupied.revision + 1 }), 'stale');
        await reject(() => undo(owner(), { ...occupied, deletionId: entryKey() }), LibraryNotFoundError);
        await reject(() => undo(owner(), { ...occupied, subjectId: native.unknownSubject() }), LibraryNotFoundError);
        await reject(() => undo(native.other.actor, occupied), LibraryNotFoundError);
        await reject(() => undo(owner(), hidden), LibraryNotFoundError);
        time = baselineTime + windowMs;
        try {
          await reject(() => undo(owner(), expiring), 'expired');
          expect(await undo(owner(), old, oldKey)).toEqual({ ...oldResult, replayed: true });
        } finally {
          time = undefined;
        }
      }
      const denied = (actor: Actor) =>
        slice === 'delete'
          ? native.commands.deleteEntry(
              actor,
              staleLive.subjectId,
              staleLive.revision,
              entryKey(),
              staleLive.incarnationId!,
            )
          : slice === 'preparation'
            ? probe(actor, occupied)
            : undo(actor, occupied);
      for (const actor of [{ kind: 'anonymous' } as const, { ...owner() }, noScope, fenced, suspended])
        await reject(() => denied(actor), GrantDeniedError);
      await reject(() => denied(noGate), PlatformClosedError);
    };
    const staleOriginalIncarnation = fresh.incarnationId;
    // Consumable targets are reset by actual commands outside each measured envelope.
    if (slice === 'restore') fresh = (await undo(owner(), deletion)).value.entry;
    const report = await checkGrowth(db, {
      name: `native entry ${slice}: complete authorized, rejected and replayed envelopes`,
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_db, scale, previous) {
        time = undefined;
        await native.setLibraryOpen(true);
        await native.activate(native.originalDigest);
        for (let n = previous; n < scale; n++) {
          await renew();
          // Native business setup only: no raw live/archive, grant, source or definition inserts.
          const created = await native.send('owner', 'POST', '/v1/subjects', {
            type: entryTypes.game,
            labels: { en: `Undo unrelated ${n}` },
          });
          expect(created.status).toBe(201);
          const subjectId = (await created.json()).subject.id as string;
          const unrelated = await native.identity(scopes);
          await put(subjectId, unrelated.actor);
          await clear(await put(subjectId));
          await put(subjectId);
          const release = structuredClone(native.original);
          release.catalogue.version = `undo-${slice}-${n}`;
          expect((await native.send('steward', 'POST', '/v1/definitions/releases', { release })).status).toBe(201);
        }
        await native.activate(native.replacementDigest);
        await native.setLibraryOpen(false);
        await prepare();
        // Classify native work with the shared catalog owner. Immediate denials never reach private points.
        const denied = await capture(
          db,
          () =>
            reject(
              () =>
                slice === 'delete'
                  ? native.commands.deleteEntry({ ...owner() }, target, fresh.revision, entryKey())
                  : probe({ ...owner() }, occupied),
              GrantDeniedError,
            ),
          { includeBackends: true },
        );
        expect(denied.capture.statements.some((sql) => /library\.(?:entry_deleted|entry)\b/.test(sql))).toBe(false);
        const classification = catalogStatementBound(denied.capture);
        expect(classification.catalogStatements).toBeLessThanOrEqual(classification.allowedStatements);
      },
      prepare,
      // grow prepared one consumable warmup; prepare is deliberately not inside the measured operation.
      warmup: () => main(),
      operation: () => main(),
    });
    for (const sample of report.samples) {
      expect(sample.cost.plans).toBeGreaterThan(0);
      expect(sample.cost.statements).toBeGreaterThan(0);
      expect(sample.cost.blocks).toBeGreaterThan(0);
      for (const relation of [
        'library.entry',
        'library.entry_deleted',
        'library.owner_write_counter',
        'library.fact_source_head',
      ])
        expect(sample.cost.relations[relation]?.sequentialScans ?? 0).toBe(0);
    }
    // Native capture includes physical rows*loops/removals and all instrumented pools, not just returned DTOs.
    const proof = await capture(
      db,
      async () => {
        expect(await undo(owner(), old, oldKey)).toEqual({ ...oldResult, replayed: true });
      },
      { includeBackends: true },
    );
    const classification = catalogStatementBound(proof.capture);
    expect(classification.catalogStatements).toBeLessThanOrEqual(classification.allowedStatements);
    expect(costOf(proof.capture).plans).toBeGreaterThan(0);
    expect(
      proof.capture.statements.some((sql) => /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?library\./i.test(sql)),
    ).toBe(false);
    return report;
  } finally {
    await f?.close();
    await db.close();
  }
}

/** Read-only exact owner sequence evidence, never a positive setup path. */
export async function ownerSequence(db: GrowthDatabase, f: NativeProfileFixture) {
  return (
    await db.admin.query<{ seq: string }>(
      'SELECT seq::text FROM library.owner_write_counter WHERE route=$1 AND account_id=$2',
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId],
    )
  ).rows[0]!.seq;
}
