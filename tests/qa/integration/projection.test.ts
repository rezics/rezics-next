import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { SEMANTIC_TERMS } from '../../../services/main/src/modules/semantic/schema.ts';
import { capabilityBases, type Capability } from '../../../services/main/src/modules/target/contract.ts';
import { resolveCommandTarget, resolveTargets, targetRead, TargetNotBound }
  from '../../../services/main/src/modules/target/resolve.ts';
import { projectionKey } from '../../../services/main/src/modules/projection/schema.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

const ID = 'https://rezics.com/id/';
const RV = 'https://rezics.com/vocab/';
const id = () => `${ID}${randomUUID()}`;
const local = (ref: string) => ref.slice(ID.length);
type Member = Awaited<ReturnType<MediaStack['member']>>;
interface View { id: string; subject: string; frames: string[]; revision: string; disclosure: 'public' | 'restricted' }
interface Write { projection: View; created: boolean; replayed: boolean }
interface Page { items: View[]; nextCursor: string | null; sourcePosition: { dataEpoch: string; sequence: string } }
interface Problem { code: string; status: number }

let stack: MediaStack;
let owner: Member, outsider: Member;
let work: { work: string; title: string };
const resources: Record<string, string> = {};

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
const problem = async (response: Response, status: number): Promise<Problem> => {
  const body = await json<Problem>(response, status);
  expect(body.status).toBe(status);
  return body;
};

/** A semantic Resource; linking it to a public Work is what makes it public. */
async function semantic(name: string, type: string, works: readonly string[] = [work.work]) {
  const response = await owner.send('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null,
    actingSubject: owner.actor, state: { component: 'resource', types: [type], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
      ...works.map(ref => ({ predicate: SEMANTIC_TERMS.semanticWork, value: { kind: 'resource', ref } }))] } });
  return (await json<{ component: string }>(response, 201)).component;
}
const project = (member: Member, subject: string, frames: readonly string[], key = `projection-${randomUUID()}`) =>
  member.send('POST', '/v1/projections', { subject, frames, actingSubject: member.actor }, key);
const create = async (member: Member, subject: string, frames: readonly string[]) =>
  (await json<Write>(await project(member, subject, frames), 201)).projection;
const query = (member: Member | null, subject: string, frames: readonly string[] = [], extra = '') => {
  const search = new URLSearchParams({ subject });
  for (const frame of frames) search.append('frame', frame);
  const path = `/v1/projections?${search}${extra}`;
  return member ? member.read(path) : stack.call('GET', path);
};
const projectionRows = async (subject: string) => (await stack.fuseki.query(`PREFIX rv: <${RV}>
  SELECT ?p WHERE { GRAPH ${iri(GRAPHS.current)} { ?p a rv:Projection ; rv:projectionOf ${iri(subject)} } }`))
  .results!.bindings.map(row => row.p!.value);
const member = async (name: string) => {
  const created = await stack.member(name);
  await created.grant('projection:create:root', 'projection.create');
  return created;
};

beforeAll(async () => {
  stack = await startMediaStack('projection', { library: true, agents: true });
  stack.access.configureBaseline(stack.fuseki);
  owner = await member('projection-owner');
  outsider = await member('projection-outsider');
  work = await stack.publicWork(owner.actor);
  await owner.grant('semantic:create:root', 'semantic.change');
  await owner.grant(`work:read:${work.work}`, 'work.read');
  Object.assign(resources, {
    misaka: await semantic('Misaka', `${RV}Character`),
    canon: await semantic('Canon', `${RV}NarrativeContinuity`),
    legends: await semantic('Legends', `${RV}NarrativeContinuity`),
    battle: await semantic('The Daihasei Festival', 'https://schema.org/Event'),
    unit: await semantic('Misaka unit', `${RV}GameUnit`),
    // Unlinked to any public Work: readable only through an explicit grant.
    secret: await semantic('Secret continuity', `${RV}NarrativeContinuity`, []),
    secretSubject: await semantic('Secret character', `${RV}Character`, []),
  });
  await owner.grant(`semantic:read:${resources.secret}`, 'semantic.read');
  await owner.grant(`semantic:read:${resources.secretSubject}`, 'semantic.read');
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('concurrent first use by many principals yields one identity: one admission commits, the rest adopt it', async () => {
  const subject = resources.misaka!;
  const frames = [work.work, resources.canon!];
  const members = [owner, outsider, ...await Promise.all(Array.from({ length: 6 }, (_, index) => member(`racer-${index}`)))];
  // Different principals, different keys and different frame orders, all at once.
  const keys = members.map((_, index) => `racer-${index}-${randomUUID()}`);
  const results = await Promise.all(members.map((racer, index) =>
    project(racer, subject, index % 2 ? [...frames].reverse() : frames, keys[index])));
  const writes = await Promise.all(results.map(response => response.status < 300 ? response.json() as Promise<Write>
    : response.text().then(text => { throw new Error(`${response.status}: ${text}`); })));
  const ids = new Set(writes.map(write => write.projection.id));
  expect(ids.size).toBe(1);
  const projection = [...ids][0]!;
  expect(writes.filter(write => write.created)).toHaveLength(1);
  expect(await projectionRows(subject)).toEqual([projection]);
  expect(writes[0]!.projection).toMatchObject({ subject, frames: [...frames].sort(), disclosure: 'public' });
  const identities = await stack.accessPool.query(
    'SELECT projection, frames FROM access.projection_identity WHERE subject = $1', [subject]);
  expect(identities.rows).toEqual([{ projection: local(projection), frames: [...frames].sort() }]);
  // Every admission is sealed; exactly the one that created the Resource succeeded, the others were no-ops.
  const admissions = await stack.accessPool.query(`SELECT graph_outcome, count(*)::int AS count FROM access.admission
    WHERE action = 'projection.create' AND acting_subject = ANY($1) AND state = 'sealed' GROUP BY graph_outcome`,
  [members.map(racer => racer.actor)]);
  const outcomes = Object.fromEntries(admissions.rows.map(row => [row.graph_outcome, row.count]));
  expect(outcomes.succeeded).toBe(1);
  expect((outcomes.succeeded ?? 0) + (outcomes.cancelled ?? 0)).toBeGreaterThan(0);
  // A retry with the same key answers as before: the creator's replays its receipt, an adopter's adopts again.
  for (const [index, racer] of members.entries()) {
    const replay = await json<Write>(await project(racer, subject, frames, keys[index]), 200);
    expect(replay).toMatchObject({ created: writes[index]!.created, replayed: writes[index]!.created,
      projection: { id: projection } });
  }
  const reused = await project(members[0]!, subject, [work.work, resources.legends!], keys[0]);
  expect((await problem(reused, 409)).code).toBe('idempotency_conflict');
  // A later request with a new key, in any frame order, is a read: it names the same identity and writes nothing.
  const before = await stack.accessPool.query('SELECT count(*)::int AS count FROM access.admission WHERE action = $1',
    ['projection.create']);
  const again = await json<Write>(await project(outsider, subject, [...frames].reverse()), 200);
  expect(again).toMatchObject({ created: false, projection: { id: projection } });
  expect((await stack.accessPool.query('SELECT count(*)::int AS count FROM access.admission WHERE action = $1',
    ['projection.create'])).rows[0].count).toBe(before.rows[0].count);
}, 120_000);

test('a lookup finds the projection without creating one, and a subject lists its projections by page', async () => {
  const subject = resources.misaka!;
  const known = (await json<Page>(await query(null, subject, [resources.canon!, work.work]))).items;
  expect(known).toHaveLength(1);
  // Frames are an exact set: a subset or a different frame is not it, and nothing is created by asking.
  expect((await json<Page>(await query(null, subject, [work.work]))).items).toEqual([]);
  expect((await json<Page>(await query(null, subject, [resources.legends!, work.work]))).items).toEqual([]);
  expect(await projectionRows(subject)).toHaveLength(1);
  const second = await create(owner, subject, [resources.legends!]);
  const third = await create(owner, subject, [resources.battle!]);
  const first = await json<Page>(await query(null, subject, [], '&limit=2'));
  expect(first.items.map(item => item.id)).toEqual([known[0]!.id, second.id]);
  expect(first.nextCursor).toBe(local(second.id));
  const rest = await json<Page>(await query(null, subject, [], `&limit=2&cursor=${first.nextCursor}`));
  expect(rest).toMatchObject({ items: [{ id: third.id }], nextCursor: null });
  expect(rest.sourcePosition.sequence).toMatch(/^[0-9]+$/);
  // Another subject has none, and the unit is a Resource like any other.
  expect((await json<Page>(await query(null, resources.unit!))).items).toEqual([]);
  expect((await query(null, subject, [], '&limit=21')).status).toBe(400);
  expect((await query(null, subject, [work.work], `&cursor=${local(second.id)}`)).status).toBe(400);
}, 120_000);

test('every validation refusal is typed, and an unreadable Resource is refused like a missing one', async () => {
  const subject = resources.misaka!;
  const refused = async (response: Response, status: number, code: string) =>
    expect(await problem(response, status)).toMatchObject({ code });
  const projectionId = (await json<Page>(await query(null, subject, [], '&limit=1'))).items[0]!.id;
  // Cardinality: one to eight frames, no duplicates, never the subject itself.
  await refused(await project(owner, subject, []), 400, 'invalid_request');
  await refused(await project(owner, subject, Array.from({ length: 9 }, id)), 400, 'invalid_request');
  await refused(await project(owner, subject, [work.work, work.work]), 400, 'invalid_projection');
  await refused(await project(owner, subject, [subject]), 400, 'invalid_projection');
  await refused(await owner.send('POST', '/v1/projections', { subject: 'https://example.com/x', frames: [work.work],
    actingSubject: owner.actor }), 400, 'invalid_request');
  await refused(await owner.send('POST', '/v1/projections', { subject, frames: [work.work], actingSubject: owner.actor }, ''), 400,
    'invalid_idempotency_key');
  // The subject is readable and not a Projection.
  await refused(await project(owner, projectionId, [resources.canon!]), 422, 'projection_of_projection');
  const missing = await problem(await project(owner, id(), [resources.canon!]), 404);
  expect(missing.code).toBe('projection_subject_unavailable');
  const unreadable = await problem(await project(outsider, resources.secretSubject!, [resources.canon!]), 404);
  expect(unreadable).toEqual(missing);
  // Each frame resolves through the target resolver to a grain or type that has a dimension.
  await refused(await project(owner, subject, [resources.unit!]), 422, 'projection_frame_not_coordinate');
  await refused(await project(owner, subject, [resources.secretSubject!]), 422, 'projection_frame_not_coordinate');
  await refused(await project(owner, subject, [projectionId]), 422, 'projection_frame_not_coordinate');
  await owner.grant('space:create:root', 'space.create');
  const space = await json<{ realm: string }>(await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
    name: 'Frames', capabilities: ['realm'], actingSubject: owner.actor }), 201);
  await refused(await project(owner, subject, [space.realm]), 422, 'projection_frame_not_coordinate');
  // At most one frame per dimension: two continuities, two Works.
  await refused(await project(owner, subject, [resources.canon!, resources.legends!]), 422, 'projection_frame_dimension_repeated');
  const otherWork = await stack.publicWork(owner.actor);
  await refused(await project(owner, subject, [work.work, otherWork.work]), 422, 'projection_frame_dimension_repeated');
  const absentFrame = await problem(await project(owner, subject, [id()]), 404);
  expect(absentFrame.code).toBe('projection_frame_unavailable');
  const unreadableFrame = await problem(await project(outsider, subject, [resources.secret!]), 404);
  expect(unreadableFrame).toEqual(absentFrame);
  // Authority: an Agent with no creation grant is not admitted, however readable its subject and frames.
  const unadmitted = await stack.member('unadmitted');
  expect((await project(unadmitted, subject, [resources.legends!, work.work])).status).toBe(403);
  // Reading an existing projection needs no authority to create one.
  expect((await project(unadmitted, subject, [resources.battle!])).status).toBe(200);
  // Nothing refused was created.
  expect(await projectionRows(subject)).toHaveLength(3);
  for (const frame of [resources.unit!, resources.secret!]) {
    expect((await json<Page>(await query(owner, subject, [frame]))).items).toEqual([]);
  }
}, 120_000);

test('disclosure is the most restrictive of the subject and frames; a private frame hides the projection', async () => {
  const subject = resources.misaka!;
  const hidden = await create(owner, subject, [resources.secret!, work.work]);
  expect(hidden).toMatchObject({ disclosure: 'restricted', frames: [resources.secret!, work.work].sort() });
  expect(await create(owner, resources.secretSubject!, [resources.canon!])).toMatchObject({ disclosure: 'restricted' });
  const open = (await json<Page>(await query(null, subject, [work.work, resources.canon!]))).items[0]!;
  expect(open.disclosure).toBe('public');
  // A reader who can read the whole set sees it; everyone else sees what they could have created, and no more.
  expect((await json<Page>(await query(owner, subject, [resources.secret!, work.work]))).items).toEqual([hidden]);
  for (const reader of [null, outsider]) {
    expect((await json<Page>(await query(reader, subject, [resources.secret!, work.work]))).items).toEqual([]);
    const listed = (await json<Page>(await query(reader, subject))).items.map(item => item.id);
    expect(listed).not.toContain(hidden.id);
    expect(listed).toContain(open.id);
  }
  expect((await project(outsider, subject, [resources.secret!, work.work])).status).toBe(404);
  expect((await json<Page>(await query(owner, subject))).items.map(item => item.id)).toContain(hidden.id);
  // The Resource summary applies the same rule and returns the subject and each frame as parts, never a joined label.
  const summary = async (reader: Member | null, projection: string) => reader
    ? reader.read(`/v1/resources/${local(projection)}`) : stack.call('GET', `/v1/resources/${local(projection)}`);
  const seen = await json<{ type: string; base: string; disclosure: string; name: { value: string };
    parts: { subject: { reference: string; name: { value: string } }; frames: { reference: string; type: string; name: { value: string } }[] } }>(
    await summary(owner, hidden.id));
  expect(seen).toMatchObject({ type: 'projection', base: 'projection', disclosure: 'restricted', name: { value: 'Misaka' },
    parts: { subject: { reference: subject, name: { value: 'Misaka' } } } });
  expect(seen.parts.frames.map(frame => frame.reference)).toEqual([resources.secret!, work.work].sort());
  expect(seen.parts.frames.map(frame => frame.name.value).sort()).toEqual([work.title, 'Secret continuity'].sort());
  expect(JSON.stringify(seen)).not.toContain('Misaka Secret');
  expect((await summary(outsider, hidden.id)).status).toBe(404);
  expect((await summary(null, hidden.id)).status).toBe(404);
  const visible = await json<{ disclosure: string; parts: { frames: unknown[] } }>(await summary(null, open.id));
  expect(visible).toMatchObject({ disclosure: 'public', parts: { frames: [{}, {}] } });
  // Reading a private frame is the only thing that gates it: granting it later opens the projection to that reader.
  await outsider.grant(`semantic:read:${resources.secret!}`, 'semantic.read');
  expect((await json<Page>(await query(outsider, subject, [resources.secret!, work.work]))).items).toEqual([hidden]);
}, 120_000);

test('target resolution reports base projection with the report, review, rating, discussion, collection and suitability capabilities', async () => {
  const subject = resources.misaka!;
  const projection = (await json<Page>(await query(null, subject, [work.work, resources.canon!]))).items[0]!;
  const admitted: Capability[] = ['report', 'review', 'rating', 'discussion', 'collection-member', 'suitability'];
  const refused: Capability[] = ['library-status', 'progress', 'continuity', 'spoiler-boundary', 'session'];
  for (const capability of admitted) expect(capabilityBases[capability]).toContain('projection' as never);
  for (const capability of refused) expect(capabilityBases[capability]).not.toContain('projection' as never);
  const reader = { access: stack.access, principal: owner.principal, actingSubject: owner.actor,
    readers: { mediaAccess: stack.mediaAccess } };
  await targetRead(stack.env, reader, async session => {
    for (const capability of admitted) {
      const [target] = await resolveTargets(session, [projection.id], capability);
      expect(target, capability).toEqual({ resource: projection.id, base: 'projection', types: [`${RV}Projection`],
        work: null, revision: projection.revision, disclosure: 'public' });
    }
    for (const capability of refused) {
      await expect(resolveTargets(session, [projection.id], capability), capability).rejects.toBeInstanceOf(TargetNotBound);
    }
    expect(await resolveCommandTarget(session, projection.id)).toEqual({ resource: projection.id, base: 'projection',
      types: [`${RV}Projection`], work: null, revision: projection.revision, disclosure: 'restricted' });
    // A Resource keeps its own grain: the subject is not made a projection by having them.
    expect((await resolveCommandTarget(session, subject)).base).toBe('resource');
  });
  // The public page resolves it through the discussion capability, as an entity of its own base with no sections yet.
  expect(await json(await stack.call('GET', `/v1/resources/${local(projection.id)}/page`))).toMatchObject({
    target: { base: 'projection' }, sections: [] });
}, 120_000);

test('an identity reserved by a lost command is adopted by the next caller, and the key row stays append-only', async () => {
  const subject = resources.misaka!;
  const frames = [resources.battle!, work.work];
  const key = projectionKey(subject, frames);
  // The reservation committed in Access but its graph command never ran.
  const admission = await stack.access.register({ principal: owner.principal, actingSubject: owner.actor,
    scope: 'projection:create:root', action: 'projection.create', idempotencyKey: `lost-${randomUUID()}`,
    requestDigest: 'a'.repeat(64) });
  const reserved = await stack.accessPool.query(`INSERT INTO access.projection_identity (key, projection, subject, frames, admission_id)
    VALUES ($1, $2, $3, $4, $5) RETURNING projection`, [key.key, randomUUID(), subject, key.frames, admission.id]);
  const lost = `${ID}${reserved.rows[0].projection}`;
  expect((await json<Page>(await query(null, subject, frames))).items).toEqual([]);
  const adopted = await json<Write>(await project(outsider, subject, frames), 201);
  expect(adopted.projection.id).toBe(lost);
  expect(adopted.created).toBe(true);
  expect(await json<Page>(await query(null, subject, frames))).toMatchObject({ items: [{ id: lost }] });
  // The identity table never changes and never names another set under a key.
  const rows = (sql: string, params: unknown[]) => stack.accessPool.query(sql, params);
  await expect(rows('DELETE FROM access.projection_identity WHERE key = $1', [key.key])).rejects.toThrow('append-only');
  await expect(rows('UPDATE access.projection_identity SET projection = $2 WHERE key = $1', [key.key, randomUUID()]))
    .rejects.toThrow('append-only');
  const insert = (keyValue: string, subjectValue: string, framesValue: string[]) => rows(
    `INSERT INTO access.projection_identity (key, projection, subject, frames, admission_id) VALUES ($1,$2,$3,$4,$5)`,
    [keyValue, randomUUID(), subjectValue, framesValue, admission.id]);
  await expect(insert('b'.repeat(64), subject, frames)).rejects.toThrow('projection_identity_key');
  const selfKey = createHash('sha256').update(`${subject}\n${[subject, work.work].join('\n')}`).digest('hex');
  await expect(insert(selfKey, subject, [subject, work.work])).rejects.toThrow();
  await expect(insert(key.key, subject, key.frames)).rejects.toThrow('duplicate key');
}, 120_000);

test('graph round trips for a lookup, a list page and an existing get-or-create do not grow with the projections that exist', async () => {
  const subject = await semantic('Counted subject', `${RV}Character`);
  const events = await Promise.all(Array.from({ length: 6 }, (_, index) => semantic(`Counted event ${index}`, 'https://schema.org/Event')));
  const graphQueries = async (run: () => Promise<Response>) => {
    const before = stack.fuseki.queries;
    await (await run()).text();
    return stack.fuseki.queries - before;
  };
  const measure = async () => ({ list: await graphQueries(() => query(owner, subject)),
    lookup: await graphQueries(() => query(owner, subject, [events[0]!])),
    existing: await graphQueries(() => project(owner, subject, [events[0]!])) });
  await create(owner, subject, [events[0]!]);
  const alone = await measure();
  for (const event of events.slice(1)) await create(owner, subject, [event]);
  expect((await json<Page>(await query(owner, subject))).items).toHaveLength(6);
  // Six projections list through seven parts instead of two, yet cost the same graph probes: one summary page,
  // one page of parts and one head query, whatever the number of projections, ratings or Statements around them.
  expect(await measure()).toEqual(alone);
  expect(alone.list).toBeLessThanOrEqual(12);
  expect(alone.lookup).toBeLessThanOrEqual(16);
  expect(alone.existing).toBeLessThanOrEqual(alone.lookup + 12);
}, 120_000);

test('any signed-in Person creates a projection on baseline authority, with no grant of its own', async () => {
  const reader = await stack.member('baseline-person');
  const person = await json<{ agent: string }>(await reader.send('POST', '/v1/agents', { profile: 'agent-provision-v1',
    kind: 'person', displayName: 'Baseline reader' }), 201);
  const frames = [resources.legends!, work.work];
  const response = await reader.send('POST', '/v1/projections', { subject: resources.misaka!, frames, actingSubject: person.agent });
  const written = await json<Write>(response, 201);
  expect(written).toMatchObject({ created: true, projection: { subject: resources.misaka!, disclosure: 'public' } });
  // The proof is the pinned baseline policy, not a row someone granted.
  const proofs = await stack.accessPool.query(`SELECT b.policy_id FROM access.admission a
    JOIN access.baseline_admission b ON b.admission_id = a.id
    WHERE a.acting_subject = $1 AND a.action = 'projection.create' AND a.scope_id = 'projection:create:root'`, [person.agent]);
  expect(proofs.rows).toEqual([{ policy_id: 'baseline-member-v1' }]);
  expect((await stack.accessPool.query(`SELECT count(*)::int AS count FROM access.permission_grant
    WHERE recipient_subject = $1 AND action = 'projection.create'`, [person.agent])).rows[0].count).toBe(0);
  expect((await json<Page>(await query(null, resources.misaka!, frames))).items).toEqual([written.projection]);
  // An Agent that is not a provisioned Person has no baseline.
  const plain = await stack.member('baseline-plain');
  expect((await project(plain, resources.misaka!, [resources.legends!, resources.battle!])).status).toBe(403);
}, 120_000);
