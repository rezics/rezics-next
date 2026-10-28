import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { setupContent } from '../../src/content/setup.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let driver: SemanticOutcomeDriver;
let db: GrowthDatabase;
let configuration: Parameters<typeof createKernel>[0];
const key = () => ({ 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) });
function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
}
async function subject(label: string) {
  const response = await driver.request(
    'editor',
    'POST',
    '/v1/subjects',
    {
      type: 'schema:Book',
      labels: { en: label },
    },
    key(),
  );
  status(response, 201);
  return (response.body.subject as { id: string }).id;
}

beforeAll(async () => {
  driver = await createSemanticDriver((config) => {
    configuration = config;
    return createKernel(config);
  });
  db = await openGrowthDatabase(driver.fixtures.runtime.databaseUrl);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await driver?.close();
});

test('an active account without any subject grant sets and clears a reaction on a readable subject after content setup', async () => {
  const person = await driver.fixtures.person('ordinary-reactor');
  const id = await subject('Ordinary account reaction');
  const grants = await db.admin.query(
    `SELECT 1 FROM access.resource_grant WHERE subject_id=$1 AND (resource_id=$2 OR action='reaction:set')`,
    [person.accountId, id],
  );
  expect(grants.rows).toEqual([]);
  const path = `/v1/subjects/${id}/reaction`;
  for (const kind of ['like', 'love']) {
    const changed = await driver.fixtures.send(person, 'PUT', path, { kind }, key());
    status(changed, 200);
    expect(changed.body).toEqual({ kind });
    const own = await driver.fixtures.send(person, 'GET', path);
    status(own, 200);
    expect(own.body).toEqual({ kind });
  }
  const cleared = await driver.fixtures.send(person, 'DELETE', path, undefined, key());
  status(cleared, 204);
  const own = await driver.fixtures.send(person, 'GET', path);
  status(own, 200);
  expect(own.body).toEqual({ kind: null });
});

test('a suspended account, an anonymous request and an unreadable subject are still refused', async () => {
  const id = await subject('Reaction admission and disclosure');
  const path = `/v1/subjects/${id}/reaction`;
  status(await driver.request('suspended', 'PUT', path, { kind: 'like' }, key()), 401);
  status(await driver.request('anonymous', 'PUT', path, { kind: 'like' }, key()), 401);
  const governor = await driver.fixtures.person('governor');
  status(await driver.fixtures.send(governor, 'POST', `/v1/subjects/${id}:hide`, { reason: 'spam' }, key()), 200);
  const person = await driver.fixtures.person('ordinary-reactor');
  for (const target of [id, newId(0x4231)]) {
    const hidden = `/v1/subjects/${target}/reaction`;
    status(await driver.fixtures.send(person, 'PUT', hidden, { kind: 'like' }, key()), 404);
    status(await driver.fixtures.send(person, 'DELETE', hidden, undefined, key()), 404);
  }
});

test('content setup installs the reaction standing once across restarts', async () => {
  async function installed() {
    const markers = await db.admin.query(
      `SELECT * FROM access.standing_parent_installation
       WHERE route=0 AND resource_id=$1 AND actions=ARRAY['reaction:set']::text[]`,
      [GLOBAL_CONTEXT],
    );
    const grants = await db.admin.query(
      `SELECT * FROM access.resource_grant
       WHERE route=0 AND resource_id=$1 AND subject_kind='active_accounts'
         AND subject_id='00000000-0000-0000-0000-000000000000' AND subject_role='' AND action='reaction:set'`,
      [GLOBAL_CONTEXT],
    );
    expect(markers.rows).toHaveLength(1);
    expect(grants.rows).toHaveLength(1);
    return { markers: markers.rows, grants: grants.rows };
  }
  const initial = await installed();
  await setupContent(driver.fixtures.pool);
  await setupContent(driver.fixtures.pool);
  expect(await installed()).toEqual(initial);
});

test("a subject reaction's Global standing probe stays within its bound as Global grants to other accounts grow", async () => {
  const person = await driver.fixtures.person('growth-reactor');
  const id = await subject('Global reaction standing growth');
  // Keep the driver's real Auth and HTTP composition, replacing only the pool with the instrumented one.
  const kernel = createKernel({ ...configuration, pool: db.pool });
  const report = await checkGrowth(db, {
    name: 'Subject reaction Global standing',
    rule: 'series',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      // These decoys never grant the measured actor anything.
      const others = Array.from({ length: scale - previous }, () => newId(0x7131));
      await database.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
         SELECT 0,$1,id,'reaction:set','(,)',id FROM unnest($2::uuid[]) AS id`,
        [GLOBAL_CONTEXT, others],
      );
    },
    async operation(_database, _scale, repetition) {
      const kind = repetition % 2 ? 'like' : 'love';
      const response = await kernel.handle(
        new Request(`http://kernel.test/v1/subjects/${id}/reaction`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${person.bearer}`,
            'content-type': 'application/json',
            ...key(),
          },
          body: JSON.stringify({ kind }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ kind });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
}, 120_000);
