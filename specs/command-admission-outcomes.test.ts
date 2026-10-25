import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Actor, Attempt, CommandAdmissionDriver, Fixture } from './command-admission-outcomes-driver.ts';

// A green support verifier proves executable RED coverage only, never conformance.
setDefaultTimeout(30_000);
let driver: CommandAdmissionDriver | undefined;
async function setup(mode?: 'missing-scope') {
  const location = process.env.COMMAND_ADMISSION_DRIVER_MODULE;
  if (!location) throw new Error('Missing command admission driver');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('COMMAND_ADMISSION_DRIVER_MODULE must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Command admission driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createCommandAdmissionDriver !== 'function') {
    throw new Error('Command admission driver must export createCommandAdmissionDriver');
  }
  driver = await binding.createCommandAdmissionDriver();
  const d = driver!;
  const f = await d.seed(mode);
  expect(Object.isFrozen(f.actor)).toBe(true);
  expect(Object.isFrozen(f.actor.scopes)).toBe(true);
  expect(f.actor.kind).toBe('account');
  expect(f.actor.requestedBy).toMatch(/^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
  expect(f.deadline - f.authenticationStartedAt).toBe(180_000);
  expect(f.tokenExpiresAt).toBeGreaterThan(f.deadline);
  expect(f.bearer.length).toBeGreaterThan(0);
  expect(f.keys[0]).not.toBe(f.keys[1]);
  expect(Number.parseInt(f.actor.accountId.slice(24, 28), 16) >>> 4).not.toBe(f.resource.route >>> 4);
  expect(f.actor.scopes.includes(f.action)).toBe(mode !== 'missing-scope');
  expect(await d.account(f)).toMatchObject({ state: 'active', fenced: false });
  expect(BigInt((await d.account(f)).minimumAuthnEpoch)).toBeLessThanOrEqual(BigInt(f.actor.authnEpoch));
  const initial = await d.inspect(f);
  expect(initial.receipts).toEqual([]);
  expect(initial.effects).toEqual([]);
  expect(initial.outbox).toEqual([]);
  return { d, f };
}
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});

function identity(f: Fixture, attempt: Attempt, override?: { actor?: Actor; pool?: object }) {
  expect(attempt.actor).toBe(override?.actor ?? f.actor);
  expect(attempt.access).toBe(f.access);
  expect(attempt.pool).toBe(override?.pool ?? f.pool);
  expect(attempt.startedAt).toBeGreaterThanOrEqual(f.authenticationStartedAt);
  expect(attempt.startedAt).toBeLessThan(f.deadline);
  expect(attempt.startedAt).toBeLessThan(f.tokenExpiresAt);
}
function nativeTime(f: Fixture, attempt: Attempt) {
  expect(typeof attempt.at).toBe('string');
  const at = Date.parse(attempt.at!);
  expect(Number.isFinite(at)).toBe(true);
  expect(at).toBeLessThan(f.tokenExpiresAt);
}
async function success(d: CommandAdmissionDriver, f: Fixture, key = f.keys[0]) {
  const before = await d.inspect(f);
  const attempt = await d.execute(f, key);
  identity(f, attempt);
  nativeTime(f, attempt);
  expect(attempt.result.outcome).toBe('permitted');
  if (attempt.result.outcome !== 'permitted') throw new Error('Native command positive control failed');
  expect(attempt.result.receiptId.length).toBeGreaterThan(0);
  expect(attempt.result.replayed).toBe(false);
  const after = await d.inspect(f);
  expect(after.effects.length).toBe(before.effects.length + 1);
  expect(after.outbox.length).toBeGreaterThan(before.outbox.length);
  expect(after.state).not.toEqual(before.state);
  expect(after.receipts.length).toBe(before.receipts.length + 1);
  expect(after.receipts.filter((r) => r.key === key)).toEqual([
    { id: attempt.result.receiptId, key, response: attempt.result.value },
  ]);
  return attempt.result;
}
async function denies(
  d: CommandAdmissionDriver,
  f: Fixture,
  key = f.keys[1],
  override?: { actor?: Actor; pool?: object },
) {
  const actorBefore = JSON.stringify(f.actor);
  const before = await d.inspect(f);
  const attempt = await d.execute(f, key, override);
  identity(f, attempt, override);
  if (!override) nativeTime(f, attempt);
  // Exact shape forbids receipt ID, stored result, replay flag or other disclosure.
  expect(attempt.result).toEqual({ outcome: 'denied' });
  expect(JSON.stringify(f.actor)).toBe(actorBefore);
  expect(await d.inspect(f)).toEqual(before);
}
async function committed(d: CommandAdmissionDriver, f: Fixture, fact: 'suspended' | 'floor' | 'fence') {
  const before = await d.account(f);
  await d.transition(f, fact); // COMMIT completes before observation or next attempt.
  const current = await d.account(f);
  if (fact === 'suspended') expect(current).toEqual({ ...before, state: 'suspended' });
  if (fact === 'fence') expect(current).toEqual({ ...before, fenced: true });
  if (fact === 'floor') {
    expect(current).toEqual({ ...before, minimumAuthnEpoch: current.minimumAuthnEpoch });
    expect(BigInt(current.minimumAuthnEpoch)).toBeGreaterThan(BigInt(f.actor.authnEpoch));
  }
}

test('initial valid native command succeeds with genuinely authenticated actor and shared receipt', async () => {
  const { d, f } = await setup();
  await success(d, f);
});

test('unchanged current admission permits same-key replay of the original native result without new effects', async () => {
  const { d, f } = await setup();
  const result = await success(d, f);
  const before = await d.inspect(f);
  const replay = await d.execute(f, f.keys[0]);
  identity(f, replay);
  nativeTime(f, replay);
  expect(replay.result).toEqual({ ...result, replayed: true });
  expect(await d.inspect(f)).toEqual(before);
});

test('committed suspension denies the next native mutation with the SAME previously authenticated actor', async () => {
  const { d, f } = await setup();
  await success(d, f);
  await committed(d, f, 'suspended');
  await denies(d, f);
});

test('suspension before the first command denies the cached genuine actor without creating any receipt or effect', async () => {
  const { d, f } = await setup();
  await committed(d, f, 'suspended');
  await denies(d, f, f.keys[0]);
});

test('committed suspension denies SAME-key replay and discloses no stored result or receipt', async () => {
  const { d, f } = await setup();
  await success(d, f);
  await committed(d, f, 'suspended');
  await denies(d, f, f.keys[0]);
});

test('fresh HTTP reauthentication with the old unexpired bearer independently denies 401 after suspension', async () => {
  const { d, f } = await setup();
  await success(d, f);
  await committed(d, f, 'suspended');
  const before = await d.inspect(f);
  for (const key of f.keys) {
    const response = await d.http(f, key);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    const problem = await response.json();
    expect(problem.status).toBe(401);
    expect(problem.code).toBe('invalid_credentials');
    expect(problem.effect_status).toBe('not_applied');
    expect(Object.keys(problem).sort()).toEqual(
      ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id'].sort(),
    );
  }
  expect(await d.inspect(f)).toEqual(before);
});

test('current epoch floor increase denies the SAME cached actor on a new command', async () => {
  const { d, f } = await setup();
  await success(d, f);
  await committed(d, f, 'floor');
  await denies(d, f);
});

test('current epoch floor increase denies SAME-key stored-result replay', async () => {
  const { d, f } = await setup();
  await success(d, f);
  await committed(d, f, 'floor');
  await denies(d, f, f.keys[0]);
});

test('current account fence denies the SAME cached actor on a new command', async () => {
  const { d, f } = await setup();
  await success(d, f);
  await committed(d, f, 'fence');
  await denies(d, f);
});

test('current account fence denies SAME-key stored-result replay', async () => {
  const { d, f } = await setup();
  await success(d, f);
  await committed(d, f, 'fence');
  await denies(d, f, f.keys[0]);
});

test('a copied actor remains denied despite identical authenticated claims', async () => {
  const { d, f } = await setup();
  await success(d, f);
  const actor = Object.freeze({ ...f.actor, scopes: Object.freeze([...f.actor.scopes]) });
  expect(actor).toEqual(f.actor);
  expect(actor).not.toBe(f.actor);
  await denies(d, f, f.keys[1], { actor });
  await denies(d, f, f.keys[0], { actor });
});

test('the genuine actor remains denied on a different pool even against the same database', async () => {
  const { d, f } = await setup();
  await success(d, f);
  const pool = await d.otherPool();
  expect(pool).not.toBe(f.pool);
  await denies(d, f, f.keys[1], { pool });
  await denies(d, f, f.keys[0], { pool });
});

test('suspending one actor leaves an independent unaffected authenticated actor permitted', async () => {
  const { d, f } = await setup();
  await success(d, f);
  const other = await d.seed();
  expect(other.actor.accountId).not.toBe(f.actor.accountId);
  expect(other.access).toBe(f.access);
  expect(other.pool).toBe(f.pool);
  await success(d, other);
  await committed(d, f, 'suspended');
  await denies(d, f);
  await denies(d, f, f.keys[0]);
  await success(d, other, other.keys[1]);
});

test('revoking only the actor resource grant independently denies fresh command and stored replay', async () => {
  const { d, f } = await setup();
  await success(d, f);
  const account = await d.account(f);
  await d.transition(f, 'actor-grant');
  expect(await d.account(f)).toEqual(account);
  await denies(d, f);
  await denies(d, f, f.keys[0]);
});

test('missing only the consented command scope denies despite current account and resource grants', async () => {
  const { d, f } = await setup();
  await success(d, f);
  const missing = await d.seed('missing-scope');
  expect(missing.actor.scopes).not.toContain(missing.action);
  expect(Object.isFrozen(missing.actor)).toBe(true);
  await denies(d, missing, missing.keys[0]);
});

test('revoking only the assigned principal resource grant independently denies fresh command and stored replay', async () => {
  const { d, f } = await setup();
  await success(d, f);
  const account = await d.account(f);
  await d.transition(f, 'principal-grant');
  expect(await d.account(f)).toEqual(account);
  await denies(d, f);
  await denies(d, f, f.keys[0]);
});
