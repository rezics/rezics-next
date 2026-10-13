import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import type { VerifiedAccountAssertion } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { setFixtureMandateState } from '../../../services/main/src/modules/access/fixture-authority-scenario.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type Page = {
  items: { relation: string; counterparts: { reference: string }[] }[];
  next: string | null;
  sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
};
const short = (ref: string) => ref.slice(-36);
let stack: MediaStack, owner: Member, reader: Member;
let app: ReturnType<typeof createMainApp>;
let hub: string, other: string, hidden: string;
let definition: string;
const relations: string[] = [], hiddenRelations: string[] = [];
let expiry = Math.floor(Date.now() / 1000) + 300;
let country: string | null = null;

async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}
function read(on = hub, fields: Record<string, string> = {}, person: Member | null = reader) {
  const query = new URLSearchParams({ limit: '1', languages: 'en', position: 'all',
    ...(person ? { actingSubject: person.actor } : {}), ...fields });
  return app.handle(new Request(`http://main.local/v1/resources/${short(on)}/relations?${query}`, {
    headers: person ? { authorization: `Bearer ${person.token}` } : {},
  }));
}
async function relate(target: string) {
  const result = await json<{ occurrence: string }>(owner.send('POST', '/v1/relations/changes', {
    profile: 'relation-change-v1', expectedHead: null, definition, actingSubject: owner.actor,
    participations: [
      { role: 'source', participant: { kind: 'resource', ref: hub } },
      { role: 'target', participant: { kind: 'resource', ref: target } },
    ],
    evidence: `https://example.test/original-relation/${randomUUID()}`,
  }), 201);
  await reader.grant(`semantic:read:${result.occurrence}`, 'semantic.read');
  return result.occurrence;
}

beforeAll(async () => {
  stack = await startMediaStack('relation-viewer-continuation');
  owner = await stack.member('relation-owner');
  reader = await stack.member('relation-reader');
  hub = (await stack.publicWork(owner.actor)).work;
  other = (await stack.publicWork(owner.actor)).work;
  hidden = (await stack.privateWork(owner.actor)).work;
  for (const work of [hub, other, hidden]) {
    await owner.grant(`work:read:${work}`, 'work.read');
    await owner.grant(`work:edit:${work}`, 'work.edit');
  }
  await owner.grant('semantic:create:root', 'semantic.change');
  await owner.grant('relation:create:root', 'relation.change');
  const meaning = await json<{ component: string; revision: string }>(owner.send('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'definition', kind: 'relation', workSubjectRole: 'target',
      notation: `continuation-counterpart-${randomUUID()}`,
      roles: ['source', 'target'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) },
  }), 201);
  definition = meaning.revision;
  await owner.grant(`semantic:read:${meaning.component}`, 'semantic.read');
  await reader.grant(`semantic:read:${meaning.component}`, 'semantic.read');
  await reader.grant(`work:read:${hidden}`, 'work.read');
  for (const target of [other, other, hidden, hidden]) {
    const relation = await relate(target);
    relations.push(relation);
    if (target === hidden) hiddenRelations.push(relation);
  }
  // Account transport metadata can be large and renew between requests. This
  // owner regression keeps real access, traversal and disclosure implementations.
  app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
    media: stack.media, mediaAccess: stack.mediaAccess,
    account: { verify: async request => {
      const person = request.headers.get('authorization') === `Bearer ${owner.token}` ? owner : reader;
      const principal: VerifiedAccountAssertion = { ...person.principal,
        accountExpiresAt: ++expiry,
        accountScopes: Array.from({ length: 200 }, (_, index) => `fixture-scope:${index}`).concat('work:read'),
        contentEvidence: { age: 'adult', country, accountEligible: true, adultAvailable: true,
          nsfwDisplay: 'mask', categories: { general: true, r15: false, r18: false, r18g: false } } };
      return principal;
    } },
  });
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('same effective reader resumes a bounded cursor across Account renewal without losing or repeating relations', async () => {
  let page = await json<Page>(read());
  const position = page.sourcePosition;
  const seen = page.items.map(item => item.relation);
  let pages = 1;
  while (page.next) {
    expect(page.next.length).toBeLessThanOrEqual(2048);
    expect(++pages).toBeLessThanOrEqual(relations.length + 1);
    page = await json<Page>(read(hub, { after: page.next }));
    expect(page.sourcePosition).toEqual(position);
    seen.push(...page.items.map(item => item.relation));
  }
  expect(seen).toEqual(relations.toSorted());
}, 120_000);

test('continuation refuses another resource, effective query, principal, Agent or disclosure preference', async () => {
  const first = await json<Page>(read());
  expect(first.next).toBeString();
  const after = first.next!;
  for (const fields of [{ limit: '2' }, { languages: 'zh' }, { position: 'start' },
    { actingSubject: owner.actor }]) {
    await json(read(hub, { after, ...fields }), 400);
  }
  await json(read(other, { after }), 400);
  await json(read(hub, { after }, owner), 400);
  await json(read(hub, { after }, null), 400);
  country = 'JP';
  try { await json(read(hub, { after }), 400); }
  finally { country = null; }
}, 120_000);

test('a cursor retains its source position but never retains revoked private participant authority', async () => {
  const before = await json<Page>(read(hub, { limit: '32' }));
  expect(before.items.map(item => item.relation)).toEqual(relations.toSorted());
  expect(before.items.some(item => item.counterparts.some(ref => ref.reference === hidden))).toBe(true);
  const first = await json<Page>(read());
  expect(first.next).toBeString();
  const mandate = (await stack.accessPool.query<{ id: string }>(`SELECT id FROM access.representation
    WHERE principal_id=$1 AND represented_subject=$2 AND action='work.read' AND active`,
  [reader.principalId, reader.actor])).rows[0]!;
  await setFixtureMandateState(stack.accessPool, mandate.id, 'revoked');
  const seen: string[] = [];
  let after = first.next;
  for (let count = 0; after; count++) {
    expect(count).toBeLessThan(relations.length);
    const page = await json<Page>(read(hub, { after }));
    expect(page.sourcePosition).toEqual(first.sourcePosition);
    expect(JSON.stringify(page)).not.toContain(hidden);
    expect(page.items.every(item => !hiddenRelations.includes(item.relation))).toBe(true);
    seen.push(...page.items.map(item => item.relation));
    after = page.next;
  }
  expect(seen).toEqual(relations.toSorted().filter(ref => ref > first.items[0]!.relation && !hiddenRelations.includes(ref)));
  const current = await json<Page>(read(hub, { limit: '32' }));
  expect(current.items.map(item => item.relation)).toEqual(relations.toSorted().filter(ref => !hiddenRelations.includes(ref)));
  expect(JSON.stringify(current)).not.toContain(hidden);
  const privateAnswer = await json(read(hidden), 404);
  expect(privateAnswer).toEqual(await json(read(`https://rezics.com/id/${randomUUID()}`), 404));
}, 120_000);

test('a relation graph change refuses the old source position', async () => {
  const first = await json<Page>(read());
  expect(first.next).toBeString();
  await relate(other);
  await json(read(hub, { after: first.next! }), 409);
}, 120_000);
