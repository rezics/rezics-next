import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { createStatementProperty, type StatementProperty } from './statement-property.ts';
import { GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { framePattern } from '../../../services/main/src/modules/projection/frame-read.ts';
import { READ_PREFIX } from '../../../services/main/src/modules/work/read-session.ts';

const RV = 'https://rezics.com/vocab/';
const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (ref: string) => ref.slice(-36);
type Member = Awaited<ReturnType<MediaStack['member']>>;
let stack: MediaStack, owner: Member, writer: Member, work: string, subject: string;
let fact: StatementProperty;

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}
async function semantic(name: string, type: string, publicWork?: string) {
  const saved = await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'resource', types: [type], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
      ...(publicWork ? [{ predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: publicWork } }] : []),
    ] },
  }), 201);
  await owner.grant(`semantic:read:${saved.component}`, 'semantic.read');
  return saved.component;
}
const write = (member: Member, on: string, applicability: string[], key = randomUUID()) => member.send('POST', '/v1/statements', {
  profile: 'statement-v1', speaker: { kind: 'personal' }, subject: on, predicate: fact.predicate,
  relationDefinition: fact.relationDefinition, value: { kind: 'literal', lexical: key,
    datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null },
  applicability, interpretation: { kind: 'selected' }, evidence: [], actingSubject: member.actor,
}, key);

beforeAll(async () => {
  stack = await startMediaStack('statement-disclosure');
  owner = await stack.member('coordinate-owner'); writer = await stack.member('coordinate-writer');
  work = (await stack.publicWork(owner.actor)).work;
  await owner.grant('semantic:create:root', 'semantic.change');
  fact = await createStatementProperty(owner.send.bind(owner), owner.actor);
  for (const member of [owner, writer]) await member.grant(`semantic:read:${fact.predicate}`, 'semantic.read');
  await owner.grant('projection:create:root', 'projection.create');
  await owner.grant(`work:read:${work}`, 'work.read');
  for (const member of [owner, writer]) await member.grant(`statement:speak:${member.actor}`, 'statement.record');
  subject = await semantic('Public subject', `${RV}Character`, work);
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('a writer cannot distinguish hidden coordinate, projection and non-coordinate types from unknown applicability or store them', async () => {
  const hidden = await semantic('Private continuity', `${RV}NarrativeContinuity`);
  const event = await semantic('Private event', 'https://schema.org/Event');
  const character = await semantic('Private subject', `${RV}Character`);
  const projection = (await json<{ projection: { id: string } }>(await owner.send('POST', '/v1/projections',
    { subject, frames: [hidden], actingSubject: owner.actor }), 201)).projection.id;
  const unknown = await json(await write(writer, subject, [id()]), 422);
  expect(unknown).toMatchObject({ code: 'statement_applicability_unknown' });
  for (const reference of [hidden, event, character, projection]) {
    const key = randomUUID();
    expect(await json(await write(writer, subject, [reference], key), 422)).toEqual(unknown);
    expect((await stack.fuseki.query(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      ASK { GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rdf:object ${lit(key)} } }`)).boolean).toBe(false);
  }
  // An authorized coordinate is accepted by the same typing path.
  await writer.grant(`semantic:read:${hidden}`, 'semantic.read');
  await json(await write(writer, subject, [hidden]), 201);
  expect((await writer.read(`/v1/resources/${short(hidden)}`)).status).toBe(200);
}, 120_000);

test('a projection Statement rejects an applicability slot belonging to a different Work', async () => {
  const other = (await stack.publicWork(owner.actor)).work;
  await owner.grant(`work:read:${other}`, 'work.read');
  await owner.grant(`work:edit:${other}`, 'work.edit');
  const projection = (await json<{ projection: { id: string } }>(await owner.send('POST', '/v1/projections',
    { subject, frames: [work], actingSubject: owner.actor }), 201)).projection.id;
  const realization = id();
  await json(await owner.send('PUT', `/v1/works/${short(other)}/realizations/${short(realization)}`, {
    profile: 'realization-v1', expectedHead: null, actingSubject: owner.actor, id: realization,
    language: 'en', kind: 'translation', translators: [owner.actor], publishers: [owner.actor],
    source: { kind: 'unresolved', work: other }, status: 'official', verification: 'verified', evidence: id(),
  }));
  expect(await json(await write(owner, projection, [realization]), 422))
    .toMatchObject({ code: 'statement_applicability_work_mismatch' });
  // A plain subject may deliberately name alternatives from several Works.
  await json(await write(owner, subject, [work, realization]), 201);
}, 120_000);

test('coverage uses OR within structure and edition slots, AND between slots, and scores each slot once', async () => {
  const position = id(), foreignPosition = id(), release = id(), realization = id(), foreignWork = id();
  const inputs = [[work, foreignPosition], [work, position], [release, realization],
    [work, foreignPosition, release, realization], [foreignWork, foreignPosition]];
  const statements = inputs.map(() => id());
  await stack.fuseki.update(`${READ_PREFIX} INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
    ${iri(foreignWork)} a schema:CreativeWork . ${iri(position)} a schema:ListItem .
    ${iri(foreignPosition)} a schema:ListItem . ${iri(release)} a rv:Release . ${iri(realization)} a rv:Realization .
    ${inputs.map((applicability, index) => `${iri(statements[index]!)} a rdf:Statement ;
      ${applicability.map(reference => `rv:applicability ${iri(reference)}`).join(' ; ')} .`).join('\n')}
  } }`);
  const frames = [{ iri: position, dimension: 'position' as const, work },
    { iri: release, dimension: 'release' as const, work }];
  const coverage = framePattern(frames, '?statement', GRAPHS.current);
  const rows = (await stack.fuseki.query(`${READ_PREFIX} SELECT ?statement ?score WHERE {
    VALUES ?statement { ${statements.map(iri).join(' ')} }
    ${coverage.filter} BIND((${coverage.score}) AS ?score)
  }`)).results!.bindings;
  expect(Object.fromEntries(rows.map(row => [row.statement!.value, Number(row.score!.value)])))
    .toEqual({ [statements[0]!]: 16, [statements[1]!]: 17, [statements[2]!]: 17, [statements[3]!]: 33 });
}, 120_000);
