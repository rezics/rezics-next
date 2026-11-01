import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  buildCatalogue,
  catalogueBytes,
  catalogueDigest,
  compatibilityKind,
  parseCatalogueJson,
  releaseDigest,
  validateRelease,
  CATALOGUE_FORMAT,
  CATALOGUE_NODE_FORMAT,
  KIND_FORMAT,
  KIND_REDUCTION,
  type Release,
  type KindCataloguePin,
} from '@rezics/definitions';
import { compileCatalogue } from '@rezics/definitions/compile';
import { createKernel } from '../../src/http/kernel.ts';
import { createPool } from '../../src/database/pool.ts';
import { createRealAccess } from './real-access.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

async function shard(index: number): Promise<Release> {
  const classes: Record<string, object> = {},
    labels: Record<string, string> = {};
  for (let offset = 0; offset < 384; offset++) {
    const name = `T${String(index * 384 + offset).padStart(4, '0')}`;
    classes[name] = { class_uri: `scale:${name}`, annotations: { library: { id: 'fixture.catalogue' } } };
    labels[`scale:${name}`] = `Type ${name}`;
  }
  return compileCatalogue({
    root: 'main.yaml',
    schemas: {
      'main.yaml': JSON.stringify({
        id: `https://catalogue.example/native/${index}`,
        name: `native${index}`,
        version: '1',
        prefixes: { scale: 'https://catalogue.example/types/', linkml: 'https://w3id.org/linkml/' },
        imports: ['linkml:types'],
        classes,
        slots: {},
      }),
    },
    presentation: { en: JSON.stringify({ types: labels, properties: {} }) },
  });
}
// One authored native regression; intentionally not executed during source-only delivery.
test('An authorized publisher uploads bounded catalogue artifacts spanning more than1024 Types and exact-Type Kinds builds indexes with retained bounded progress activates only the complete immutable root and reads a noninitial exact Kind plus bounded signed metadata pages through mounted default Kernel APIs while denied stale incomplete unsupported-filter and historical-v1 cases retain native meaning', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = createPool(databaseUrl);
  try {
    const people = {
      publisher: '019a1b2c-3d4e-7f00-8a00-ca7a10000001',
      denied: '019a1b2c-3d4e-7f00-8a00-ca7a10000002',
    };
    const authority = await createRealAccess(pool, people, [
      'definitions:publish',
      'definitions:activate',
      'definitions:read',
      'gate:definition_publication',
    ]);
    const global = { route: 0, id: GLOBAL_CONTEXT };
    for (const action of ['definitions:publish', 'definitions:activate', 'gate:definition_publication'])
      await authority.grant(global, 'publisher', action);
    // A real configured limiter admits this bulk author's fixture throughput; it still spends every request.
    const kernel = createKernel({
      pool,
      access: authority.access,
      routeKey: new Uint8Array(32).fill(23),
      receiptKeys: testReceiptKeys(),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(24)]]) },
      writeRate: createWriteRateLimiter({
        secret: 'catalogue-native-regression-rate-secret',
        overrides: JSON.stringify({
          'new-account': { write: { maximum: 100000, seconds: 60 } },
          member: { write: { maximum: 100000, seconds: 60 } },
        }),
      }),
    });
    async function call(
      method: string,
      path: string,
      body?: unknown,
      persona: 'publisher' | 'denied' | null = 'publisher',
      key = `"${randomUUID()}"`,
    ) {
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            ...(persona ? { authorization: `Bearer ${authority.bearer(persona)}` } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as any,
        session: response.headers.get(SESSION_HEADER),
      };
    }
    const releases = [await shard(0), await shard(1), await shard(2)];
    expect(releases.reduce((n, r) => n + Object.keys(r.types).length, 0)).toBeGreaterThan(1024);
    for (const body of releases) {
      expect(validateRelease(body)).toEqual([]);
      expect(Object.keys(body.types).length).toBeLessThanOrEqual(1024);
    }
    // Genuine historical shape: original Release1 without a Library profile retains absent-profile meaning.
    const legacy: Release = {
      format: 'https://rezics.com/definitions/release/1',
      catalogue: { id: 'https://catalogue.example/legacy-native', version: '1' },
      generator: { name: 'native-fixture', version: '1' },
      prefixes: { old: 'https://catalogue.example/legacy/' },
      types: {
        'old:Type': {
          iri: 'https://catalogue.example/legacy/Type',
          labels: { en: 'Old Type' },
          mappings: [],
          bases: [],
          properties: [],
          facets: [],
        },
      },
      properties: {},
      contexts: {},
    };
    expect(validateRelease(legacy)).toEqual([]);
    expect((await call('POST', '/v1/definitions/releases', { release: legacy })).status).toBe(201);
    const legacyDigest = releaseDigest(legacy);
    const oldReleaseHead = await call('GET', '/v1/definitions/active');
    expect(
      (
        await call('POST', `/v1/definitions/releases/${legacyDigest}:activate`, {
          expected_head: oldReleaseHead.status === 200 ? oldReleaseHead.body.head : null,
        })
      ).status,
    ).toBe(200);
    const objects = new Map<string, Uint8Array>();
    const store = {
      read: async (digest: string) => objects.get(digest),
      put: async (digest: string, bytes: Uint8Array) => {
        objects.set(digest, bytes);
      },
    };
    const initial = await buildCatalogue({ releases: [legacy], compatibility: 'all' }, store);
    async function upload(digest: string, persona: 'publisher' | 'denied' = 'publisher', key?: string) {
      const artifact = parseCatalogueJson(objects.get(digest)!, 4194304) as Record<string, unknown>;
      const format = artifact.format;
      const kind =
        format === CATALOGUE_FORMAT
          ? 'root'
          : format === CATALOGUE_NODE_FORMAT
            ? 'node'
            : format === KIND_FORMAT
              ? 'declaration'
              : 'release';
      return call('POST', '/v1/definitions/catalogue/artifacts', { kind, artifact }, persona, key);
    }
    const firstArtifact = objects.keys().next().value!;
    const deniedKey = `"${randomUUID()}"`;
    expect((await upload(firstArtifact, 'denied', deniedKey)).status).toBe(403);
    // A denied attempt creates no sealed success receipt: the exact key succeeds after a real grant.
    await authority.grant(global, 'denied', 'definitions:publish');
    await authority.grant(global, 'denied', 'gate:definition_publication');
    const allowed = await upload(firstArtifact, 'denied', deniedKey);
    expect(allowed.status).toBe(201);
    expect((await upload(firstArtifact, 'denied', deniedKey)).body).toEqual(allowed.body);
    await authority.revoke(global, 'denied', 'definitions:publish');
    for (const digest of objects.keys()) {
      const uploaded = await upload(digest);
      expect([200, 201]).toContain(uploaded.status);
      expect(uploaded.body.digest).toBe(digest);
    }
    const previousHead = await call('GET', '/v1/definitions/catalogue');
    async function start(pin: KindCataloguePin) {
      const value = await call('POST', '/v1/definitions/catalogues', { pin });
      expect(value.status).toBe(200);
      return value.body;
    }
    async function exhaust(pin: KindCataloguePin, progress: any) {
      while (progress.state === 'building' || progress.state === 'incomplete') {
        const key = `"${randomUUID()}"`;
        const next = await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}:step`, {}, 'publisher', key);
        expect(next.status).toBe(200);
        expect(BigInt(next.body.steps) - BigInt(progress.steps)).toBeLessThanOrEqual(1n);
        expect(BigInt(next.body.indexed_rows) - BigInt(progress.indexed_rows)).toBeLessThanOrEqual(256n);
        expect(BigInt(next.body.examined_bytes) - BigInt(progress.examined_bytes)).toBeLessThanOrEqual(4194304n);
        const replay = await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}:step`, {}, 'publisher', key);
        expect(replay.body).toEqual(next.body);
        progress = next.body;
        if (progress.state === 'incomplete') return progress;
      }
      return progress;
    }
    expect((await exhaust(initial, await start(initial))).state).toBe('ready');
    const activated = await call('POST', `/v1/definitions/catalogues/${initial.rootDigest}:activate`, {
      expected_head: previousHead.body?.head ?? null,
    });
    expect(activated.status).toBe(200);
    const initialHead = activated.body.head;
    const initialObjects = new Set(objects.keys());
    const pin = await buildCatalogue(
      {
        releases: [...releases, legacy],
        compatibility: 'all',
        declarations: [
          {
            ...compatibilityKind(releases[2]!, releaseDigest(releases[2]!), 'scale:T1151'),
            id: 'kind:First',
            auto: { eligible: true, precedence: 7 },
          },
          {
            ...compatibilityKind(releases[2]!, releaseDigest(releases[2]!), 'scale:T1151'),
            id: 'kind:Second',
            auto: { eligible: true, precedence: 7 },
          },
          {
            ...compatibilityKind(releases[2]!, releaseDigest(releases[2]!), 'scale:T1151'),
            id: 'kind:Control\u0000exact',
            labels: { en: 'Zero\u0000label' },
            auto: { eligible: false, precedence: 0 },
          },
        ],
      },
      store,
    );
    const allObjects = [...objects.keys()];
    const missing = allObjects.find(
      (digest) =>
        !initialObjects.has(digest) &&
        (parseCatalogueJson(objects.get(digest)!, 4194304) as any).format === CATALOGUE_NODE_FORMAT,
    )!;
    for (const digest of allObjects)
      if (digest !== missing) {
        expect([200, 201]).toContain((await upload(digest)).status);
      }
    let progress = await start(pin);
    expect(
      (await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}:activate`, { expected_head: initialHead }))
        .status,
    ).toBe(503);
    expect(
      (await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}/kinds:resolve`, { ids: ['scale:T1151'] }))
        .status,
    ).toBe(503);
    progress = await exhaust(pin, progress);
    expect(progress.state).toBe('incomplete');
    expect(progress.missing_digest).toBe(missing);
    expect((await call('GET', '/v1/definitions/catalogue')).body).toEqual({ pin: initial, head: initialHead });
    expect((await upload(missing)).status).toBe(201);
    progress = await exhaust(pin, progress);
    expect(progress.state).toBe('ready');
    expect(BigInt(progress.declarations)).toBeGreaterThan(1024n);
    const retained = await call('GET', `/v1/definitions/catalogues/${pin.rootDigest}/build`);
    expect(retained.body).toEqual(progress);
    expect(
      (await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}:activate`, { expected_head: null })).status,
    ).toBe(409);
    expect(
      (
        await call(
          'POST',
          `/v1/definitions/catalogues/${pin.rootDigest}:activate`,
          { expected_head: initialHead },
          'denied',
        )
      ).status,
    ).toBe(403);
    const active = await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}:activate`, {
      expected_head: initialHead,
    });
    expect(active.status).toBe(200);
    expect(active.session).not.toBeNull();
    const first = await call('GET', `/v1/definitions/catalogues/${pin.rootDigest}/kinds?limit=20`);
    expect(first.status).toBe(200);
    expect(first.body.kinds).toHaveLength(20);
    expect(first.body.next).toBeString();
    const searched = await call(
      'GET',
      `/v1/definitions/catalogues/${pin.rootDigest}/kinds?query=Type%20T11&language=en&limit=20`,
    );
    expect(searched.status).toBe(200);
    expect(searched.body.kinds.length).toBeGreaterThan(0);
    expect(searched.body.kinds.every((kind: any) => kind.declaration.labels.en.startsWith('Type T11'))).toBe(true);
    expect(first.body.kinds.some((kind: any) => kind.declaration.id === 'scale:T1151')).toBe(false);
    const exact = await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}/kinds:resolve`, {
      ids: ['scale:T1151', 'scale:Absent'],
    });
    expect(exact.status).toBe(200);
    expect(exact.body[0].value.declaration.condition.type).toEqual({
      typeId: 'scale:T1151',
      releaseDigest: releaseDigest(releases[2]!),
    });
    expect(exact.body[1].value).toBeNull();
    const control = await call('POST', `/v1/definitions/catalogues/${pin.rootDigest}/kinds:resolve`, {
      ids: ['kind:Control\u0000exact'],
    });
    expect(control.status).toBe(200);
    expect(control.body[0].value.declaration.id).toBe('kind:Control\u0000exact');
    expect(control.body[0].value.declaration.labels.en).toBe('Zero\u0000label');
    expect(Buffer.byteLength(JSON.stringify(first.body))).toBeLessThanOrEqual(1048576);
    const second = await call(
      'GET',
      `/v1/definitions/catalogues/${pin.rootDigest}/kinds?limit=20&cursor=${encodeURIComponent(first.body.next)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.kinds[0].declaration.id).not.toBe(first.body.kinds[0].declaration.id);
    for (const suffix of ['query=changed', 'language=fr'])
      expect(
        (
          await call(
            'GET',
            `/v1/definitions/catalogues/${pin.rootDigest}/kinds?${suffix}&cursor=${encodeURIComponent(first.body.next)}`,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await call(
          'GET',
          `/v1/definitions/catalogues/${initial.rootDigest}/kinds?cursor=${encodeURIComponent(first.body.next)}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'GET',
          `/v1/definitions/catalogues/${pin.rootDigest}/kinds?cursor=${encodeURIComponent(first.body.next + 'x')}`,
        )
      ).status,
    ).toBe(400);
    const candidates = await call(
      'GET',
      `/v1/definitions/catalogues/${pin.rootDigest}/candidates?exact_type_id=scale:T1151&limit=1`,
    );
    expect(candidates.status).toBe(200);
    expect(candidates.body.candidates[0].declaration.id).toBe('kind:First');
    const nextCandidate = await call(
      'GET',
      `/v1/definitions/catalogues/${pin.rootDigest}/candidates?exact_type_id=scale:T1151&limit=1&cursor=${encodeURIComponent(candidates.body.next)}`,
    );
    expect(nextCandidate.body.candidates[0].declaration.id).toBe('kind:Second');
    const old = await call('POST', `/v1/definitions/catalogues/${initial.rootDigest}/kinds:resolve`, {
      ids: ['old:Type'],
    });
    expect(old.body[0].value.declaration.condition.type.releaseDigest).toBe(legacyDigest);
    expect((await call('GET', `/v1/definitions/releases/${legacyDigest}`)).body.release).toEqual(legacy);
    expect((await call('GET', '/v1/definitions/active')).body.digest).toBe(legacyDigest);
    const unsupported = {
      ...compatibilityKind(releases[0]!, releaseDigest(releases[0]!), 'scale:T0000'),
      auto: { eligible: false, precedence: 0 },
      condition: {
        op: 'filter',
        language: 'https://rezics.com/filter/1',
        document: { type: { in: ['scale:T0000'] } },
        vocabulary: { types: [{ typeId: 'scale:T0000', releaseDigest: releaseDigest(releases[0]!) }], properties: [] },
      },
    };
    expect(
      (await call('POST', '/v1/definitions/catalogue/artifacts', { kind: 'declaration', artifact: unsupported }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/v1/definitions/catalogue/artifacts', {
          kind: 'declaration',
          artifact: { ...unsupported, format: 'https://rezics.com/definitions/kind/2' },
        })
      ).status,
    ).toBe(400);
    // Canonical addressed bytes can still declare an incorrect range; native full closure validation must refuse it.
    const root = parseCatalogueJson(objects.get(pin.rootDigest)!, 262144) as any;
    const corruptNode = {
      format: CATALOGUE_NODE_FORMAT,
      node: 'branch',
      children: [{ first: 'a', last: 'z', digest: root.directoryDigest }],
    };
    const corruptNodeDigest = catalogueDigest(catalogueBytes(corruptNode));
    const corruptRoot = {
      format: CATALOGUE_FORMAT,
      kindSpec: KIND_FORMAT,
      reduction: KIND_REDUCTION,
      directoryDigest: corruptNodeDigest,
    };
    const corruptPin = { ...pin, rootDigest: catalogueDigest(catalogueBytes(corruptRoot)) };
    objects.set(corruptNodeDigest, catalogueBytes(corruptNode));
    objects.set(corruptPin.rootDigest, catalogueBytes(corruptRoot));
    expect((await upload(corruptNodeDigest)).status).toBe(201);
    expect((await upload(corruptPin.rootDigest)).status).toBe(201);
    expect((await exhaust(corruptPin, await start(corruptPin))).state).toBe('refused');
    expect(
      (
        await call('POST', `/v1/definitions/catalogues/${corruptPin.rootDigest}:activate`, {
          expected_head: active.body.head,
        })
      ).status,
    ).toBe(503);
    expect((await call('GET', '/v1/definitions/catalogue')).body).toEqual(active.body);
  } finally {
    await pool.end();
  }
}, 300000);
