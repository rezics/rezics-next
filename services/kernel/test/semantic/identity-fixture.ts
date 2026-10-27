import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { accessCommandAuthorization, accessCheck, type Access, type Actor, type AccountActor } from '../../src/request/access.ts';
import type { AuthoritativeTime } from '../../src/command/command.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { moderateSubject } from '../../src/semantic/moderation.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createRealAccess } from './real-access.ts';
import type { SubjectComponent } from '../../src/semantic/subject.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../../src/tokens/list-cursor.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

// These are consumer-side contract types, not an implementation or a second authority.
export type IdentityBasis = Readonly<{ digest: string }>;
export type HomeIdentity = Readonly<{
  partition: number;
  epoch: number;
  home: string;
  generation: bigint;
  pending: bigint;
}>;
export type IdentityReadOptions = Readonly<{
  access: Access;
  actor: Actor;
  deadline: number;
  nativeT?: AuthoritativeTime;
}>;
export type TerminalIdentity =
  | { state: 'ready'; id: string; components: readonly SubjectComponent[] }
  | { state: 'not_ready' }
  | null;
export type BasisRead = { state: 'ready'; basis: IdentityBasis } | { state: 'not_ready' };
export type AliasWindow =
  | { state: 'not_ready' | 'basis_changed' }
  | {
      state: 'ready';
      originals: readonly string[];
      after: string | null;
      exhausted: boolean;
      examined: number;
      points: number;
    };
export type TerminalReader = (pool: Pool, id: string, options: IdentityReadOptions) => Promise<TerminalIdentity>;
export type BasisReader = (pool: Pool, options: { deadline: number }) => Promise<BasisRead>;
export type HomeReader = (client: PoolClient, partition: number) => Promise<HomeIdentity>;
export type GroupReader = (
  pool: Pool,
  options: {
    terminal: string;
    basis: IdentityBasis;
    after: string | null;
    limit: number;
    deadline: number;
  },
) => Promise<AliasWindow>;

/** Resolve only after native setup has proved the relevant baseline. Missing exports are deliberate native reds. */
async function requiredExport<T>(module: string, name: string): Promise<T> {
  const path = new URL(`../../src/semantic/${module}.ts`, import.meta.url).href;
  let exported: Record<string, unknown> = {};
  try {
    exported = await import(path);
  } catch (error) {
    if (!(error instanceof Error) || !/Cannot find module|ModuleNotFound/.test(error.message)) throw error;
    // A missing dependency of a present implementation must remain an import failure.
    if (await Bun.file(new URL(path)).exists()) throw error;
  }
  expect(exported[name], `Missing additive semantic/${module}.${name}; native baseline completed`).toBeFunction();
  return exported[name] as T;
}
export const terminalReader = () => requiredExport<TerminalReader>('terminal-identity', 'readTerminalSubjectIdentity');
export const basisReader = () => requiredExport<BasisReader>('identity-basis', 'readIdentityBasis');
export const homeReader = () => requiredExport<HomeReader>('identity-basis', 'readIdentityHome');
export const groupReader = () => requiredExport<GroupReader>('alias-group', 'readSubjectAliasGroup');
export const release = { digest: bundledDigest, release: bundledRelease };
export const globalResource = { route: 0, id: GLOBAL_CONTEXT };
export const digest = (value: string) => createHash('sha256').update(value).digest();
export const deadline = () => Date.now() + 30_000;
export const resource = (id: string) => ({ route: routeOf(id)!, id });

export async function identityFixture(pool: Pool, admin: Pool) {
  const accounts = { editor: newId(0x6d10), reader: newId(0x6d20), other: newId(0x6d30) };
  const actions = ['subject:create', 'subject:read', 'subject:merge', 'moderation:hide', 'collection:create', 'collection:read', 'collection:update'];
  const real = await createRealAccess(admin, accounts, actions);
  const access = real.access({
    actions: new Map(actions.map((action) => [action, {
      anonymous: action === 'subject:read',
      ...(action === 'collection:create' ? { 'x-resource-types': ['library.collection'] } : {}),
    }])),
  });
  for (const action of ['subject:create', 'subject:merge', 'moderation:hide'])
    await real.grant(globalResource, 'editor', action);
  await bootstrapRelease(pool, bundledRelease);
  const editor = await access.authenticate(real.bearer('editor'), { pool, deadline: deadline() });
  const reader = await access.authenticate(real.bearer('reader'), { pool, deadline: deadline() });
  const other = await access.authenticate(real.bearer('other'), { pool, deadline: deadline() });
  async function authorization(action: string) {
    return accessCommandAuthorization(access, editor, action, globalResource, { pool, deadline: deadline() }, () => new Error(`Denied ${action}`));
  }
  async function create(route = 0x6e10, label = 'Identity fixture') {
    const target = { route, id: newId(route) };
    const key = randomUUID();
    const result = await createSubject(pool, {
      actor: editor, target, idempotencyKey: key, digest: digest(key), release,
      item: { type: 'schema:Person', labels: { en: label } },
      authorization: await authorization('subject:create'),
    });
    expect(result.subject.id).toBe(target.id);
    return target.id;
  }
  async function merge(original: string, terminal: string, key = randomUUID()) {
    const result = await mergeSubjects(pool, {
      actor: editor, subjects: [original, terminal], survivor: terminal,
      idempotencyKey: key, digest: digest(key), release,
      authorization: await authorization('subject:merge'), deadline: deadline(),
    });
    expect(result.redirected).toBe(original);
    expect(result.survivor).toBe(terminal);
    return result;
  }
  async function hide(id: string, action: 'hide' | 'restore' = 'hide') {
    const key = randomUUID();
    await moderateSubject(pool, {
      actor: editor, subject: id, action, body: { reason: 'Native identity disclosure test' },
      idempotencyKey: key, digest: digest(key), authorization: await authorization('moderation:hide'), deadline: deadline(),
    });
  }
  async function finishMove(original: string, terminal: string) {
    // This is the existing bounded native maintenance entry point, not a fabricated checkpoint.
    for (let step = 0; step < 100; step++) if (!(await moveMergePage(pool, original, terminal))) return;
    throw new Error('Native alias maintenance did not finish');
  }
  async function baseline(id: string, actor: Actor = reader) {
    const target = resource(id);
    const check = await accessCheck(access, actor, 'subject:read', {
      ...target, eligibility: subjectReadEligibility(target),
    }, { pool, deadline: deadline() });
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row = await client.query('SELECT visibility FROM semantic.subject WHERE route=$1 AND subject_id=$2', [target.route, id]);
      expect(row.rows[0]?.visibility).toBe('visible');
      expect(await check(client)).toBe(true);
      await client.query('COMMIT');
    } finally { client.release(); }
  }
  async function aliases(count: number, options: { conceal?: boolean; stored?: (id: string) => Promise<void> } = {}) {
    const root = await create(0x6e00, 'Alias group root');
    const originals: string[] = [];
    for (let index = 0; index < count; index++) originals.push(await create(0x6e10));
    originals.sort();
    // Save the original IDs through the real owner BEFORE native merging canonicalizes new additions.
    for (const id of originals) {
      await options.stored?.(id);
      await merge(id, root);
      await finishMove(id, root);
    }
    if (options.conceal !== false) for (const id of originals.slice(0, -1)) await hide(id);
    await baseline(root);
    await baseline(originals.at(-1)!);
    return { root, originals, last: originals.at(-1)! };
  }
  return { pool, admin, accounts, real, access, editor, reader, other, create, merge, hide, finishMove, baseline, aliases, authorization };
}
export type IdentityFixture = Awaited<ReturnType<typeof identityFixture>>;
export function readOptions(f: IdentityFixture, actor: Actor = f.reader): IdentityReadOptions {
  return { access: f.access, actor, deadline: deadline() };
}
export async function readyBasis(read: BasisReader, pool: Pool): Promise<IdentityBasis> {
  const result = await read(pool, { deadline: deadline() });
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('Expected complete native identity maintenance');
  expect(result.basis.digest).toMatch(/^[a-f0-9]{64}$/);
  return result.basis;
}
export function readyWindow(result: AliasWindow) {
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('Expected a ready native alias window');
  expect(result.originals.length).toBeLessThanOrEqual(100);
  expect(result.examined).toBeGreaterThanOrEqual(result.originals.length);
  expect(result.examined).toBeLessThanOrEqual(101);
  // Four key-only identity/member points per candidate and lookahead, plus two root checks.
  expect(result.points).toBeLessThanOrEqual(4 * result.examined + 2);
  return result;
}
export const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(96)]]) };
export const binding = (viewer: string | null, group: string): ListCursorBinding => ({
  route: 'GET /v1/zones/{id}/subjects', viewer,
  query: { zone: 'identity-contract', query: 'native', group, limit: 100 },
});
/** Exact proposed fixed handoff: no nested owner tokens or serialized source vector. */
export async function continueGroup(viewer: string | null, group: string, basis: IdentityBasis, after: string | null, now = new Date()) {
  return encodeListCursor(tokens, binding(viewer, group), {
    epoch: 1, after: [basis.digest, '', group, 0, after ?? '', '', '', 1],
  }, now);
}
export async function reconstruct(token: string, viewer: string | null, group: string, basis: IdentityBasis, now = new Date()) {
  const decoded = await decodeListCursor(tokens, binding(viewer, group), token, now);
  if (!decoded.ok) return decoded;
  if (decoded.after.length !== 8 || decoded.after[0] !== basis.digest || decoded.after[2] !== group)
    return { ok: false as const, reason: 'invalid' as const };
  return { ok: true as const, after: String(decoded.after[4]) || null };
}
export const homeOf = (id: string) => partitionOf(routeOf(id)!);
