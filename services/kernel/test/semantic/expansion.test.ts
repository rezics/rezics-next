import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bundledSources } from '@rezics/definitions/bundled';
import { CatalogueError, compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest, validateRelease, type Release } from '@rezics/definitions';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT, readRelease } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { VERTICAL_LOCALES, verticalManifests, verticalProfile } from '../support/manifests.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const ACTIONS = [
  'definitions:publish',
  'definitions:activate',
  'definitions:read',
  'subject:create',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'subject:read',
];
const auth = {
  issuer: 'https://auth.example.test',
  audience: 'https://api.rezics.test',
  jwksUrl: 'https://auth.example.test/jwks',
};
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const routeKey = new Uint8Array(32).fill(4);
const writeRate = {
  async spend() {
    return { allowed: true as const };
  },
};
const key = () => `"${randomUUID()}"`;
const compiled = new Map<number, Promise<Release>>();

function sourcesFor(count: number): {
  root: string;
  schemas: Record<string, string>;
  presentation: Record<string, string>;
  contexts: ReturnType<typeof bundledSources>['contexts'];
} {
  const bundled = bundledSources();
  const extra = verticalManifests(count);
  const imports = Array.from({ length: count }, (_, index) => `  - v${index}`).join('\n');
  return {
    root: bundled.root,
    schemas: {
      ...bundled.schemas,
      ...extra.schemas,
      'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n${imports}\n`,
    },
    presentation: { ...bundled.presentation, ...extra.presentation },
    contexts: bundled.contexts,
  };
}

function compiledRelease(count: number): Promise<Release> {
  let pending = compiled.get(count);
  if (!pending) {
    pending = compileCatalogue(sourcesFor(count));
    compiled.set(count, pending);
  }
  return pending;
}

function unsupportedSources() {
  const sources = sourcesFor(1);
  const file = verticalProfile(0).schema;
  const schema = sources.schemas[file]!.replace(
    '    class_uri: ex:V0Agent\n',
    '    class_uri: ex:V0Agent\n    rules:\n      - description: never run\n',
  ).replace(
    '  v0Cast:\n    slot_uri: ex:v0Cast\n',
    '  v0Cast:\n    slot_uri: ex:v0Cast\n    equals_expression: "{x}"\n',
  );
  return { ...sources, schemas: { ...sources.schemas, [file]: schema } };
}

async function editorToken(
  accountId: string,
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'],
  kid: string,
) {
  return new SignJWT({
    client_id: 'web',
    scope: ACTIONS.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
    .setIssuer(auth.issuer)
    .setAudience(auth.audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function grantEditor(admin: pg.Pool, accountId: string) {
  await admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(accountId), accountId],
  );
  for (const action of ACTIONS) {
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,$3,'(,)',$2)`,
      [GLOBAL_CONTEXT, accountId, action],
    );
  }
}

function kernelFor(pool: pg.Pool, jwk: Record<string, unknown>): Kernel {
  return createKernel({
    pool,
    access: (config: AccessConfig) =>
      createAccess({ ...config, auth: { ...auth, fetch: async () => Response.json({ keys: [jwk] }) } }),
    tokens,
    routeKey,
    writeRate,
  });
}

async function handle(
  kernel: Kernel,
  method: string,
  path: string,
  token: string,
  options: { key?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

function requireStatus(step: string, answer: { response: Response; body: Record<string, any> }, status: number) {
  if (answer.response.status !== status) {
    throw new Error(`${step} returned ${answer.response.status}: ${JSON.stringify(answer.body)}`);
  }
  return answer.body;
}

const REFERENCE = {
  parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/expansion' } }],
};

async function serveVertical(kernel: Kernel, token: string, personId: string) {
  const profile = verticalProfile(0);
  const created = await handle(kernel, 'POST', '/v1/subjects', token, {
    key: key(),
    body: { type: profile.agent, labels: { en: 'Expansion agent' } },
  });
  const subject = requireStatus('create', created, 201).subject;
  const proposed = await handle(kernel, 'POST', `/v1/subjects/${subject.id}/candidates`, token, {
    key: key(),
    body: {
      statement: {
        property: { id: profile.cast },
        value: { type: 'value', content: personId },
        references: [REFERENCE],
      },
    },
  });
  const candidate = requireStatus('propose', proposed, 201).candidate as string;
  const accepted = await handle(kernel, 'POST', `/v1/subjects/${subject.id}/candidates/${candidate}:accept`, token, {
    key: key(),
    body: { context: GLOBAL_CONTEXT, expected_head: null },
  });
  requireStatus('accept', accepted, 200);
  const adopted = await handle(kernel, 'POST', `/v1/subjects/${subject.id}:adopt`, token, {
    key: key(),
    body: {
      context: GLOBAL_CONTEXT,
      property: profile.cast,
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    },
  });
  requireStatus('adopt', adopted, 200);
  const shown = await handle(kernel, 'GET', `/v1/subjects/${subject.id}`, token);
  requireStatus('read', shown, 200);
  const listed = await handle(
    kernel,
    'GET',
    `/v1/subjects/${subject.id}/candidates?property=${encodeURIComponent(profile.cast)}`,
    token,
  );
  requireStatus('list', listed, 200);
  return { profile, subject, candidate, shown: shown.body, listed: listed.body };
}

const CATALOGUE = {
  relations: `SELECT n.nspname AS schema, c.relname AS relation, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname NOT IN ('public', 'dbos')
    ORDER BY 1, 2, 3`,
  columns: `SELECT n.nspname AS schema, c.relname AS relation, a.attname AS column,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, a.attnum AS position
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname NOT IN ('public', 'dbos')
    ORDER BY 1, 2, a.attnum`,
  indexes: `SELECT n.nspname AS schema, tbl.relname AS relation, idx.relname AS index, pg_get_indexdef(idx.oid) AS definition
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = tbl.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname NOT IN ('public', 'dbos')
    ORDER BY 1, 2, 3`,
};

async function databaseSchema(admin: pg.Pool) {
  const [relations, columns, indexes] = await Promise.all([
    admin.query(CATALOGUE.relations),
    admin.query(CATALOGUE.columns),
    admin.query(CATALOGUE.indexes),
  ]);
  return { relations: relations.rows, columns: columns.rows, indexes: indexes.rows };
}

const serviceAccount = '019a1b2c-3d4e-7f00-8a00-e0a0510a0001';
const servicePool = createPool(databaseUrl);
const serviceAdmin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
let serviceKernel: Kernel;
let serviceToken = '';

beforeAll(async () => {
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'expansion', alg: 'ES256' };
  serviceToken = await editorToken(serviceAccount, signing.privateKey, 'expansion');
  await grantEditor(serviceAdmin, serviceAccount);
  serviceKernel = kernelFor(servicePool, jwk);
});
afterAll(async () => {
  await servicePool.end();
  await serviceAdmin.end();
});

test('a vertical added as files only is served end to end with no change to the API contract or the database schema', async () => {
  const profile = verticalProfile(0);
  const release = await compiledRelease(1);
  let refused: unknown;
  try {
    await compileCatalogue(unsupportedSources());
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(CatalogueError);
  const violations = (refused as CatalogueError).violations;
  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: profile.schema,
        pointer: '/classes/V0Agent/rules',
        code: 'unsupported',
      }),
      expect.objectContaining({
        file: profile.schema,
        pointer: '/slots/v0Cast/equals_expression',
        code: 'unsupported',
      }),
    ]),
  );

  const contract = JSON.stringify(openApiDocument(serviceKernel));
  const schemaBefore = await databaseSchema(serviceAdmin);
  const published = await handle(serviceKernel, 'POST', '/v1/definitions/releases', serviceToken, {
    key: key(),
    body: { release },
  });
  const digest = requireStatus('publish', published, 201).digest as string;
  expect(digest).toBe(releaseDigest(release));
  const active = await handle(serviceKernel, 'GET', '/v1/definitions/active', serviceToken);
  const expectedHead = active.response.status === 404 ? null : requireStatus('active', active, 200).head;
  const activated = await handle(serviceKernel, 'POST', `/v1/definitions/releases/${digest}:activate`, serviceToken, {
    key: key(),
    body: { expected_head: expectedHead },
  });
  requireStatus('activate', activated, 200);
  expect(JSON.stringify(openApiDocument(serviceKernel))).toBe(contract);
  expect(await databaseSchema(serviceAdmin)).toEqual(schemaBefore);

  const person = requireStatus(
    'person',
    await handle(serviceKernel, 'POST', '/v1/subjects', serviceToken, {
      key: key(),
      body: { type: 'schema:Person', labels: { en: 'Ada Lovelace' } },
    }),
    201,
  ).subject;
  const served = await serveVertical(serviceKernel, serviceToken, person.id);
  expect(served.subject.type).toBe(profile.agent);
  const statement = served.shown.subject.statements[profile.cast][0];
  expect(statement.value.content).toBe(person.id);
  expect(statement.rank).toBe('normal');
  expect(served.shown.related[person.id]).toEqual({ labels: { en: 'Ada Lovelace' } });
  expect(served.shown.related[profile.cast].labels.en).toBe(`en ${profile.cast}`);
  expect(served.listed.candidates).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: served.candidate, decision: 'accepted', rank: 'normal' })]),
  );
});

const growthAccount = '019a1b2c-3d4e-7f00-8a00-e0a0510a0002';
let growth: GrowthDatabase;
let growthKernel: Kernel;
let growthToken = '';
let growthPerson = '';

beforeAll(async () => {
  growth = await openGrowthDatabase(databaseUrl);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'expansion-growth', alg: 'ES256' };
  growthToken = await editorToken(growthAccount, signing.privateKey, 'expansion-growth');
  await grantEditor(growth.admin, growthAccount);
  growthKernel = kernelFor(growth.pool, jwk);
});
afterAll(async () => {
  if (growth) await growth.close();
});

test('subject commands and reads stay within budget at 10 and at 100 vertical manifests', async () => {
  const profile = verticalProfile(0);
  const report = await checkGrowth(growth, {
    name: 'subject commands and reads stay within budget at 10 and at 100 vertical manifests',
    scales: [1, 10, 100],
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async (database, scale) => {
      const release = await compiledRelease(scale);
      const digest = releaseDigest(release);
      const published = await handle(growthKernel, 'POST', '/v1/definitions/releases', growthToken, {
        key: key(),
        body: { release },
      });
      if (published.response.status !== 201 && published.response.status !== 200)
        requireStatus('publish', published, 201);
      if (published.body.digest !== digest) throw new Error(`publish stored ${published.body.digest}`);
      const active = await handle(growthKernel, 'GET', '/v1/definitions/active', growthToken);
      const expectedHead = active.response.status === 404 ? null : requireStatus('active', active, 200).head;
      const activated = await handle(growthKernel, 'POST', `/v1/definitions/releases/${digest}:activate`, growthToken, {
        key: key(),
        body: { expected_head: expectedHead },
      });
      requireStatus('activate', activated, 200);
      const warmed = await readRelease(database.pool, digest);
      if (!warmed) throw new Error('Activated release was not readable');
      if (!growthPerson) {
        growthPerson = requireStatus(
          'person',
          await handle(growthKernel, 'POST', '/v1/subjects', growthToken, {
            key: key(),
            body: { type: 'schema:Person', labels: { en: 'Growth person' } },
          }),
          201,
        ).subject.id;
      }
    },
    operation: async () => {
      const served = await serveVertical(growthKernel, growthToken, growthPerson);
      if (served.shown.subject.type !== profile.agent) throw new Error('Read returned the wrong type');
      if (served.shown.related[profile.cast]?.labels?.en !== `en ${profile.cast}`)
        throw new Error('Related property label missing');
      if (served.shown.related[growthPerson]?.labels?.en !== 'Growth person')
        throw new Error('Related subject label missing');
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 10, 100]);
}, 300_000);

test('a release holding 100 vertical manifests at the launch grain fits the release limits', async () => {
  const release = await compiledRelease(100);
  expect(validateRelease(release)).toEqual([]);
  const catalogue = await compileCatalogue(bundledSources());
  expect(Object.keys(release.types)).toHaveLength(Object.keys(catalogue.types).length + 300);
  expect(Object.keys(release.properties)).toHaveLength(Object.keys(catalogue.properties).length + 1_200);
  const profile = verticalProfile(0);
  const agent = release.types[profile.agent]!;
  const work = release.types[verticalProfile(99).work]!;
  expect(Object.keys(agent.labels).sort()).toEqual([...VERTICAL_LOCALES].sort());
  expect(agent.bases).not.toContain('schema:CreativeWork');
  expect(work.bases).toContain('schema:CreativeWork');
  expect(agent.facets).toEqual([profile.cast, profile.published, profile.count]);
  expect(agent.properties.filter((id) => id.startsWith('ex:v0')).sort()).toEqual([...profile.properties].sort());
  expect(agent.properties.some((id) => /^ex:v[1-9]/.test(id))).toBe(false);
}, 180_000);
