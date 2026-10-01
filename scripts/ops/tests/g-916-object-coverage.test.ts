import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  FusekiClient,
  SparqlResult,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  ObjectIntegrityError,
  S3ImmutableObjects,
  type ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import {
  captureObjectRecoveryCoverage,
  graphObjectReferences,
} from '../../../services/main/src/modules/owner/object-coverage.ts';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { graphContentReferences } from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { RecoveryBudget } from '../recovery-set.ts';

const uri = (value: string) => ({ type: 'uri', value });
type Rows = NonNullable<SparqlResult['results']>['bindings'];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('G-916: Content reference scans bind every discovered graph and retain unknown owner namespaces', async () => {
  const id = '0190a3a4-8e3b-7c1d-9f2e-3a4b5c6d7e8f';
  const graphs = [GRAPHS.current, 'urn:rezics:graph:custom"graph', GRAPHS.control];
  const queries: string[] = [];
  const fuseki = {
    query: async (query: string) => {
      queries.push(query);
      if (query === 'SELECT ?graph WHERE { GRAPH ?graph {} }')
        return { results: { bindings: graphs.map((graph) => ({ graph: uri(graph) })) } };
      const binding = query.match(/BIND\(IRI\((".*")\) AS \?graph\)/)?.[1];
      if (!binding) throw new Error('scan has no bound graph');
      const graph = JSON.parse(binding) as string;
      const common = { graph: uri(graph), subject: uri('urn:rezics:subject:one') };
      const rows =
        graph === GRAPHS.current
          ? [
              {
                ...common,
                predicate: uri('https://rezics.com/vocab/contentRevision'),
                object: uri(`urn:rezics:content:revision:${id}`),
                digest: { type: 'literal', value: 'a'.repeat(64) },
                epoch: { type: 'literal', value: id },
                sequence: { type: 'literal', value: '0' },
              },
            ]
          : graph === graphs[1]
            ? [
                {
                  ...common,
                  predicate: uri('https://rezics.com/vocab/cites'),
                  object: uri(`urn:rezics:custom_ledger:evidence-item:${id}`),
                },
              ]
            : [];
      return { results: { bindings: rows } };
    },
  } as unknown as FusekiClient;
  const references = await graphContentReferences(fuseki);
  expect(references).toHaveLength(2);
  expect(references.find((ref) => ref.graph === GRAPHS.current)).toMatchObject({
    byteDigest: 'a'.repeat(64),
    ownerEpoch: id,
    ownerSequence: '0',
    preparationId: null,
  });
  expect(references.find((ref) => ref.graph === graphs[1])).toMatchObject({
    object: `urn:rezics:custom_ledger:evidence-item:${id}`,
    byteDigest: null,
    ownerEpoch: null,
  });
  expect(queries).toHaveLength(4);
  expect(queries[2]).toContain(JSON.stringify(graphs[1]));
});

function scans(rows: {
  manifest: Rows;
  component: Rows;
  modelRevision: Rows;
  shapeRevision: Rows;
}) {
  const queries: string[] = [];
  const fuseki = {
    query: async (query: string) => {
      queries.push(query);
      const predicate = query.match(/rv:(manifest|component|modelRevision|shapeRevision)\b/)?.[1];
      if (!predicate) throw new Error('unexpected coverage scan');
      return { results: { bindings: rows[predicate as keyof typeof rows] } };
    },
  } as unknown as FusekiClient;
  return { fuseki, queries };
}

test('G-916: predicate scans preserve absent, multivalued and graph-local metadata', async () => {
  const graph = uri(GRAPHS.current);
  const subject = uri('urn:rezics:component:one');
  const anotherGraph = uri(GRAPHS.revisions);
  const manifest = uri(`urn:rezics:sha256:${'a'.repeat(64)}`);
  const row = { graph, subject };
  const scanner = scans({
    manifest: [
      { ...row, manifest },
      { graph: anotherGraph, subject, manifest },
    ],
    component: [
      { ...row, value: uri('urn:rezics:component:a') },
      { ...row, value: uri('urn:rezics:component:b') },
    ],
    modelRevision: [
      { ...row, value: uri('urn:rezics:model:a') },
      { ...row, value: uri('urn:rezics:model:b') },
    ],
    shapeRevision: [
      {
        graph,
        subject: uri('urn:rezics:unrelated'),
        value: { type: 'literal', value: 'ignored outside the manifest set' },
      },
    ],
  });
  const references = await graphObjectReferences(scanner.fuseki);
  expect(references).toHaveLength(5);
  expect(
    references
      .filter((ref) => ref.graph === GRAPHS.current)
      .map((ref) => [ref.component, ref.model, ref.shape])
      .sort(),
  ).toEqual([
    ['urn:rezics:component:a', 'urn:rezics:model:a', null],
    ['urn:rezics:component:a', 'urn:rezics:model:b', null],
    ['urn:rezics:component:b', 'urn:rezics:model:a', null],
    ['urn:rezics:component:b', 'urn:rezics:model:b', null],
  ]);
  expect(references.find((ref) => ref.graph === GRAPHS.revisions)).toMatchObject({
    component: null,
    model: null,
    shape: null,
  });
  expect(scanner.queries).toHaveLength(4);
  expect(scanner.queries.every((query) => !query.includes('OPTIONAL'))).toBe(true);
  const invalid = scans({
    manifest: [{ ...row, manifest }],
    component: [],
    modelRevision: [],
    shapeRevision: [{ ...row, value: { type: 'literal', value: 'invalid' } }],
  });
  await expect(graphObjectReferences(invalid.fuseki)).rejects.toThrow('not an IRI');
});

function objectsFixture() {
  const bytes = new Map<string, Uint8Array>();
  const rows = {
    manifest: [] as Rows,
    component: [] as Rows,
    modelRevision: [] as Rows,
    shapeRevision: [] as Rows,
  };
  const put = (value: unknown) => {
    const body = new TextEncoder().encode(JSON.stringify(value));
    const sha = digest(body);
    bytes.set(sha, body);
    return sha;
  };
  for (let index = 0; index < 40; index++) {
    const component = `urn:rezics:component:${Math.floor(index / 2)}`;
    const payload = put({
      format: 'rezics-component-v1',
      component,
      state: { index: Math.floor(index / 2) },
    });
    const manifest = put({
      format: 'rezics-manifest-v1',
      mediaType: 'application/json',
      component,
      model: 'urn:rezics:model:test',
      shape: 'urn:rezics:shape:test',
      payload: `sha256:${payload}`,
      payloadBytes: bytes.get(payload)!.length,
      revision: index,
    });
    for (const graph of [GRAPHS.current, GRAPHS.revisions]) {
      const row = { graph: uri(graph), subject: uri(`urn:rezics:anchor:${index}`) };
      rows.manifest.push({ ...row, manifest: uri(`urn:rezics:sha256:${manifest}`) });
      rows.component.push({ ...row, value: uri(component) });
      rows.modelRevision.push({ ...row, value: uri('urn:rezics:model:test') });
      rows.shapeRevision.push({ ...row, value: uri('urn:rezics:shape:test') });
    }
  }
  let active = 0;
  let maximum = 0;
  const reads = new Map<string, number>();
  let corrupt: string | undefined;
  const store: ImmutableObjects = {
    put: async () => {
      throw new Error('recovery must never write objects');
    },
    get: async (sha) => {
      active++;
      maximum = Math.max(maximum, active);
      reads.set(sha, (reads.get(sha) ?? 0) + 1);
      try {
        await Bun.sleep(1);
        if (sha === corrupt) throw new ObjectIntegrityError('corrupt test object');
        return bytes.get(sha)!;
      } finally {
        active--;
      }
    },
  };
  return {
    ...scans(rows),
    store,
    bytes,
    reads,
    active: () => active,
    maximum: () => maximum,
    corrupt: (sha: string) => {
      corrupt = sha;
    },
  };
}

test('G-916: overlapping object reads retain the complete serial cut and fetch each object once', async () => {
  const serial = objectsFixture();
  const expected = await captureObjectRecoveryCoverage(serial.fuseki, {
    directory: '.temp/unused',
    workObjects: serial.store,
  });
  const concurrent = objectsFixture();
  const actual = await captureObjectRecoveryCoverage(concurrent.fuseki, {
    directory: '.temp/unused',
    workObjects: concurrent.store,
    readConcurrency: 32,
  });
  expect(actual).toEqual(expected);
  expect(actual).toMatchObject({ referenceCount: '80', anchorCount: '40', objectCount: '60' });
  expect(concurrent.maximum()).toBeGreaterThan(1);
  expect(concurrent.maximum()).toBeLessThanOrEqual(32);
  expect(concurrent.active()).toBe(0);
  expect(concurrent.reads.size).toBe(60);
  expect([...concurrent.reads.values()].every((count) => count === 1)).toBe(true);
});

test('G-916: a corrupt parallel read fails closed after all started reads settle', async () => {
  const fixture = objectsFixture();
  fixture.corrupt([...fixture.bytes.keys()][3]!);
  await expect(
    captureObjectRecoveryCoverage(fixture.fuseki, {
      directory: '.temp/unused',
      workObjects: fixture.store,
      readConcurrency: 32,
    }),
  ).rejects.toThrow('immutable object is corrupt');
  expect(fixture.active()).toBe(0);
  expect(fixture.reads.size).toBeLessThan(60);
  await expect(
    captureObjectRecoveryCoverage(fixture.fuseki, {
      directory: '.temp/unused',
      workObjects: fixture.store,
      readConcurrency: 33,
    }),
  ).rejects.toThrow('outside 1..32');
});

test('G-916: recovery failures identify their phase and retain the original cause', async () => {
  const budget = new RecoveryBudget();
  const cause = new DOMException('The operation timed out', 'TimeoutError');
  try {
    await budget.phase('coverage', () => {
      throw cause;
    });
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Recovery phase coverage failed');
    expect((error as Error).cause).toBe(cause);
  }
  expect(budget.phases.coverage).toBeGreaterThanOrEqual(0);
  await expect(
    budget.phase('encrypt', () => {
      throw new Error('gpg recovery step failed');
    }),
  ).rejects.toThrow('gpg recovery step failed');
});

test('G-916: an object error after the command deadline reports budget exhaustion', async () => {
  const budget = new RecoveryBudget();
  const clock = spyOn(Date, 'now');
  const cause = new Error('committed immutable object is unavailable');
  try {
    await budget.phase('coverage', () => {
      clock.mockReturnValue(budget.started + 600_001);
      throw cause;
    });
    throw new Error('expected failure');
  } catch (error) {
    expect((error as Error).message).toContain('600-second budget');
    expect((error as Error).message).toContain('coverage');
    expect((error as Error).cause).toBe(cause);
  } finally {
    clock.mockRestore();
  }
});

test('G-916: S3 recovery reads carry the enclosing deadline through request signing', async () => {
  const controller = new AbortController();
  const bytes = new TextEncoder().encode('retained immutable bytes');
  const observed: boolean[] = [];
  const transport = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        if (!(input instanceof Request)) throw new Error('expected a signed request');
        observed.push(input.signal.aborted);
        if (input.signal.aborted) throw input.signal.reason;
        return new Response(bytes);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const store = new S3ImmutableObjects({
      endpoint: 'https://objects.example.test',
      bucket: 'rezics-test',
      region: 'us-east-1',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      prefix: 'semantic/work/',
      readSignal: () => controller.signal,
    });
    expect(await store.get(digest(bytes))).toEqual(bytes);
    controller.abort(new DOMException('recovery deadline', 'TimeoutError'));
    await expect(store.get(digest(bytes))).rejects.toThrow('immutable object is unavailable');
    expect(observed).toEqual([false, true]);
  } finally {
    transport.mockRestore();
  }
});
