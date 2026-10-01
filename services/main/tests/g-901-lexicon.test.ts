import { expect, test } from 'bun:test';
import {
  checkedComponentState,
  semanticChangeDigest,
  type DefinitionState,
} from '../src/modules/semantic/change.ts';
import { listDefinitions, DEFINITION_LIST_LIMIT } from '../src/modules/lexicon/catalog.ts';
import { editorRecording } from '../src/modules/lexicon/editor-recording.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';

const native = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
const state = {
  component: 'definition',
  kind: 'relation',
  notation: 'future-kind',
  workSubjectRole: 'target',
  roles: ['source', 'target'].map((key) => ({
    key,
    minParticipants: 1,
    maxParticipants: 1,
    ordered: false,
  })),
};

test('G-901: recording metadata is admitted, retained in intent and requires a usable key and authority role', () => {
  const recording = { ...state, editorRecordable: true, writePath: 'relation' };
  expect(checkedComponentState(recording)).toMatchObject(recording);
  expect(semanticChangeDigest(undefined, null, checkedComponentState(recording))).not.toBe(
    semanticChangeDigest(
      undefined,
      null,
      checkedComponentState({ ...recording, writePath: 'derivation' }),
    ),
  );
  expect(editorRecording({})).toEqual({ editorRecordable: false, writePath: null });
  for (const extra of [
    { editorRecordable: 'true' },
    { writePath: 'unknown' },
    { editorRecordable: true },
    { ...recording, notation: undefined },
    { ...recording, workSubjectRole: undefined },
    { ...recording, workSubjectRole: 'absent' },
    { ...recording, kind: 'classification', roles: [], workSubjectRole: undefined },
  ]) {
    expect(() => checkedComponentState({ ...state, ...extra })).toThrow();
  }
});

test('G-901: all eight seeded choices carry data and the new public read is classified', async () => {
  const choices = relationLexiconSeed.filter(
    (item) => 'editorRecordable' in item && item.editorRecordable,
  );
  expect(
    Object.fromEntries(
      choices.map((item) => [item.key, 'writePath' in item ? item.writePath : null]),
    ),
  ).toEqual({
    adaptation: 'derivation',
    rewrite: 'derivation',
    reboot: 'derivation',
    sequel: 'relation',
    'spin-off': 'relation',
    'correspondence-equivalent': 'relation',
    'correspondence-partial': 'relation',
    'correspondence-revised': 'relation',
  });
  const writes: { path: string; state: Record<string, unknown>; key: string }[] = [];
  await seedRelationLexicon(
    {
      post: async <T>(path: string, body: object, key: string) => {
        writes.push({ path, state: (body as { state: Record<string, unknown> }).state, key });
        return { component: native(), revision: native() } as T;
      },
      authorizeDefinition: async () => {},
    },
    native(),
    `g901-${Bun.randomUUIDv7()}`,
    choices.map((item) => ({ ...item, labels: [] })),
  );
  expect(writes).toHaveLength(8);
  for (const write of writes) {
    expect(write.path).toBe('/v1/semantic/changes');
    expect(write.key).toContain(':lexicon:v3:');
    expect(checkedComponentState(write.state)).toMatchObject({
      editorRecordable: true,
      writePath: write.state.writePath,
    });
  }
  expect(rateLimitFamily('GET', '/v1/lexicon/definitions')).toBeNull();
});

test('G-901: bootstrap upgrades existing admitted data, preserves roles and resumes without replacing its identity', async () => {
  let current = {
    component: native(),
    revision: native(),
    state: checkedComponentState({
      ...state,
      roles: state.roles.map((role) =>
        role.key === 'source' ? { ...role, maxParticipants: 3, ordered: true } : role,
      ),
    }) as DefinitionState,
  };
  const component = current.component,
    predecessor = current.revision;
  const writes: { body: Record<string, unknown>; key: string }[] = [];
  const client = {
    currentDefinition: async () => current,
    authorizeDefinition: async () => {},
    post: async <T>(_path: string, body: object, key: string) => {
      writes.push({ body: body as Record<string, unknown>, key });
      current = {
        ...current,
        revision: native(),
        state: checkedComponentState((body as { state: unknown }).state) as DefinitionState,
      };
      return current as T;
    },
  };
  const data = [
    {
      key: state.notation,
      roles: ['source', 'target'] as const,
      labels: [],
      editorRecordable: true,
      writePath: 'relation' as const,
    },
  ];
  await seedRelationLexicon(client, native(), 'g901-upgrade', data);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toMatchObject({
    target: component,
    expectedHead: predecessor,
    state: {
      editorRecordable: true,
      writePath: 'relation',
      roles: [{ key: 'source', maxParticipants: 3, ordered: true }, { key: 'target' }],
    },
  });
  expect(writes[0]!.key).toContain(predecessor.split('/').at(-1)!);
  const resumed = await seedRelationLexicon(client, native(), 'g901-upgrade', data);
  expect(writes).toHaveLength(1);
  expect(resumed[0]).toEqual({ key: state.notation, component, revision: current.revision });
});

test('G-901: bootstrap resumes upgraded labels but leaves pre-existing matching language slots alone', async () => {
  let current = {
    component: native(),
    revision: native(),
    state: checkedComponentState(state) as DefinitionState,
  };
  let interrupted = true;
  const meaningKeys: string[] = [],
    labelKeys: string[] = [];
  const client = {
    currentDefinition: async () => current,
    authorizeDefinition: async () => {},
    post: async <T>(path: string, body: object, key: string) => {
      if (path === '/v1/semantic/changes') {
        meaningKeys.push(key);
        current = {
          ...current,
          revision: native(),
          state: checkedComponentState((body as { state: unknown }).state) as DefinitionState,
        };
      } else {
        labelKeys.push(key);
        if (interrupted) {
          interrupted = false;
          throw new Error('label interrupted');
        }
      }
      return { component: current.component, revision: current.revision } as T;
    },
  };
  const data = [
    {
      key: state.notation,
      roles: ['source', 'target'] as const,
      labels: [['en', 'Kind', 'Kinds', 'Source', 'Sources'] as const],
      editorRecordable: true,
      writePath: 'relation' as const,
    },
  ];
  const namespace = `g901-retry-${Bun.randomUUIDv7()}`;
  await expect(seedRelationLexicon(client, native(), namespace, data)).rejects.toThrow(
    'label interrupted',
  );
  await seedRelationLexicon(client, native(), namespace, data);
  expect(meaningKeys).toHaveLength(1);
  expect(labelKeys).toHaveLength(3);
  expect(labelKeys[0]).toBe(labelKeys[1]);
  // Another namespace has no interrupted write to replay: do not overwrite or duplicate its slots.
  const existingNamespace = `g901-old-${Bun.randomUUIDv7()}`;
  await seedRelationLexicon(client, native(), existingNamespace, data);
  await seedRelationLexicon(client, native(), existingNamespace, data);
  expect(meaningKeys).toHaveLength(1);
  expect(labelKeys).toHaveLength(3);
});

test('G-901: bounded keyset pages hide denied entries before object reads and bind opaque continuations', async () => {
  const queries: { sparql: string; bytes?: number }[] = [];
  const rows = ['a-hidden', 'b-hidden', 'c-hidden'].map((key) => ({
    key: { type: 'literal', value: key },
    definition: { type: 'uri', value: native() },
    head: { type: 'uri', value: native() },
  }));
  let calls = 0;
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/g-901-unreadable',
    fuseki: {
      query: async (sparql: string, bytes?: number) => {
        queries.push({ sparql, bytes });
        return { results: { bindings: calls++ === 0 ? rows : rows.slice(2) } };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const options = { limit: 2, recordable: true, languages: ['de'] };
  const page = await listDefinitions(env, options, async () => false);
  expect(page.items).toEqual([]);
  expect(page.next).toBeTruthy();
  expect(Buffer.from(page.next!, 'base64url').toString()).not.toContain('hidden');
  expect(queries).toHaveLength(1);
  expect(queries[0]!.bytes).toBe(32_768);
  expect(queries[0]!.sparql).toContain('LIMIT 3');
  const last = await listDefinitions(env, { ...options, cursor: page.next! }, async () => false);
  expect(last).toEqual({ items: [], next: null });
  expect(queries[1]!.sparql).toContain('FILTER(STR(?key) > "b-hidden")');
  expect(queries[1]!.sparql).not.toContain('OFFSET');
  for (const changed of [
    { ...options, recordable: false },
    { ...options, limit: 3 },
    { ...options, languages: ['ar'] },
  ]) {
    await expect(
      listDefinitions(env, { ...changed, cursor: page.next! }, async () => false),
    ).rejects.toThrow();
  }
  await expect(
    listDefinitions(env, { ...options, cursor: 'invalid' }, async () => false),
  ).rejects.toThrow();
  await expect(
    listDefinitions(env, { ...options, limit: DEFINITION_LIST_LIMIT + 1 }, async () => false),
  ).rejects.toThrow();
  expect(queries).toHaveLength(2);
});
