import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as store from '../../src/library/canonical-source-store.ts';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { accessCheck } from '../../src/request/access.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { encodeListCursor, decodeListCursor } from '../../src/tokens/list-cursor.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  canonicalFixture,
  allowance,
  ownerAllowance,
  receipt,
  charged,
  owner,
  ownerProgress,
  parked,
  nativeDynamicDriver,
  resource,
  deadline,
  NIL,
  candidateSQL,
  groupSQL,
  repairSQL,
  publicationSQL,
  schemaExpectation,
  sourceIndexExpectations,
  type CanonicalFixture,
} from './canonical-source-fixture.ts';

let db: GrowthDatabase;
let f: CanonicalFixture;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await canonicalFixture(db);
});

test('native curated setup preserves exact x y x occurrence identities order and notes', async () => {
  const c = await f.collection('public');
  const x = await f.subject();
  const y = await f.subject();
  const first = await f.add(c.id, x, 'First x');
  const second = await f.add(c.id, y, 'Only y');
  const third = await f.add(c.id, x, 'Second x');
  const rows = await f.facts(c.id);
  expect(rows.map((row) => [row.member_id, row.subject_id, row.note])).toEqual([
    [first.id, x, 'First x'],
    [second.id, y, 'Only y'],
    [third.id, x, 'Second x'],
  ]);
  expect(rows[0]!.ordinal_key < rows[1]!.ordinal_key && rows[1]!.ordinal_key < rows[2]!.ordinal_key).toBe(true);
  expect(await f.readable(x)).toBe(true);
  expect(await f.readable(y)).toBe(true);
});

test('private builtin canonical source uses all four native fact drivers with overlap and removed facts', async () => {
  const native = await nativeDynamicDriver(f);
  try {
    const subjects = await Promise.all(Array.from({ length: 5 }, () => native.provisionSubject('game')));
    const [state, label, session, holding, removed] = subjects.map((subject) => subject.id) as [
      string,
      string,
      string,
      string,
      string,
    ];
    for (const response of [
      await native.setEntryState(state, native.profiles.game.states[0]!.id),
      await native.addLabel(label, 'Independent only'),
      await native.startProgressSession(session),
      await native.createHolding(holding),
      await native.addLabel(state, 'Overlap'),
      await native.createHolding(state),
      await native.createHolding(removed),
      await native.removeAllPrivateFacts(removed),
    ])
      expect(response.ok).toBe(true);
    await native.resumeAndSettle();
    const list = await native.request('owner', {
      method: 'GET',
      path: `/v1/collections?curatorAccountId=${native.accounts.owner.id}&limit=100`,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { collections: { id: string; builtin?: { kind: string } }[] };
    const everything = body.collections.find((c) => c.builtin?.kind === 'everything');
    expect(everything).toBeDefined();
    const page = await native.request('owner', {
      method: 'GET',
      path: `/v1/collections/${everything!.id}/members?limit=100`,
    });
    expect(page.status).toBe(200);
    const result = (await page.json()) as { members: { subjectId: string }[]; next: string | null };
    expect(result.next).toBeNull();
    expect(result.members.map((row) => row.subjectId).sort()).toEqual([state, label, session, holding].sort());
    const facts = (await native.inspect()).facts.filter((fact) => fact.accountId === native.accounts.owner.id);
    expect(new Set(facts.map((fact) => fact.kind))).toEqual(new Set(['state', 'label', 'session', 'holding']));
    expect(facts.some((fact) => fact.subjectId === removed)).toBe(false);
    const denied = await native.request('other', {
      method: 'GET',
      path: `/v1/collections/${everything!.id}/members?limit=100`,
    });
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain(label);
  } finally {
    await native.close();
  }
}, 120_000);

test('public dynamic canonical authority freezes complete activated A and erases private pending B on terminal deletion', async () => {
  const native = await nativeDynamicDriver(f);
  try {
    const a = await native.provisionSubject('game');
    const b = await native.provisionSubject('game');
    expect((await native.addLabel(a.id, 'Published A')).ok).toBe(true);
    await native.resumeAndSettle();
    const list = await native.request('owner', {
      method: 'GET',
      path: `/v1/collections?curatorAccountId=${native.accounts.owner.id}&limit=100`,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { collections: { id: string; revision: number; builtin?: { kind: string } }[] };
    const everything = body.collections.find((c) => c.builtin?.kind === 'everything');
    expect(everything).toBeDefined();
    const publish = await native.request('owner', {
      method: 'PATCH',
      path: `/v1/collections/${everything!.id}`,
      headers: { 'Idempotency-Key': `"${randomUUID()}"` },
      body: { revision: everything!.revision, visibility: 'public' },
    });
    expect(publish.ok).toBe(true);
    await native.resumeAndSettle();
    const adopted = (await native.inspect()).collections.find((c) => c.id === everything!.id)!;
    const read = async () => {
      const response = await native.request('anonymous', {
        method: 'GET',
        path: `/v1/collections/${everything!.id}/members?limit=100`,
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ members: { subjectId: string }[]; next: string | null }>;
    };
    expect((await read()).members.map((row) => row.subjectId)).toEqual([a.id]);
    await native.holdProjectionConsumer();
    expect((await native.addLabel(b.id, 'Private pending B')).ok).toBe(true);
    expect((await native.deleteAccount()).ok).toBe(true);
    await native.resumeAndSettle();
    const frozen = await read();
    expect(frozen.members.map((row) => row.subjectId)).toEqual([a.id]);
    expect(JSON.stringify(frozen)).not.toContain('Private pending B');
    const after = await native.inspect();
    expect(after.collections.find((c) => c.id === everything!.id)).toMatchObject({
      frozen: true,
      sourceGeneration: adopted.sourceGeneration,
    });
    expect(after.facts.some((fact) => fact.accountId === native.accounts.owner.id)).toBe(false);
  } finally {
    await native.close();
  }
}, 120_000);
afterAll(async () => {
  await db?.close();
});

test('derived canonical Collection access paths preserve facts and resume charged alias groups beyond 256', async () => {
  const c = await f.collection('public');
  const [a, middle, z] = (await Promise.all([f.subject(), f.subject(), f.subject()])).sort() as [
    string,
    string,
    string,
  ];
  const first = await f.add(c.id, a, 'Original first');
  const second = await f.add(c.id, middle, 'Middle');
  const third = await f.add(c.id, z, 'Terminal');
  const fourth = await f.add(c.id, a, 'Repeated original');
  const before = await f.facts(c.id);
  expect(before.map((row) => row.member_id)).toEqual([first.id, second.id, third.id, fourth.id]);
  await f.merge(a, z);
  expect(await f.facts(c.id)).toEqual(before);
  expect(await f.readable(a)).toBe(true);
  expect(await f.readable(z)).toBe(true);
  const ready = await f.build(c.id);
  const reserved = allowance(1);
  const head = await store.seekCanonicalSourceGroup(db.pool, {
    ...f.call(c.id, reserved),
    ...ready,
    afterSubjectId: null,
  });
  receipt(head.work, reserved);
  expect(head).toMatchObject({ state: 'ready', subjectId: middle, coveredThrough: middle, exhausted: false });
  const tail = await store.seekCanonicalSourceGroup(db.pool, {
    ...f.call(c.id, allowance(1)),
    ...ready,
    afterSubjectId: middle,
  });
  expect(tail).toMatchObject({ state: 'ready', subjectId: z, coveredThrough: z });
  const native = await owner(f, c.id);
  const prefix = await native.api.prefix({ ...native.context, source: native.source, afterSubjectId: null });
  expect(prefix.candidates.map((row) => row.subjectId)).toEqual([middle, z]);
  expect(await f.facts(c.id)).toEqual(before);
});

for (const count of [257, 4096])
  test(`native last readable alias survives ${count} originals through the same direct and page group progress`, async () => {
    const { c, terminal, originals } = await f.aliases(count);
    const before = await f.facts(c.id);
    const ready = await f.build(c.id);
    let progress: store.CanonicalGroupProgress = { pendingSubjectId: terminal, after: null, ...ready };
    let encountered = 0;
    let lastSeen = false;
    for (let step = 0; step < Math.ceil(count / 100) + 2; step++) {
      const reserved = allowance(100);
      const window = await store.readCanonicalSourceGroup(db.pool, {
        ...f.call(c.id, reserved),
        basis: ready.basis,
        progress,
      });
      receipt(window.work, reserved);
      expect(window.state).toBe('ready');
      if (window.state !== 'ready') throw new Error('Admitted native alias group is not ready');
      expect(window.rows.length).toBeLessThanOrEqual(100);
      expect(charged(window.work)).toBe(window.rows.length);
      expect(window.progress.pendingSubjectId).toBe(terminal);
      expect(window.rows.map((row) => row.key.storedSubjectId)).toEqual(
        originals.slice(encountered, encountered + window.rows.length),
      );
      encountered += window.rows.length;
      if (encountered <= 256) {
        expect(window.exhausted).toBe(false);
        expect(window.rows.some((row) => row.key.storedSubjectId === originals.at(-1))).toBe(false);
      }
      lastSeen ||= window.rows.some((row) => row.key.storedSubjectId === originals.at(-1));
      if (window.exhausted) break;
      expect(window.examinedThrough).not.toEqual(progress.after);
      // Reconstruct a fresh caller with just compact trusted keyset/basis; no local permissions or seen set.
      progress = structuredClone(window.progress);
    }
    expect(encountered).toBe(count);
    expect(lastSeen).toBe(true);
    expect(await f.facts(c.id)).toEqual(before);
    const native = await owner(f, c.id);
    let pending: unknown;
    let positive = false;
    let sourceAdvanced = false;
    let aliasAdvanced = false;
    let lastSourceAfter: string | null = null;
    let lastAliasAfter: string | null = null;
    for (let step = 0; step < Math.ceil(count / 100) + 2; step++) {
      const result = await native.api.containsSubject({
        ...native.context,
        allowance: ownerAllowance(100),
        source: native.source,
        subjectId: terminal,
        progress: pending,
      });
      if (result.result === true) {
        expect(result.positiveEvidence).toBeDefined();
        const final = await native.api.containsSubject({
          ...native.context,
          allowance: ownerAllowance(100),
          source: native.source,
          subjectId: terminal,
          positiveEvidence: result.positiveEvidence,
          finalUse: true,
        });
        expect(final.result).toBe(true);
        expect(final.positiveEvidence).toBeDefined();
        positive = true;
        break;
      }
      expect(result.result).toBe('not_proven');
      expect(result.progress).toBeDefined();
      expect(result.progress).not.toEqual(pending);
      const next = result.progress as {
        subjectId: string;
        basisDigest: string;
        sourceAfter: string | null;
        aliasAfter: string | null;
      };
      expect(next.subjectId).toBe(terminal);
      expect(next.basisDigest).toBe(ready.basis.digest);
      if (next.sourceAfter !== null) {
        expect(next.sourceAfter).toMatch(/^1:[0-5]:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
        sourceAdvanced ||= next.sourceAfter !== lastSourceAfter;
      }
      if (next.aliasAfter !== null) {
        expect(originals).toContain(next.aliasAfter);
        aliasAdvanced ||= next.aliasAfter !== lastAliasAfter;
      }
      lastSourceAfter = next.sourceAfter;
      lastAliasAfter = next.aliasAfter;
      pending = result.progress;
    }
    expect(positive).toBe(true);
    expect(sourceAdvanced).toBe(true);
    expect(aliasAdvanced).toBe(true);
    expect(f.real.readChecks.some((check) => check.resource.id === originals.at(-1))).toBe(true);
    expect(f.real.readChecks.some((check) => check.resource.id === terminal)).toBe(true);
  }, 900_000);

test('5000 duplicate occurrences resume at quota one and one hundred with every encountered row charged', async () => {
  const c = await f.collection('public');
  const x = await f.subject();
  for (let n = 0; n < 5000; n++) await f.add(c.id, x, `Occurrence ${n}`);
  const before = await f.facts(c.id);
  expect(before).toHaveLength(5000);
  const expectedKeys = before.map((row) => row.member_id as string).sort();
  const ready = await f.build(c.id);
  for (const quota of [1, 100]) {
    let progress: store.CanonicalGroupProgress = { pendingSubjectId: x, after: null, ...ready };
    let examined = 0;
    for (let step = 0; step <= Math.ceil(5000 / quota); step++) {
      const reserved = allowance(quota);
      const result = await store.readCanonicalSourceGroup(db.pool, {
        ...f.call(c.id, reserved),
        basis: ready.basis,
        progress,
      });
      receipt(result.work, reserved);
      if (result.state !== 'ready') throw new Error('Complete duplicate group not ready');
      expect(charged(result.work)).toBe(result.rows.length);
      expect(result.rows.length).toBeLessThanOrEqual(quota);
      expect(result.rows.map((row) => row.key.factId)).toEqual(
        expectedKeys.slice(examined, examined + result.rows.length),
      );
      expect(result.examinedThrough).toEqual(result.rows.at(-1)?.key ?? progress.after);
      examined += result.rows.length;
      if (result.exhausted) break;
      expect(result.progress.after).not.toEqual(progress.after);
      progress = result.progress;
    }
    expect(examined).toBe(5000);
    const reserved = allowance(1);
    const past = await store.seekCanonicalSourceGroup(db.pool, {
      ...f.call(c.id, reserved),
      ...ready,
      afterSubjectId: x,
    });
    receipt(past.work, reserved);
    expect(past).toMatchObject({ state: 'ready', subjectId: null, exhausted: true });
    expect(charged(past.work)).toBe(0); // Strict > group seek must not enumerate 5000 duplicate rows.
  }
  expect(await f.facts(c.id)).toEqual(before);
}, 900_000);

test('bounded repair publishes only a complete unchanged authority and identity basis', async () => {
  const c = await f.collection();
  const a = await f.subject();
  const b = await f.subject();
  await f.add(c.id, a);
  const member = await f.add(c.id, b);
  const build = await parked(f, c.id);
  const premature = await store.publishCanonicalSourceRepair(db.pool, { ...f.call(c.id), ...build });
  expect(premature.state).toBe('incomplete');
  expect((await store.readCanonicalSourceState(db.pool, f.call(c.id))).state).toBe('not_ready');
  await f.commands.removeMember(f.editor, c.id, member.id, randomUUID());
  const staleStep = await store.repairCanonicalSourceStep(db.pool, { ...f.call(c.id, allowance(1)), ...build });
  expect(staleStep.state).toBe('basis_changed');
  const stalePublish = await store.publishCanonicalSourceRepair(db.pool, { ...f.call(c.id), ...build });
  expect(stalePublish.state).toBe('basis_changed');
  const current = await f.build(c.id, 1);
  await f.add(c.id, b);
  const beforeDelete = await parked(f, c.id);
  const metadata = await f.reads.readCollection(f.editor, c.id);
  await f.commands.deleteCollection(f.editor, c.id, metadata.revision, randomUUID());
  const deleted = await store.publishCanonicalSourceRepair(db.pool, { ...f.call(c.id), ...beforeDelete });
  expect(deleted.state).not.toBe('published');
  expect((await store.readCanonicalSourceState(db.pool, f.call(c.id))).state).toBe('not_ready');
  expect(current.generation).not.toBe(build.repair.generation);
});

test('repair crash recovery resumes after the last examined raw source key without rereading repaired history', async () => {
  const c = await f.collection();
  const x = await f.subject();
  for (let n = 0; n < 4; n++) await f.add(c.id, x);
  const p = await parked(f, c.id);
  const restarted = await store.beginCanonicalSourceRepair(db.pool, { ...f.call(c.id), basis: p.basis });
  expect(restarted.state).toBe('working');
  if (restarted.state !== 'working') throw new Error('No durable repair progress');
  expect(restarted.repair).toEqual(p.repair);
  const reserved = allowance(1);
  const step = await store.repairCanonicalSourceStep(db.pool, {
    ...f.call(c.id, reserved),
    basis: p.basis,
    repair: restarted.repair,
  });
  receipt(step.work, reserved);
  expect(step.state).toBe('working');
  if (step.state !== 'working') throw new Error('Repair failed to resume');
  expect(step.examined).toHaveLength(1);
  expect(step.examined[0]).not.toEqual(p.repair.after);
  expect(step.examined[0]!.factId > p.repair.after!.factId).toBe(true);
  const replay = await store.repairCanonicalSourceStep(db.pool, { ...f.call(c.id, allowance(1)), ...p });
  // Old expected checkpoint cannot replace a newer committed checkpoint or its rows.
  expect(replay.state).not.toBe('complete');
  const recovered = await store.beginCanonicalSourceRepair(db.pool, { ...f.call(c.id), basis: p.basis });
  if (recovered.state !== 'working') throw new Error('Lost checkpoint');
  expect(recovered.repair.after).toEqual(step.repair.after);
});

test('merge repoint and native verification unmerge invalidate builds while unrelated editorial changes do not', async () => {
  const c = await f.collection();
  const a = await f.subject();
  const z = await f.subject(0x6b40);
  await f.add(c.id, a);
  await f.add(c.id, z);
  const p = await parked(f, c.id);
  await f.real.grant(resource(z), 'editor', 'subject:create');
  await updateSubjectIdentity(db.pool, {
    subject: z,
    labels: { en: 'Editorial only' },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: await accessCheck(f.access, f.editor, 'subject:create', resource(z), {
      pool: db.pool,
      deadline: deadline(),
    }),
  });
  const unchanged = await store.observeCanonicalSource(db.pool, f.call(c.id));
  expect(unchanged.state).toBe('admitted');
  if (unchanged.state !== 'admitted') throw new Error('Editorial change destroyed identity readiness');
  expect(unchanged.basis.identity).toEqual(p.basis.identity);
  await f.merge(a, z);
  const stale = await store.publishCanonicalSourceRepair(db.pool, { ...f.call(c.id), ...p });
  expect(stale.state).toBe('basis_changed');
  const next = await f.subject(0x6b50);
  const ready = await f.build(c.id);
  await f.merge(z, next); // Includes inherited-member repoint in native maintenance.
  expect((await store.readCanonicalSourceState(db.pool, f.call(c.id))).state).toBe('not_ready');
  const changed = await store.observeCanonicalSource(db.pool, f.call(c.id));
  if (changed.state !== 'admitted') throw new Error('Native repoint did not become ready');
  expect(changed.basis.identity).not.toEqual(ready.basis.identity);
  // Existing trusted platform verification adapter exercises native unmerge, not forged end-user verification.
  const account = f.reader.accountId;
  await ensureAccountAgent(db.pool, { account, kind: 'person', name: null });
  const catalogue = await f.subject();
  await verifyAccountAgent(db.pool, { account, catalogue, receipt: randomUUID() });
  const verified = await store.observeCanonicalSource(db.pool, f.call(c.id));
  expect(verified.state).toBe('admitted');
  await unverifyAccountAgent(db.pool, { account, receipt: randomUUID() });
  const unmerged = await store.observeCanonicalSource(db.pool, f.call(c.id));
  if (verified.state !== 'admitted' || unmerged.state !== 'admitted') throw new Error('Unmerge identity not admitted');
  expect(unmerged.basis.identity).not.toEqual(verified.basis.identity);
  expect(accountAgentId(account)).toBeDefined();
});

for (const anchor of ['source', 'original', 'terminal'] as const)
  test(`revoked ${anchor} after positive discovery is rechecked at final use without disclosure`, async () => {
    const c = await f.collection('public');
    const a = await f.subject();
    const z = await f.subject(0x6b50);
    await f.add(c.id, a);
    await f.merge(a, z);
    expect(await f.readable(a)).toBe(true);
    expect(await f.readable(z)).toBe(true);
    await f.build(c.id);
    const native = await owner(f, c.id);
    const result = await native.api.containsSubject({ ...native.context, source: native.source, subjectId: z });
    expect(result.result).toBe(true);
    if (anchor === 'source') {
      const metadata = await f.reads.readCollection(f.editor, c.id);
      await f.commands.updateCollection(
        f.editor,
        c.id,
        { revision: metadata.revision, visibility: 'private' },
        randomUUID(),
      );
    } else await f.hide(anchor === 'original' ? a : z);
    // Owner invocation must revalidate actual source + original + terminal, even with a previously positive witness.
    const final = native.api.containsSubject({
      ...native.context,
      source: native.source,
      subjectId: z,
      positiveEvidence: result.positiveEvidence,
      finalUse: true,
    });
    if (anchor === 'source') await expect(final).rejects.toMatchObject({ code: 'not_found' });
    else expect((await final).result).not.toBe(true);
  });

test('a readable terminal cannot launder denied originals and a fresh traversal admits a later original grant', async () => {
  const { c, terminal, originals } = await f.aliases(3);
  await f.hide(originals.at(-1)!);
  expect(await f.readable(terminal)).toBe(true);
  for (const original of originals) expect(await f.readable(original)).toBe(false);
  await f.build(c.id);
  const native = await owner(f, c.id);
  let progress: unknown;
  let result: boolean | 'not_proven' = 'not_proven';
  for (let n = 0; n < 5; n++) {
    const evidence = await native.api.containsSubject({
      ...native.context,
      allowance: ownerAllowance(1),
      source: native.source,
      subjectId: terminal,
      progress,
    });
    expect(evidence.result).not.toBe(true);
    result = evidence.result;
    if (result === false) break;
    expect(evidence.progress).toBeDefined();
    progress = evidence.progress;
  }
  expect(result).toBe(false);
  // Subject moderation restore is a real policy change, not an account deletion/restore protocol.
  await f.hide(originals[0]!, 'restore');
  expect(await f.readable(originals[0]!)).toBe(true);
  const fresh = await owner(f, c.id);
  expect(
    (await fresh.api.containsSubject({ ...fresh.context, source: fresh.source, subjectId: terminal, finalUse: true }))
      .result,
  ).toBe(true);
});

test('incomplete native merge mapping is not ready and never supplies false under a negative predicate', async () => {
  const c = await f.collection('public');
  const a = await f.subject();
  const z = await f.subject(0x6b50);
  await f.add(c.id, a);
  await f.merge(a, z, false);
  try {
    expect(await store.observeCanonicalSource(db.pool, f.call(c.id))).toMatchObject({
      state: 'not_ready',
      reason: 'identity',
    });
    expect((await store.readCanonicalSourceState(db.pool, f.call(c.id))).state).toBe('not_ready');
  } finally {
    for (let n = 0; n < 100; n++) if (!(await moveMergePage(db.pool, a, z))) break;
  }
});

test('missing incomplete or stale derived evidence is explicit readiness and never a canonical negative', async () => {
  const c = await f.collection('public');
  const a = await f.subject();
  await f.add(c.id, a);
  expect(await f.readable(a)).toBe(true);
  const unbuilt = await store.readCanonicalSourceState(db.pool, f.call(c.id));
  expect(unbuilt).toMatchObject({ state: 'not_ready', reason: 'unbuilt' });
  const p = await parked(f, c.id);
  expect((await store.readCanonicalSourceState(db.pool, f.call(c.id))).state).toBe('not_ready');
  const z = await f.subject(0x6b50);
  await f.merge(a, z);
  const stale = await store.repairCanonicalSourceStep(db.pool, { ...f.call(c.id), ...p });
  expect(stale.state).toBe('basis_changed');
  const native = await owner(f, c.id);
  const evidence = await native.api.containsSubject({ ...native.context, source: native.source, subjectId: z });
  expect(evidence.result).toBe('not_proven');
  await f.build(c.id);
  // A missing table/index or source-generation owner must fail retryably, never become ready empty.
  await db.admin.query('ALTER TABLE library.canonical_source_fact RENAME TO unavailable_canonical_source_fact');
  try {
    try {
      expect((await store.readCanonicalSourceState(db.pool, f.call(c.id))).state).toBe('not_ready');
    } catch (error) {
      expect(error).toMatchObject({ code: 'dependency_unavailable' });
    }
  } finally {
    await db.admin.query('ALTER TABLE library.unavailable_canonical_source_fact RENAME TO canonical_source_fact');
  }
});

test('native derived DAO schema probe requires strict candidate group repair ranges and bounded publication CAS', async () => {
  // DERIVED ROWS ONLY. This test proves structural SQL bounds, never product membership, grants or basis readiness.
  const c = await f.collection();
  await f.add(c.id, await f.subject());
  const schema = await db.admin.query(`SELECT to_regclass('library.canonical_source_fact') AS fact,
    to_regclass('library.canonical_source_state') AS state, to_regclass('library.collection_member_canonical_repair') AS repair`);
  expect(schema.rows[0], schemaExpectation).toEqual({
    fact: 'library.canonical_source_fact',
    state: 'library.canonical_source_state',
    repair: 'library.collection_member_canonical_repair',
  });
  const generation = newId(routeOf(c.id)!);
  const canonical = newId(0x6b30);
  const basis = 'dao-probe-only-not-admitted';
  await db.admin.query(
    `INSERT INTO library.canonical_source_fact
    (route,collection_id,generation,basis_digest,canonical_subject_id,stored_subject_id,driver,fact_id)
    SELECT $1,$2,$3,$4,$5,$5,'member',('10000000-0000-7000-8000-6b300000'||lpad(to_hex(n),4,'0'))::uuid
    FROM generate_series(1,5000) n`,
    [routeOf(c.id), c.id, generation, basis, canonical],
  );
  const statements: [string, unknown[], string][] = [
    [candidateSQL, [routeOf(c.id), c.id, generation, basis, NIL], 'canonical_source_fact_pkey'],
    [candidateSQL, [routeOf(c.id), c.id, generation, basis, canonical], 'canonical_source_fact_pkey'],
    [
      groupSQL,
      [routeOf(c.id), c.id, generation, basis, canonical, canonical, 'member', NIL, 1],
      'canonical_source_fact_pkey',
    ],
    [repairSQL, [routeOf(c.id), c.id, NIL, NIL, 1], 'collection_member_canonical_repair'],
    [publicationSQL, [routeOf(c.id), c.id, generation, basis, basis], 'canonical_source_state_pkey'],
  ];
  for (const [sql, params, index] of statements) {
    const result = await db.admin.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const plan = result.rows[0]['QUERY PLAN'][0].Plan;
    const nodes = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
    const all = nodes(plan);
    expect(all.some((node) => node['Index Name'] === index)).toBe(true);
    expect(all.some((node) => ['Seq Scan', 'Sort', 'Aggregate', 'Unique'].includes(node['Node Type']))).toBe(false);
    expect(all.reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0)).toBe(0);
    expect(all.every((node) => (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 0) <= 1)).toBe(true);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeGreaterThanOrEqual(0);
    console.log(JSON.stringify({ sql, plan }));
  }
  expect(Object.keys(sourceIndexExpectations)).toEqual(['member', 'entry', 'copy', 'session', 'label', 'output']);
});

test('pending group fits the shared encrypted cursor without permissions or a seen set', async () => {
  const { c: aliasCollection, terminal, originals } = await f.aliases(3);
  const ready = await f.build(aliasCollection.id);
  const window = await store.readCanonicalSourceGroup(db.pool, {
    ...f.call(aliasCollection.id, allowance(1)),
    basis: ready.basis,
    progress: { pendingSubjectId: terminal, after: null, ...ready },
  });
  if (window.state !== 'ready' || !window.progress.after) throw new Error('Actual resumable group key required');
  const native = await owner(f, aliasCollection.id);
  const pending = ownerProgress(window.progress, native.source.observation.basis.digest);
  expect(pending.subjectId).toBe(terminal);
  expect(pending.basisDigest).toBe(ready.basis.digest);
  expect(pending.aliasAfter).toBe(window.progress.aliasAfter ?? null);
  expect(pending.sourceAfter).toBe(`1:0:${window.progress.after.storedSubjectId}:${window.progress.after.factId}`);
  expect(Buffer.byteLength(pending.sourceAfter!)).toBe(77);
  const after = [
    ready.basis.digest,
    '',
    pending.subjectId,
    0,
    pending.aliasAfter ?? '',
    pending.sourceAfter ?? '',
    pending.basisDigest,
    1,
  ];
  const keys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(83)]]) };
  const binding = {
    route: 'GET /v1/zones/{zoneId}',
    viewer: f.reader.accountId,
    query: { collectionId: aliasCollection.id, limit: 1 },
  };
  const now = new Date();
  const epoch = native.source.observation.stamp.epoch;
  const token = await encodeListCursor(keys, binding, { epoch, after }, now);
  expect(token.length).toBeLessThanOrEqual(4096);
  expect(Buffer.from(token, 'base64url').toString()).not.toContain(originals[0]!);
  expect(await decodeListCursor(keys, binding, token, now)).toEqual({ ok: true, epoch, after });
  expect(await decodeListCursor(keys, { ...binding, viewer: f.editor.accountId }, token, now)).toMatchObject({
    ok: false,
  });
});
