import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
interface Write { created: boolean; replayed: boolean; projection: { id: string; subject: string } }
let stack: MediaStack, writer: Member, unadmitted: Member;
let app: ReturnType<typeof createMainApp>, work: string;
const subjects: string[] = [];
const scopes = new Map<string, Set<string>>();
const checked: string[][] = [];

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
const project = (member: Member, subject: string, key = randomUUID()) => app.handle(new Request(
  'http://main.local/v1/projections', { method: 'POST', headers: {
    authorization: `Bearer ${member.token}`, 'idempotency-key': key, 'content-type': 'application/json',
  }, body: JSON.stringify({ subject, frames: [work], actingSubject: member.actor }) }));

beforeAll(async () => {
  stack = await startMediaStack('projection-scope');
  writer = await stack.member('judgment-writer');
  unadmitted = await stack.member('unadmitted-writer');
  await writer.grant('projection:create:root', 'projection.create');
  await writer.grant('semantic:create:root', 'semantic.change');
  work = (await stack.publicWork(writer.actor)).work;
  await writer.grant(`work:read:${work}`, 'work.read');
  for (let index = 0; index < 4; index++) {
    const saved = await json<{ component: string }>(await writer.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: writer.actor,
      state: { component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [{
        predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: work },
      }] },
    }), 201);
    subjects.push(saved.component);
  }
  app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
    content: stack.content, media: stack.media, mediaAccess: stack.mediaAccess,
    projections: new ProjectionStore(stack.accessPool), account: {
      verify: async (request, required) => {
        checked.push([...required]);
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [writer, unadmitted].find(member => member.token === token);
        if (!member) throw new AccountAssertionDenied();
        if (required.some(scope => !scopes.get(member.token)?.has(scope))) {
          throw new AccountAssertionInsufficientScope('Account assertion lacks a required scope');
        }
        return member.principal;
      },
    } });
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('review and discussion bearers create and replay projections under the unchanged Access gate', async () => {
  for (const [index, scope] of ['rating:submit', 'comment:create', 'work:edit'].entries()) {
    scopes.set(writer.token, new Set([scope]));
    checked.length = 0;
    const key = randomUUID();
    const written = await json<Write>(await project(writer, subjects[index]!, key), 201);
    expect(written).toMatchObject({ created: true, replayed: false, projection: { subject: subjects[index] } });
    // Admission verifies the selected consent again instead of requiring rating consent.
    expect(checked.filter(required => required.includes(scope))).toHaveLength(2);
    const replay = await json<Write>(await project(writer, subjects[index]!, key), 200);
    expect(replay).toMatchObject({ created: true, replayed: true, projection: { id: written.projection.id } });
    const existing = await json<Write>(await project(writer, subjects[index]!), 200);
    expect(existing).toMatchObject({ created: false, projection: { id: written.projection.id } });
  }
  const admissions = await stack.accessPool.query(
    "SELECT DISTINCT scope_id FROM access.admission WHERE action = 'projection.create'");
  expect(admissions.rows).toEqual([{ scope_id: 'projection:create:root' }]);
}, 120_000);

test('unrelated or absent judgment consent refuses both new and existing anchors without admission', async () => {
  const before = await stack.accessPool.query("SELECT count(*)::int AS count FROM access.admission WHERE action = 'projection.create'");
  for (const granted of [['work:read'], []]) {
    scopes.set(writer.token, new Set(granted));
    for (const subject of [subjects[0]!, subjects[3]!]) {
      const refused = await json<{ code: string; status: number }>(await project(writer, subject), 401);
      expect(refused).toMatchObject({ code: 'account_assertion_denied', status: 401 });
    }
  }
  expect((await stack.accessPool.query("SELECT count(*)::int AS count FROM access.admission WHERE action = 'projection.create'"))
    .rows).toEqual(before.rows);
}, 120_000);

test('discussion consent still requires Access authority for a new projection', async () => {
  scopes.set(unadmitted.token, new Set(['comment:create']));
  expect((await project(unadmitted, subjects[3]!)).status).toBe(403);
}, 120_000);
