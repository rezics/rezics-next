import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest, validateRelease, type Release } from '@rezics/definitions';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { HttpResponse, Persona, Subject } from '../../../../specs/semantic-driver.ts';
import { routeOf } from '../../src/route/route.ts';
import { admitWikidataValue } from '../../src/semantic/wikidata-value-admission.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
const julian = 'http://www.wikidata.org/entity/Q1985786';
const schema = `id: https://example.org/wikidata-fidelity
name: wikidata_fidelity
version: '1'
prefixes:
  linkml: https://w3id.org/linkml/
  ex: https://example.org/wikidata-fidelity/
imports: [linkml:types, rezics]
classes:
  Sample:
    is_a: Thing
    class_uri: ex:Sample
    slots: [timeValue, quantityValue]
slots:
  timeValue:
    slot_uri: ex:time
    range: date
    annotations:
      datatype: time
      qualifiers: quantityValue
  quantityValue:
    slot_uri: ex:quantity
    range: decimal
    annotations:
      datatype: quantity
      units: '*'
`;
const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const citation = { parts: [snak('schema:url', 'https://www.wikidata.org/wiki/Special:EntityData/Q42.json')] };
const time = {
  time: '-0044-03-15T00:00:00Z',
  precision: 11,
  calendarmodel: julian,
  timezone: -300,
  before: 1,
  after: 2,
};
const quantity = {
  amount: '+9007199254740993.0001000001',
  lowerBound: '+9007199254740992.0001000001',
  upperBound: '+9007199254740994.0001000001',
  unit: 'http://www.wikidata.org/entity/Q11574',
};
const statement = {
  ...snak('ex:time', time),
  qualifiers: [snak('ex:quantity', quantity)],
  references: [{ parts: [...citation.parts, snak('ex:quantity', quantity)] }],
};
let driver: SemanticOutcomeDriver;
let release: Release;
let digest: string;
const write = (persona: Persona, path: string, body: unknown, headers = key()) =>
  driver.request(persona, 'POST', path, body, headers);
const get = (path: string) => driver.request('anonymous', 'GET', path);
function subject(response: HttpResponse): Subject {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.subject as Subject;
}

beforeAll(async () => {
  driver = await createSemanticDriver();
  const compiled = await driver.compile('wikidata.yaml', { 'wikidata.yaml': schema }, {
    en: { types: { 'ex:Sample': 'Wikidata value sample' }, properties: { 'ex:time': 'time', 'ex:quantity': 'quantity' } },
  });
  release = compiled.release as unknown as Release;
  digest = compiled.digest;
  expect(validateRelease(release)).toEqual([]);
  const active = await get('/v1/definitions/active');
  expect(active.status).toBe(200);
  expect(digest).not.toBe(bundledDigest);
  expect((await write('steward', '/v1/definitions/releases', { release })).status).toBe(201);
  expect(
    (await write('steward', `/v1/definitions/releases/${digest}:activate`, { expected_head: active.body.head })).status,
  ).toBe(200);
  await driver.grant('steward', ['subject:create', 'statement:propose'], driver.globalContext);
});

afterAll(async () => {
  await driver?.close();
}, 180_000);

test('Wikidata adapter distinguishes missing, unknown, none and typed unsupported forms', () => {
  const timeProperty = release.properties['ex:time']!;
  expect(admitWikidataValue(undefined, timeProperty)).toEqual({ state: 'unsupported', reason: 'missing' });
  expect(admitWikidataValue({ snaktype: 'somevalue' }, timeProperty)).toEqual({
    state: 'admitted',
    value: { type: 'somevalue' },
  });
  expect(admitWikidataValue({ snaktype: 'novalue' }, timeProperty)).toEqual({
    state: 'admitted',
    value: { type: 'novalue' },
  });
  expect(admitWikidataValue({ type: 'time', value: time }, timeProperty)).toEqual({
    state: 'admitted',
    datatype: 'time',
    value: { type: 'value', content: time },
  });
  expect(admitWikidataValue({
    snaktype: 'value',
    datatype: 'quantity',
    datavalue: { type: 'quantity', value: quantity },
  }, release.properties['ex:quantity']!)).toEqual({
    state: 'admitted',
    datatype: 'quantity',
    value: { type: 'value', content: quantity },
  });
  expect(admitWikidataValue({ type: 'globe-coordinate', value: {} }, timeProperty)).toEqual({
    state: 'unsupported',
    reason: 'unsupported-datatype',
  });
  expect(admitWikidataValue({ type: 'time', value: { ...time, calendarmodel: 'https://example.org/calendar' } }, timeProperty))
    .toEqual({ state: 'unsupported', reason: 'unsupported-calendar' });
  expect(admitWikidataValue({ type: 'time', value: { ...time, precision: 12 } }, timeProperty)).toEqual({
    state: 'unsupported',
    reason: 'unsupported-precision',
  });
  expect(admitWikidataValue({ type: 'quantity', value: { amount: '+1', unit: `https://units.example/${'x'.repeat(1_048_576)}` } }, release.properties['ex:quantity']!)).toEqual({
    state: 'unsupported',
    reason: 'invalid-value',
  });
});

test('native proposal, reference, acceptance, adoption, revision detail and public read retain exact time and quantity values', async () => {
  const created = await write('steward', '/v1/subjects', {
    type: 'ex:Sample',
    labels: { en: 'Exact Wikidata value' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const holder = created.body.subject as Subject;
  expect(routeOf(holder.id)).not.toBeNull();
  expect(holder.release).toBe(digest);
  const path = `/v1/subjects/${holder.id}/candidates`;
  const proposed = await write('steward', path, { statement });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const proposedRevision = proposed.body.revision as number;
  expect(candidate).toEqual(expect.any(String));
  const accepted = await write('acceptor', `${path}/${candidate}:accept`, {
    context: driver.globalContext,
    expected_head: null,
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const adopted = await write('acceptor', `/v1/subjects/${holder.id}:adopt`, {
    context: driver.globalContext,
    property: 'ex:time',
    mode: 'replace',
    selection: [{ candidate, rank: 'preferred' }],
    expected_head: null,
  });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
  const current = subject(await get(`/v1/subjects/${holder.id}`));
  const selected = current.statements['ex:time']![0]!;
  expect(selected).toMatchObject({
    id: candidate,
    rank: 'preferred',
    value: { type: 'value', content: time },
    qualifiers: [{ property: { id: 'ex:quantity' }, value: { type: 'value', content: quantity } }],
    references: [{ parts: expect.arrayContaining([
      { property: { id: 'ex:quantity', data_type: 'quantity' }, value: { type: 'value', content: quantity } },
    ]) }],
    rezics: { release: digest },
  });
  const proposalDetail = await get(`/v1/subjects/${holder.id}/revisions/${proposedRevision}`);
  expect(proposalDetail.status).toBe(200);
  expect(proposalDetail.body.change).toMatchObject({ kind: 'candidate', candidate, property: 'ex:time' });
  const adoptionDetail = await get(`/v1/subjects/${holder.id}/revisions/${adopted.body.revision}`);
  expect(adoptionDetail.status).toBe(200);
  expect(adoptionDetail.body.change).toMatchObject({
    kind: 'adoption',
    property: 'ex:time',
    selection: [{ candidate, rank: 'preferred' }],
  });
  const stored = await driver.fixtures.pool.query<{ body: { value: unknown } }>(
    "SELECT body FROM semantic.fact WHERE route=$1 AND subject_id=$2 AND property='ex:time' AND kind='statement'",
    [routeOf(holder.id), holder.id],
  );
  expect(stored.rows.map((row) => row.body.value)).toEqual([{ type: 'value', content: time }]);
  expect(releaseDigest(release)).toBe(digest);
});
