import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ErasureOperationDriver, Fixture, Operation, Persona, Reply } from './erasure-operation-driver';

setDefaultTimeout(60_000);
let driver: ErasureOperationDriver | undefined;
const d = () => {
  if (!driver) throw new Error('Erasure operation driver was not initialized');
  return driver;
};
beforeEach(async () => {
  const location = process.env.ERASURE_OPERATION_DRIVER;
  if (!location) throw new Error('Erasure operation outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) throw new Error('ERASURE_OPERATION_DRIVER must be an absolute path or file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Erasure operation driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createErasureOperationDriver !== 'function') throw new Error('Driver must export createErasureOperationDriver');
  driver = await binding.createErasureOperationDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
async function ok<T>(reply: Reply<T>, status = 200): Promise<T> {
  expect(reply.response.status).toBe(status);
  expect(reply.value).toBeDefined();
  return reply.value!;
}
async function denied(reply: Reply<unknown>, secrets: string[] = [], read = false) {
  expect([401, 403, 404]).toContain(reply.response.status);
  expect(reply.value).toBeUndefined();
  expect(reply.response.headers.get('content-type')).toContain('application/problem+json');
  const body = await reply.response.clone().json();
  expect(body.effect_status).toBe(read ? 'not_applicable' : 'not_applied');
  const wire = await reply.response.clone().text();
  for (const secret of secrets) expect(wire).not.toContain(secret);
}
async function hidden(reply: Reply<unknown>) {
  await denied(reply, [], true);
  expect(reply.response.status).toBe(404);
  const { request_id, ...stable } = await reply.response.clone().json();
  expect(typeof request_id).toBe('string');
  return stable;
}
function operation(op: Operation, done: boolean) {
  expect(op.name).toMatch(/^operations\/[^/]+$/);
  expect(op.done).toBe(done);
  expect(op.metadata.total).toBeGreaterThan(200);
  expect(op.metadata.processed).toBeGreaterThanOrEqual(0);
  expect(op.metadata.processed).toBeLessThanOrEqual(op.metadata.total);
  expect(op.metadata.steps).toBeGreaterThanOrEqual(0);
  if (!done) {
    expect(op.response).toBeUndefined();
    expect(op.error).toBeUndefined();
  }
}
async function start(f: Fixture, actor: Persona = 'author', key = randomUUID()) {
  await d().barrier('hold');
  const reply = await d().erase(actor, f.thread, f.authorId, key);
  const op = await ok(reply, 202);
  operation(op, false);
  expect(op.metadata.processed).toBe(0);
  return { op, key, wire: await reply.response.clone().text() };
}
async function bounded(f: Fixture) {
  const trace = await d().trace();
  expect(trace.commands.length).toBeGreaterThan(0);
  for (const command of trace.commands) expect(command.writePartitions).toEqual([f.partition]);
  for (const step of trace.steps) {
    expect(step.postIds.length).toBeGreaterThan(0);
    expect(step.postIds.length).toBeLessThanOrEqual(100);
    expect(new Set(step.postIds).size).toBe(step.postIds.length);
    expect(step.checks.map(c => c.postId).sort()).toEqual([...step.postIds].sort());
    for (const check of step.checks) {
      expect(check.action).toBe('post:erase');
      expect(check.at).toBe(step.at);
      expect(check.partition).toBe(f.partition);
    }
  }
  return trace;
}
async function tombstones(f: Fixture, ids: string[]) {
  for (const post of f.targeted.filter(p => ids.includes(p.id))) {
    for (const revision of post.revisions) {
      expect(await ok(await d().readRevision('author', post.id, revision.id))).toEqual({
        id: revision.id, digest: revision.digest, body: null, availability: 'erased',
      });
    }
    const before = await d().inspect(f);
    await denied(await d().edit('author', post.id, 'must-not-append', randomUUID()));
    expect(await d().inspect(f)).toEqual(before);
  }
}

test('real API LRO per-post revocation and tombstone outcomes remain red without implementation', async () => {
  const f = await d().seed({ posts: 205, revisions: 3 });
  const { op } = await start(f);
  const first = await d().step(op.name);
  expect(first.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThanOrEqual(100);
  const progress = await ok(await d().status('author', op.name));
  operation(progress, false);
  expect(progress.metadata.processed).toBe(first.length);
  const paused = await d().inspect(f);
  expect(paused.posts.filter(p => p.erased).map(p => p.id).sort()).toEqual([...first].sort());
  expect(paused.revisions.filter(r => first.includes(r.postId))).toHaveLength(first.length * 3);
  expect(paused.revisions.filter(r => first.includes(r.postId)).every(r => r.body !== null)).toBe(true);
  await tombstones(f, first);
  await d().authority('author', 'post:erase', 'revoke');
  const revokedAt = await d().authorityTime();
  await denied(await d().status('author', op.name), [op.name], true);
  await d().finish(op.name);
  // Restore only status authority; the failed workflow must remain terminal.
  await d().authority('author', 'post:erase', 'allow');
  const terminal = await ok(await d().status('author', op.name));
  operation(terminal, true);
  expect(terminal.error?.code).toBe(7);
  expect(terminal.response).toBeUndefined();
  expect(terminal.metadata.processed).toBe(first.length);
  const final = await d().inspect(f);
  expect(final.posts.filter(p => p.erased).map(p => p.id).sort()).toEqual([...first].sort());
  expect(final.revisions.filter(r => first.includes(r.postId)).every(r => r.body === null && r.erased)).toBe(true);
  expect(final.posts.filter(p => !first.includes(p.id))).toEqual(paused.posts.filter(p => !first.includes(p.id)));
  expect(final.revisions.filter(r => !first.includes(r.postId))).toEqual(paused.revisions.filter(r => !first.includes(r.postId)));
  const trace = await bounded(f);
  expect(trace.steps.length).toBeGreaterThan(1);
  const later = trace.steps.slice(1).flatMap(s => s.checks);
  expect(later.length).toBeGreaterThan(0);
  expect(later.every(c => !c.allowed && c.at >= revokedAt)).toBe(true);
});

test('native completion purges every targeted history and copies while retaining unrelated authors', async () => {
  const f = await d().seed({ posts: 205, revisions: 3 });
  const before = await d().inspect(f);
  const { op } = await start(f, 'legal');
  await d().step(op.name);
  await d().finish(op.name);
  const done = await ok(await d().status('legal', op.name));
  operation(done, true);
  expect(done.error).toBeUndefined();
  expect(done.response).toEqual({ erasedPosts: f.targeted.length });
  expect(done.metadata.processed).toBe(f.targeted.length);
  await tombstones(f, f.targeted.map(p => p.id));
  const final = await d().inspect(f);
  const ids = f.targeted.map(p => p.id);
  expect(final.revisions.filter(r => ids.includes(r.postId))).toHaveLength(615);
  expect(final.revisions.filter(r => ids.includes(r.postId)).every(r => r.body === null && r.erased)).toBe(true);
  expect(final.posts.filter(p => ids.includes(p.id)).every(p => p.erased)).toBe(true);
  expect(final.revisions.filter(r => !ids.includes(r.postId))).toEqual(before.revisions.filter(r => !ids.includes(r.postId)));
  expect(final.posts.filter(p => !ids.includes(p.id))).toEqual(before.posts.filter(p => !ids.includes(p.id)));
  const copies = JSON.stringify({ receipts: final.receipts, outbox: final.outbox, search: await d().search(f.marker) });
  for (const post of f.targeted) for (const revision of post.revisions) expect(copies).not.toContain(revision.body);
  expect(await d().search(f.marker)).toEqual([]);
  const trace = await bounded(f);
  expect(trace.steps.filter(s => s.checks.every(c => c.allowed)).flatMap(s => s.postIds).sort()).toEqual(ids.sort());
  expect(done.metadata.steps).toBe(trace.steps.length);
});

test('selection authorId supplies no authority and current account formula guards exact initiator status and replay', async () => {
  const f = await d().seed({ posts: 205, revisions: 3 });
  const before = await d().inspect(f);
  for (const actor of ['anonymous', 'unrelated', 'suspended', 'revoked'] as const) {
    await denied(await d().erase(actor, f.thread, f.authorId, randomUUID()));
    expect(await d().inspect(f)).toEqual(before);
  }
  const { op, key, wire } = await start(f);
  const unknown = await hidden(await d().status('author', d().unknownOperation()));
  // unrelated has account:read on its own account, including consented scope.
  expect(await hidden(await d().status('unrelated', op.name))).toEqual(unknown);
  for (const axis of ['account:read', 'account:read-scope', 'account:read-principal', 'post:erase', 'suspension'] as const) {
    await d().authority('author', axis, 'revoke');
    await denied(await d().status('author', op.name), [op.name], true);
    const snapshot = await d().inspect(f);
    const replay = await d().erase('author', f.thread, f.authorId, key);
    await denied(replay, [op.name, wire]);
    expect(await d().inspect(f)).toEqual(snapshot);
    await d().authority('author', axis, 'allow');
  }
  await d().finish(op.name);
});

test('durable native restart and duplicate original key retain one operation and original 202', async () => {
  const f = await d().seed({ posts: 205, revisions: 3 });
  const { op, key, wire } = await start(f);
  const duplicate = await d().erase('author', f.thread, f.authorId, key);
  expect(duplicate.response.status).toBe(202);
  expect(await duplicate.response.clone().text()).toBe(wire);
  await d().step(op.name);
  await d().restart();
  await d().finish(op.name);
  const replay = await d().erase('author', f.thread, f.authorId, key);
  expect(replay.response.status).toBe(202);
  expect(await replay.response.clone().text()).toBe(wire);
  expect(replay.value?.name).toBe(op.name);
  const final = await d().inspect(f);
  expect(final.operations.map(o => o.name)).toEqual([op.name]);
  expect(final.effects.map(e => e.postId).sort()).toEqual(f.targeted.map(p => p.id).sort());
  expect(new Set(final.effects.map(e => e.id)).size).toBe(final.effects.length);
  const done = await ok(await d().status('author', op.name));
  operation(done, true);
  expect(done.metadata.processed).toBe(f.targeted.length);
  await bounded(f);
});

test('single post erase and takedown are synchronous point commands without thread scans', async () => {
  const f = await d().seed({ posts: 205, revisions: 3 });
  const before = await d().inspect(f);
  await ok(await d().erasePost('author', f.targeted[0]!.id, randomUUID()));
  await ok(await d().takedown('legal', f.targeted[1]!.id, randomUUID()));
  const final = await d().inspect(f);
  expect(final.operations).toEqual(before.operations);
  expect(final.posts.filter(p => ![f.targeted[0]!.id, f.targeted[1]!.id].includes(p.id)))
    .toEqual(before.posts.filter(p => ![f.targeted[0]!.id, f.targeted[1]!.id].includes(p.id)));
  expect(final.revisions.filter(r => r.postId === f.targeted[0]!.id).every(r => r.body === null && r.erased)).toBe(true);
  expect(final.posts.find(p => p.id === f.targeted[1]!.id)?.visibility).toBe('taken_down');
  const trace = await bounded(f);
  expect(trace.steps).toEqual([]);
  expect(trace.commands).toHaveLength(2);
  expect(trace.commands.every(c => c.threadScanRows === 0)).toBe(true);
});

test('checkGrowth binding measures bounded initiation status and native steps', async () => {
  const results = await d().checkGrowth({ seed: 731, scales: [32, 256, 2048], measurements: ['initiation', 'status', 'native-step'] });
  expect(results.map(r => r.measurement).sort()).toEqual(['initiation', 'native-step', 'status']);
  for (const result of results) {
    expect(result.scales).toEqual([32, 256, 2048]);
    expect(result.seedCalls).toBe(3);
    expect(result.rows).toEqual('constant');
    expect(result.statements).toEqual('constant');
    expect(result.buffers).toEqual('logarithmic');
    expect(result.passed).toBe(true);
    expect(result.samples.map(s => s.scale)).toEqual([32, 256, 2048]);
    expect(new Set(result.samples.map(s => s.rows)).size).toBe(1);
    expect(new Set(result.samples.map(s => s.statements)).size).toBe(1);
    for (const sample of result.samples) {
      expect(sample.rows).toBeGreaterThan(0);
      expect(sample.statements).toBeGreaterThan(0);
      expect(sample.buffers).toBeGreaterThan(0);
    }
  }
});
