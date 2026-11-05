import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

let driver: SemanticOutcomeDriver;
const key = () => ({ 'Idempotency-Key': JSON.stringify(randomUUID()) });
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
beforeAll(async () => {
  driver = await createSemanticDriver();
}, 180_000);
afterAll(async () => {
  await driver?.close();
}, 180_000);

for (const property of ['schema:inLanguage', 'schema:author'] as const) {
  test(`Context decisions use the latest subject revision for an older compacted ${property} candidate`, async () => {
    const person = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Person',
        labels: { en: 'Compact candidate author' },
      },
      key(),
    );
    expect(person.status).toBe(201);
    const author = person.body.subject as { id: string };
    const made = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Sequential compact Context decisions' },
        statements: {
          'schema:datePublished': [
            statement('schema:datePublished', {
              time: '+2010-02-23T00:00:00Z',
              precision: 11,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            }),
          ],
          [property]: [statement(property, property === 'schema:author' ? author.id : 'ja')],
        },
      },
      key(),
    );
    expect(made.status).toBe(201);
    const subject = made.body.subject as { id: string; revision: number; statements: Record<string, { id: string }[]> };
    expect(subject.revision).toBe(1);
    const first = subject.statements['schema:datePublished']![0]!.id;
    const second = subject.statements[property]![0]!.id;
    const contextResponse = await driver.request(
      'editor',
      'POST',
      '/v1/contexts',
      {
        labels: { en: 'Independent editorial decisions' },
      },
      key(),
    );
    expect(contextResponse.status).toBe(201);
    const context = (contextResponse.body.context as { id: string }).id;
    await driver.grant('acceptor', ['context:accept'], context);
    const accepted = await driver.request(
      'acceptor',
      'POST',
      `/v1/subjects/${subject.id}/candidates/${first}:accept`,
      {
        context,
        expected_head: null,
      },
      key(),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.revision).toBe(2);
    const compact = await driver.fixtures.pool.query(
      'SELECT candidate_id FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(subject.id), subject.id, second],
    );
    expect(compact.rows).toEqual([]);
    const requestKey = key();
    const path = `/v1/subjects/${subject.id}/candidates/${second}:reject`;
    const body = { context, expected_head: null };
    const rejected = await driver.request('acceptor', 'POST', path, body, requestKey);
    expect(rejected.status).toBe(200);
    expect(rejected.body).toEqual({
      acceptance: { context, candidate: second, decision: 'reject', head: 1 },
      revision: 3,
    });
    const revisions = await driver.inspect.revisions(subject.id);
    expect(revisions.map((row) => row.revision)).toEqual([1, 2, 3]);
    expect(new Set(revisions.map((row) => row.transactionId)).size).toBe(3);
    const replayed = await driver.request('acceptor', 'POST', path, body, requestKey);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(rejected.body);
    expect(await driver.inspect.revisions(subject.id)).toEqual(revisions);
  }, 180_000);
}
