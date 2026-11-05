import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { observeSql } from './support/sql-observer.ts';
import fenceRead from '../../src/content/read-source-fences.sql';
import { contentRoutes } from '../../src/content/routes.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { createApp } from '../../src/http/app.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { isProblemSchema, openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { definitionRoutes } from '../../src/semantic/http/definitions.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const route = 0xc120;
const subject = newId(route);
const candidate = newId(route);
const id = newId(route);
const availableId = newId(route);
const author = newId(0xc230);
const moderator = newId(0xc240);
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const body = fromPlainText('Immutable imported summary 漢字 😀');
const bytes = Buffer.from(serializeDocument(body));
const digest = createHash('sha256').update(bytes).digest('hex');
const source = {
  source: 'example',
  external_id: 'original-42',
  record_revision: '3',
  digest: 'a'.repeat(64),
  converter_revision: 'v1',
  field_group: 'summary' as const,
  references: [],
};
const rights = { license: 'CC-BY-4.0', obligations: ['cc:Attribution'], attribution: 'Original contributors' };
const home = tupleRoute(routeKey, source.source, source.external_id);
const expected = {
  id,
  subjectId: subject,
  candidateId: candidate,
  revision: 1,
  source,
  rights,
  language: 'en',
  digest,
};
let db: GrowthDatabase;
let access: Access;
let protectedAccess: Access;
let app: ReturnType<typeof contentRoutes>;
let root: ReturnType<typeof createKernel>;
let authorBearer: string;
let moderatorBearer: string;
let scopedBearer: string;
let charges = 0;

function dependencies(selected = access) {
  return {
    pool: db.pool,
    access: selected,
    routeKey,
    tokens,
    writeRate: {
      async spend() {
        charges++;
        throw new Error('Reads cannot charge writes');
      },
    },
  };
}
function mounted(selected = access) {
  const deps = dependencies(selected);
  return contentRoutes(createApp(deps) as unknown as ReturnType<typeof definitionRoutes>, deps);
}
async function get(documentId = id, bearer: string | null = null, target = app, session?: string, query = '') {
  const response = await target.handle(
    new Request(`http://kernel.test/v1/documents/${documentId}${query}`, {
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(session ? { [SESSION_HEADER]: session } : {}),
      },
    }),
  );
  return { response, body: await response.json() };
}
async function visibility(value: 'visible' | 'hidden' | 'taken_down') {
  await db.admin.query(
    'UPDATE semantic.subject SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2',
    [route, subject, value],
  );
}
async function hide(hidden: boolean) {
  if (hidden)
    await db.admin.query(
      `INSERT INTO semantic.hidden_candidate(route,subject_id,candidate_id,visibility,security_revision) VALUES ($1,$2,$3,'hidden',1)`,
      [route, subject, candidate],
    );
  else
    await db.admin.query('DELETE FROM semantic.hidden_candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3', [
      route,
      subject,
      candidate,
    ]);
  await db.admin.query(
    'UPDATE semantic.subject SET security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2',
    [route, subject],
  );
}
async function fence(takenDown: boolean) {
  if (takenDown)
    await db.admin.query(
      `INSERT INTO content.source_fences(route,source,external_id,field_group,taken_down,security_revision,taken_down_at,takedown_id)
       VALUES ($1,$2,$3,'summary',true,1,now(),gen_random_uuid())
       ON CONFLICT (route,source,external_id,field_group) DO UPDATE SET
         taken_down=true,security_revision=content.source_fences.security_revision+1,
         taken_down_at=CASE WHEN content.source_fences.taken_down THEN content.source_fences.taken_down_at ELSE now() END,
         takedown_id=CASE WHEN content.source_fences.taken_down THEN content.source_fences.takedown_id ELSE gen_random_uuid() END`,
      [home, source.source, source.external_id],
    );
  else
    await db.admin.query(
      'UPDATE content.source_fences SET taken_down=false,taken_down_at=NULL,takedown_id=NULL,security_revision=security_revision+1 WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4',
      [home, source.source, source.external_id, 'summary'],
    );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  // Every reference checkout must release before the next, including Access preparation.
  db.pool.options.max = 1;
  expect(partitionOf(home)).not.toBe(partitionOf(route));
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'document-http' };
  const issuer = 'https://auth.example.test';
  const auth = {
    issuer,
    audience: 'https://api.example.test',
    jwksUrl: `${issuer}/jwks`,
    fetch: async () => Response.json({ keys: [jwk] }),
  };
  access = createAccess({ actions: new Map([['subject:read', { anonymous: true }]]), auth });
  protectedAccess = createAccess({ actions: new Map([['subject:read', { anonymous: false }]]), auth });
  for (const account of [author, moderator])
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
      [routeOf(account), account],
    );
  async function issue(account: string, scopes: string[]) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ client_id: 'web', scope: scopes.join(' '), authn_epoch: 1, auth_time: now, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(auth.audience)
      .setSubject(account)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
  }
  authorBearer = await issue(author, []);
  moderatorBearer = await issue(moderator, []);
  scopedBearer = await issue(moderator, ['subject:read']);
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)`,
    [route, subject],
  );
  await db.admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id) VALUES ($1,$2,1,'propose',$3,$2)`,
    [route, subject, `sha256:${'a'.repeat(64)}`],
  );
  await db.admin.query(
    `INSERT INTO semantic.candidate(route,subject_id,candidate_id,slot_id,property,rank,statement,release,revision,origin) VALUES ($1,$2,$3,$3,'schema:description','normal','{}',$4,1,'proposal')`,
    [route, subject, candidate, `sha256:${'a'.repeat(64)}`],
  );
  await db.admin.query(
    `INSERT INTO content.imported_field(route,id,subject,candidate,revision,body,body_sha256,source,rights,language,availability) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,'en','available')`,
    [route, id, subject, candidate, bytes, Buffer.from(digest, 'hex'), source, rights],
  );
  await db.admin.query(
    `INSERT INTO content.imported_field(route,id,subject,candidate,revision,body,body_sha256,source,rights,language,availability)
     VALUES ($1,$2,$3,$4,2,$5,$6,$7,$8,'en','available')`,
    [route, availableId, subject, candidate, bytes, Buffer.from(digest, 'hex'), source, rights],
  );
  await fence(false);
  app = mounted();
  root = createKernel(dependencies());
});
afterAll(async () => {
  await db?.close();
});

test('top-level GET mounts once through content and createKernel, with real contracts and no write rate', async () => {
  for (const target of [app, root]) {
    expect(target.routes.filter((r) => r.method === 'GET' && r.path === '/v1/documents/:id')).toHaveLength(1);
    const document = openApiDocument(target);
    const operation = document.paths['/v1/documents/{id}']?.get;
    expect(operation?.operationId).toBe('document.get');
    expect(operation?.['x-action']).toBe('subject:read');
    expect(operation?.security).toEqual([{ bearerAuth: [] }, {}]);
    expect(operation?.['x-rate-limit']).toBeUndefined();
    for (const code of [400, 401, 404, 500, 503])
      expect(
        isProblemSchema(
          operation?.responses?.[code]?.content?.['application/problem+json']?.schema,
          document.components.schemas,
        ),
      ).toBe(true);
    expect(actionCatalogue(target).get('subject:read')?.anonymous).toBe(true);
    const result = await get(id, null, target as typeof app);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ document: { ...expected, availability: 'available', body } });
  }
  expect((await Bun.file('../../contracts/openapi.json').json()).paths['/v1/documents/{id}']).toBeDefined();
  expect(charges).toBe(0);
});

test('anonymous author and moderator use the same native public floor without grant or scope, with sessions', async () => {
  for (const bearer of [null, authorBearer, moderatorBearer]) {
    const result = await get(id, bearer);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ document: { ...expected, availability: 'available', body } });
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    const header = result.response.headers.get(SESSION_HEADER)!;
    const components = decodeSession(
      tokens,
      bearer === null ? 'anonymous' : `account:${bearer === authorBearer ? author : moderator}`,
      header,
    );
    expect(components?.map((c) => c.partition).sort()).toEqual([partitionOf(route), partitionOf(home)].sort());
    expect((await get(id, bearer, app, header)).response.status).toBe(200);
  }
  const invalid = await get(id, 'invalid.jwt.token');
  expect(invalid.response.status).toBe(401);
  expect(invalid.response.headers.get('cache-control')).toBe('private, no-store');
  expect(charges).toBe(0);
});

test('named suspension block and ban deny the public floor for both author and moderator', async () => {
  for (const [account, bearer] of [
    [author, authorBearer],
    [moderator, moderatorBearer],
  ] as const) {
    for (const reason of ['suspension', 'resource', 'realm_ban']) {
      await db.admin.query(
        `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,'subject:read',$4,'(,)',$3)`,
        [route, subject, account, reason],
      );
      try {
        expect((await get(id, bearer)).response.status).toBe(404);
        expect((await get()).response.status).toBe(200);
      } finally {
        await db.admin.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
          route,
          subject,
          account,
        ]);
      }
    }
  }
});

test('the native authenticated branch requires a real subject grant and the requested scope when the catalogue disables the floor', async () => {
  // Use the same real Access evaluator and semantic eligibility, with a protected action catalogue.
  const protectedApp = mounted(protectedAccess);
  expect((await get(id, scopedBearer, protectedApp)).response.status).toBe(404);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,'subject:read','(,)',$3)`,
    [route, subject, moderator],
  );
  try {
    expect((await get(id, moderatorBearer, protectedApp)).response.status).toBe(404);
    expect((await get(id, scopedBearer, protectedApp)).response.status).toBe(200);
  } finally {
    await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
      route,
      subject,
      moderator,
    ]);
  }
});

test('unknown invisible and fenced are identical RFC9457 404, including author and moderator', async () => {
  const unknown = await get(newId(route));
  expect(unknown.response.status).toBe(404);
  expect(unknown.body).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
  expect(unknown.response.headers.get('content-type')).toContain('application/problem+json');
  for (const conceal of [
    () => hide(true),
    () => visibility('hidden'),
    () => visibility('taken_down'),
    () => fence(true),
  ]) {
    await conceal();
    try {
      for (const bearer of [null, authorBearer, moderatorBearer]) {
        const result = await get(id, bearer);
        expect(result.response.status).toBe(404);
        expect({ ...result.body, request_id: null }).toEqual({ ...unknown.body, request_id: null });
        expect(result.response.headers.get('cache-control')).toBe('private, no-store');
      }
    } finally {
      await hide(false);
      await visibility('visible');
      await fence(false);
    }
  }
  expect({ ...(await get('head')).body, request_id: null }).toEqual({ ...unknown.body, request_id: null });
  const selected = await get(
    id,
    null,
    app,
    undefined,
    `?subjectId=${newId(route)}&candidateId=${newId(route)}&revision=999&source=unfenced`,
  );
  expect([200, 400]).toContain(selected.response.status);
  if (selected.response.status === 200) expect(selected.body.document).toMatchObject(expected);
});

test('missing semantic subject or candidate evidence fails closed on stored bindings', async () => {
  for (const [storedSubject, storedCandidate] of [
    [subject, newId(route)],
    [newId(route), candidate],
  ]) {
    const unknown = newId(route);
    await db.admin.query(
      `INSERT INTO content.imported_field(route,id,subject,candidate,revision,body,body_sha256,source,rights,language,availability)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,'en','available')`,
      [route, unknown, storedSubject, storedCandidate, bytes, Buffer.from(digest, 'hex'), source, rights],
    );
    expect((await get(unknown)).response.status).toBe(404);
  }
});

test('the final pass probes the original tuple again after preparation releases its anchor', async () => {
  const observer = observeSql(db.pool);
  const barrier = observer.hold({ statement: fenceRead.sql }, 'after');
  const pending = get();
  try {
    const execution = await barrier.entered;
    expect(execution.parameters).toEqual([
      partitionOf(home),
      JSON.stringify([{ route: home, source: source.source, external_id: source.external_id, field_group: 'summary' }]),
    ]);
    await fence(true);
    barrier.release();
    expect((await pending).response.status).toBe(404);
    expect(observer.records.filter((record) => record.statement === fenceRead.sql)).toHaveLength(2);
  } finally {
    barrier.release();
    await pending;
    await observer.close();
    await fence(false);
  }
});

test('final disclosure rereads native candidate security revision, subject, original tuple and erased availability after preparation', async () => {
  for (const change of [
    () => hide(true),
    () => visibility('taken_down'),
    () => fence(true),
    async () => {
      await db.admin.query(
        'UPDATE semantic.subject SET security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2',
        [route, subject],
      );
    },
  ]) {
    let changed = false;
    const observing: Access = {
      ...access,
      async authorize(...args) {
        const allowed = await access.authorize(...args);
        if (allowed && !changed) {
          changed = true;
          await change();
        }
        return allowed;
      },
    };
    try {
      const result = await get(id, null, mounted(observing));
      expect(changed).toBe(true);
      expect(result.response.status).toBe(404);
    } finally {
      await hide(false);
      await visibility('visible');
      await fence(false);
    }
  }
  let erased = false;
  const observing: Access = {
    ...access,
    async authorize(...args) {
      const allowed = await access.authorize(...args);
      if (allowed && !erased) {
        erased = true;
        await db.admin.query(
          "UPDATE content.imported_field SET availability='erased',body=NULL WHERE route=$1 AND id=$2",
          [route, id],
        );
      }
      return allowed;
    },
  };
  const result = await get(id, null, mounted(observing));
  expect(result.response.status).toBe(200);
  expect(result.body).toEqual({ document: { ...expected, availability: 'erased', body: null } });
});

test('exact erased references keep rights digest and identity, while the original tuple still hides tombstones after merge', async () => {
  expect((await get()).body).toEqual({ document: { ...expected, availability: 'erased', body: null } });
  // The redirect changes the semantic head, never the immutable reference or original tuple home.
  const target = newId(route).replace(/^[0-9a-f]{8}/, '00000000');
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)`,
    [route, target],
  );
  await db.admin.query(
    'INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id) VALUES ($1,$2,1,$3,$2)',
    [route, subject, target],
  );
  await fence(true);
  try {
    expect((await get()).response.status).toBe(404);
  } finally {
    await fence(false);
  }
  expect((await get()).body.document.id).toBe(id);
});

test('checkGrowth includes actual Accounts formula and constant exact document candidate and tuple probes', async () => {
  // Start every growing document, semantic and source-fence relation on its
  // representative exact-key plan, before measuring unrelated history.
  const population: Population = {
    name: 'same-partition unrelated documents candidates and tuples',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows(placement) {
      const other = newId(placement.route);
      return {
        'semantic.subject': [
          { route: placement.route, subject_id: other, type: 'schema:Book', recorded_transaction_id: other },
        ],
        'content.imported_field': [
          {
            route: placement.route,
            id: other,
            subject: other,
            candidate: other,
            revision: 1,
            body: bytes,
            body_sha256: Buffer.from(digest, 'hex'),
            source,
            rights,
            language: 'en',
            availability: 'available',
          },
        ],
        'semantic.revision': [
          {
            route: placement.route,
            subject_id: other,
            revision: 1,
            kind: 'propose',
            release: `sha256:${'a'.repeat(64)}`,
            recorded_transaction_id: other,
          },
        ],
        'semantic.candidate': [
          {
            route: placement.route,
            subject_id: other,
            candidate_id: other,
            slot_id: other,
            property: 'schema:description',
            rank: 'normal',
            statement: {},
            release: `sha256:${'a'.repeat(64)}`,
            revision: 1,
            origin: 'proposal',
          },
        ],
        'content.source_fences': [
          {
            route: (partitionOf(home) << 4) | (placement.route & 15),
            source: 'example',
            external_id: other,
            field_group: 'summary',
            taken_down: true,
            security_revision: 1,
          },
        ],
      };
    },
  };
  await seed(db, population, { from: 0, to: 2048 });
  const report = await checkGrowth(db, {
    name: 'Native imported document HTTP disclosure',
    rule: 'series',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
    },
    async operation() {
      const result = await get(availableId, authorBearer);
      expect(result.response.status).toBe(200);
      expect(result.body.document).toEqual({
        ...expected,
        id: availableId,
        revision: 2,
        availability: 'available',
        body,
      });
    },
  });
  expect(report.samples).toHaveLength(3);
  expect(report.samples.every((sample) => sample.cost.statements > 0 && sample.cost.blocks > 0)).toBe(true);
});
