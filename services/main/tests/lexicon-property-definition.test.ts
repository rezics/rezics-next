import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { publicSemantics } from '../src/modules/access/semantic-disclosure.ts';
import type { PresentationRead } from '../src/modules/lexicon/change.ts';
import { namedMeaning } from '../src/modules/lexicon/property-name.ts';
import { selectedProjection } from '../src/modules/lexicon/render.ts';
import type { ExactDefinition } from '../src/modules/relation/change.ts';
import { lexiconRoutes } from '../src/routes/lexicon.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const property = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000a1';
const relation = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000a2';
const unpublished = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000a3';
const closed = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000a4';
const hiddenDefinition = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000b1';
const revision = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000b2';

function accessPool(denied: ReadonlySet<string>): Pool {
  const client = {
    release() {},
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('recovery_fence')) return { rows: [{ open: true, generation: '1' }] };
      if (sql.includes('unnest')) {
        const wanted = (params?.[0] as string[] | undefined) ?? [];
        return { rows: wanted.filter((resource) => !denied.has(resource)).map((resource) => ({ resource })) };
      }
      return { rows: [] };
    },
  };
  return { connect: async () => client } as unknown as Pool;
}

test('a public property definition is disclosed with a relation, and a closed one is not', async () => {
  let bytes = 0;
  const graph = {
    query: async (sparql: string, limit?: number) => {
      bytes = limit ?? 0;
      const bindings = [];
      if (sparql.includes('rv:PropertyDefinition')) {
        for (const id of [property, closed]) {
          if (sparql.includes(id)) bindings.push({ resource: { type: 'uri', value: id } });
        }
      }
      if (sparql.includes('rv:RelationDefinition') && sparql.includes(relation)) {
        bindings.push({ resource: { type: 'uri', value: relation } });
      }
      return { results: { bindings } };
    },
  };
  const disclosed = await publicSemantics({
    pool: accessPool(new Set([closed])), graph,
  }, [property, relation, unpublished, closed]);
  expect(disclosed).toEqual(new Set([property, relation]));
  expect(bytes).toBe(32_768);
  expect(await publicSemantics({ pool: accessPool(new Set()), graph }, [unpublished])).toEqual(new Set());
});

test('a property name uses the same selected presentation as a relation projection', () => {
  const definition = property;
  const meaning: ExactDefinition = {
    kind: 'property', definition, revision, lifecycle: 'active', roles: [], roleKeys: {},
  };
  const named = namedMeaning(meaning);
  expect(Object.values(named.roleKeys)).toEqual(['subject', 'value']);
  const relationMeaning: ExactDefinition = {
    kind: 'relation', definition: relation, revision, lifecycle: 'active',
    roles: [{ role: `${relation}/role/source`, minParticipants: 1, maxParticipants: 1, ordered: false }],
    roleKeys: { [`${relation}/role/source`]: 'source' },
  };
  expect(namedMeaning(relationMeaning)).toBe(relationMeaning);
  const row = (fromRole: string, toRole: string, language: string, noun: string): PresentationRead => ({
    component: `${definition}/presentation/${language}`, revision, predecessor: null,
    state: {
      definition, meaningRevision: revision, fromRole, toRole, language, noun, heading: noun,
      plurals: { other: noun }, grammaticalForms: [],
      source: 'https://example.com/vocabulary',
      licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
      reviewStatus: 'reviewed',
    },
    modelGeneration: 'urn:rezics:model-generation:test',
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
  });
  const propertyName = selectedProjection(
    [row('subject', 'value', 'en', 'Episodes'), row('subject', 'value', 'ja', '話数')],
    'subject', 'value', ['ja'], [],
  );
  const relationName = selectedProjection(
    [row('source', 'target', 'en', 'Derived works'), row('source', 'target', 'ja', '派生作品')],
    'source', 'target', ['ja'], [],
  );
  expect(propertyName).toMatchObject({
    language: 'ja', direction: 'ltr', reviewStatus: 'reviewed', fallback: null,
    labels: { noun: '話数', heading: '話数' },
  });
  expect(Object.keys(propertyName).sort()).toEqual(Object.keys(relationName).sort());
  expect(Object.keys(propertyName.labels!).sort()).toEqual(Object.keys(relationName.labels!).sort());
});

test('a private property key and an unknown key are the same unavailable read', async () => {
  const fuseki = {
    query: async (sparql: string) => {
      if (sparql.includes('ASK')) return { boolean: true, results: { bindings: [] } };
      if (sparql.includes('hidden-key')) return { results: { bindings: [{
        definition: { type: 'uri', value: hiddenDefinition },
        head: { type: 'uri', value: revision },
      }] } };
      return { results: { bindings: [] } };
    },
  } as unknown as FusekiClient;
  const app = lexiconRoutes(fuseki, {
    environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'route' } },
    access: { canReadSemanticResource: async (_principal: unknown, _actor: unknown, resource: string) =>
      resource !== hiddenDefinition },
    account: { verify: async () => { throw new Error('anonymous read must not verify an account'); } },
  } as unknown as MainWorkDependencies);
  const missing = await app.handle(new Request('http://main.local/v1/lexicon/definitions/missing-key'));
  const hidden = await app.handle(new Request('http://main.local/v1/lexicon/definitions/hidden-key'));
  expect(missing.status).toBe(404);
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toEqual(await missing.json());
  expect(missing.headers.get('cache-control')).toBe('no-store');
});
