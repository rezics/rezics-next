import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { seedRelationLexicon, type SeedLexiconClient } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { systemDisclosure } from '../../../services/main/src/modules/target/disclosed-references.ts';
import { FRAME_READ_COST } from '../../../services/main/src/modules/projection/frame-read.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';

const short = (ref: string) => ref.slice(-36);
const id = () => `https://rezics.com/id/${randomUUID()}`;
type Member = Awaited<ReturnType<MediaStack['member']>>;
type Page = { profile: string; work: string; items: { key: string; iri: string;
  label: { value: string; language: string } }[]; nextCursor: string | null };
let stack: MediaStack, owner: Member, outsider: Member, work: string, empty: string, subject: string;
let definition: { component: string; revision: string };

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}
async function semantic(name: string, publicWork?: string, type = `${RV}NarrativeContinuity`) {
  const result = await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'resource', types: [type], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `中文 ${name}`, language: 'zh' } },
      ...(publicWork ? [{ predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: publicWork } }] : []),
    ] },
  }), 201);
  await owner.grant(`semantic:read:${result.component}`, 'semantic.read');
  return result.component;
}
async function join(on: string, continuity: string) {
  return json<{ occurrence: string; revision: string }>(await owner.send('POST', '/v1/relations/changes', {
    profile: 'relation-change-v1', expectedHead: null, definition: definition.revision, participations: [
      { role: 'work', participant: { kind: 'resource', ref: on } },
      { role: 'continuity', participant: { kind: 'resource', ref: continuity } },
    ], actingSubject: owner.actor,
  }), 201);
}
const path = (on: string, extra = '') => `/v1/resources/${short(on)}/continuities${extra}`;

beforeAll(async () => {
  stack = await startMediaStack('work-continuities');
  owner = await stack.member('continuity-owner'); outsider = await stack.member('continuity-reader');
  work = (await stack.publicWork(owner.actor)).work; empty = (await stack.publicWork(owner.actor)).work;
  for (const [scope, action] of [['semantic:create:root', 'semantic.change'], ['relation:create:root', 'relation.change'],
    [`work:read:${work}`, 'work.read'], [`work:read:${empty}`, 'work.read'],
    [`work:edit:${work}`, 'work.edit'], [`work:edit:${empty}`, 'work.edit']] as const) await owner.grant(scope, action);
  subject = await semantic('Continuity subject', work, `${RV}Character`);
  const existing = await readDefinitionByKey(stack.env, 'in-continuity', systemDisclosure);
  const client: SeedLexiconClient = {
    post: async <T>(route: string, body: object, key: string) => json<T>(await owner.send('POST', route, body, key), 201),
    authorizeDefinition: async value => {
      await owner.grant(`semantic:read:${value.component}`, 'semantic.read');
      await owner.grant(`semantic:edit:${value.component}`, 'lexicon.presentation.change');
    },
  };
  definition = existing ? { component: existing.definition, revision: existing.revision }
    : (await seedRelationLexicon(client, owner.actor, randomUUID(), relationLexiconSeed.filter(item => item.key === 'in-continuity')))[0]!;
  await owner.grant(`semantic:read:${definition.component}`, 'semantic.read');
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('Work continuities disclose stable identities and localized labels, deduplicate memberships and paginate by key', async () => {
  const first = await semantic('Same label', work), second = await semantic('Same label', work);
  const hidden = await semantic('Private continuity');
  await join(work, first); await join(work, first); await join(work, second); await join(work, hidden);
  const result = await json<Page>(await outsider.read(path(work)));
  expect(result).toMatchObject({ profile: 'work-continuities-v1', work, nextCursor: null });
  expect(result.items.map(item => item.iri).sort()).toEqual([first, second].sort());
  expect(result.items.every(item => item.key === item.iri && item.label.value === 'Same label')).toBe(true);
  expect(JSON.stringify(result)).not.toContain(hidden);
  const translated = await json<Page>(await outsider.read(path(work, '?languages=zh')));
  expect(translated.items.every(item => item.label.language === 'zh' && item.label.value === '中文 Same label')).toBe(true);
  const page = await json<Page>(await outsider.read(path(work, '?limit=1')));
  expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeString();
  const next = await json<Page>(await outsider.read(path(work, `?limit=1&cursor=${page.nextCursor}`)));
  expect(next.items).toHaveLength(1); expect(next.items[0]!.key).not.toBe(page.items[0]!.key);
  if (next.nextCursor) expect((await json<Page>(await outsider.read(path(work, `?limit=1&cursor=${next.nextCursor}`)))).items).toEqual([]);
  expect((await outsider.read(path(empty, `?limit=1&cursor=${page.nextCursor}`))).status).toBe(400);
  expect((await owner.read(path(work, `?limit=1&cursor=${page.nextCursor}`))).status).toBe(400);
  expect((await outsider.read(path(work, `?limit=2&cursor=${page.nextCursor}`))).status).toBe(400);
  expect((await outsider.read(path(work, '?limit=65'))).status).toBe(400);
  expect((await json<Page>(await outsider.read(path(empty)))).items).toEqual([]);
  expect((await outsider.read(path(id()))).status).toBe(404);
  const privateWork = await stack.privateWork(owner.actor);
  expect((await outsider.read(path(privateWork.work))).status).toBe(404);
  expect((await outsider.read(path(subject))).status).toBe(400);
  expect((await stack.call('GET', path(work))).status).toBe(200);
}, 120_000);

test('membership disclosure follows the reading position and continuations stay bound to it', async () => {
  const on = (await stack.publicWork(owner.actor)).work;
  for (const [scope, action] of [[`work:read:${on}`, 'work.read'], [`work:edit:${on}`, 'work.edit']] as const) {
    await owner.grant(scope, action);
  }
  const continuity = await semantic('Revealed continuity', work);
  const membership = await join(on, continuity);
  const store = new ReadingPositionStore(stack.contentPool);
  // The extremes do not consult chapter order: start withholds every revelation, all reveals them.
  await store.publish({ record: membership.occurrence, recordKind: 'relation', continuityWork: on,
    occurrence: id(), receipt: randomUUID() });
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, media: stack.media,
    mediaAccess: stack.mediaAccess, readingPositions: store, account: { verify: async () => outsider.principal } });
  const read = (position: string, cursor?: string) => app.handle(new Request(`http://main.local${path(on)}?limit=1`
    + `&actingSubject=${encodeURIComponent(outsider.actor)}&position=${position}${cursor ? `&cursor=${cursor}` : ''}`,
  { headers: { authorization: `Bearer ${outsider.token}` } }));
  expect((await json<Page>(await read('start'))).items).toEqual([]);
  const all = await json<Page>(await read('all'));
  expect(all.items.map(item => item.iri)).toEqual([continuity]);
  expect(all.nextCursor).toBeString();
  expect((await read('start', all.nextCursor!)).status).toBe(400);
}, 120_000);

test('retired memberships do not establish continuity and a changed graph invalidates continuation', async () => {
  const continuity = await semantic('Retained continuity', work);
  const membership = await join(empty, continuity);
  const before = await json<Page>(await outsider.read(path(empty, '?limit=1')));
  expect(before.items.map(item => item.iri)).toEqual([continuity]);
  const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(membership.occurrence)} rv:occurrenceHead ?head } }`)).results!.bindings;
  await json(await owner.send('POST', '/v1/relations/changes', {
    profile: 'relation-change-v1', occurrence: membership.occurrence, expectedHead: rows[0]!.head!.value,
    definition: definition.revision, lifecycle: 'retired', participations: [
      { role: 'work', participant: { kind: 'resource', ref: empty } },
      { role: 'continuity', participant: { kind: 'resource', ref: continuity } },
    ], actingSubject: owner.actor,
  }));
  expect((await json<Page>(await outsider.read(path(empty)))).items).toEqual([]);
  expect((await outsider.read(path(empty, `?limit=1&cursor=${before.nextCursor}`))).status).toBe(409);
}, 120_000);

test('more hidden memberships than the scan budget return a bounded frame subset and an inventory continuation', async () => {
  const crowded = (await stack.publicWork(owner.actor)).work;
  await owner.grant(`work:read:${crowded}`, 'work.read');
  await owner.grant(`work:edit:${crowded}`, 'work.edit');
  // IDs put the hidden continuity before the visible one, so every scan batch is hidden on the first request.
  const hidden = await semantic('Crowded private continuity');
  const visible = await semantic('Crowded visible continuity', work);
  const [lower, upper] = [hidden, visible].sort();
  const privateRef = lower!, publicRef = upper!;
  // Swap disclosure bindings if random identities put the public resource first.
  await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(privateRef)} rv:semanticWork ${iri(work)} } } INSERT { GRAPH ${iri(GRAPHS.current)} {
    ${iri(publicRef)} rv:semanticWork ${iri(work)} } } WHERE { }`);
  const privateMembership = await join(crowded, privateRef);
  const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(privateMembership.occurrence)} rv:occurrenceHead ?head } }`)).results!.bindings[0]!.head!.value;
  // A duplicated immutable membership head isolates scan exhaustion without hundreds of unrelated admission writes.
  const count = FRAME_READ_COST.membershipBatch * FRAME_READ_COST.membershipScans + 1;
  await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
    ${Array.from({ length: count }, () => `${iri(id())} a rv:RelationOccurrence ; rv:occurrenceHead ${iri(head)} .`).join('\n')}
  } }`);
  await join(crowded, publicRef);
  const query = stack.fuseki.query.bind(stack.fuseki);
  let scans = 0;
  stack.fuseki.query = async (sparql, maximum) => {
    if (sparql.includes('SELECT DISTINCT ?work ?continuity ?occurrence')) scans++;
    return query(sparql, maximum);
  };
  try {
    const framed = await outsider.read(`/v1/resources/${short(subject)}/statements?frame=${encodeURIComponent(crowded)}`);
    expect(framed.status).toBe(200); await framed.text();
    expect(scans).toBe(FRAME_READ_COST.membershipScans);
    scans = 0;
    const page = await json<Page>(await outsider.read(path(crowded)));
    expect(page.items).toEqual([]); expect(page.nextCursor).toBeString();
    expect(scans).toBe(FRAME_READ_COST.membershipScans);
    expect(page.nextCursor).not.toContain(privateRef);
    const next = await json<Page>(await outsider.read(path(crowded, `?cursor=${page.nextCursor}`)));
    expect(next.items.map(item => item.iri)).toEqual([publicRef]);
    expect(next.nextCursor).toBeNull();
  } finally { stack.fuseki.query = query; }
}, 120_000);
