import { expect, mock, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import { createKernelClient } from '@rezics/client';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { SessionEnv } from '../src/session/client';
import {
  applyConceptCreateReuse,
  canAddConceptFact,
  captureConceptCreateReuse,
  conceptAdmitCreatedReader,
  conceptCreateDraft,
  conceptCreateFields,
  conceptCreatePreparedFacts,
  conceptCreateStructuredParts,
  conceptCreateTypes,
  conceptGrain,
  conceptTargetAdmitted,
  createConceptSubject,
  type ConceptCreateFact,
} from '../src/features/catalogue/concept-create';
import { genericCreateSpecializedPath } from '../src/features/catalogue/generic-create-facts';
import { conceptTypeAdmitted } from '../src/features/catalogue/source-concept-explorer';
import type { CreatedReader } from '../src/features/catalogue/create-subject';

mock.module('cloudflare:workers', () => ({ env: {} }));

const concept = 'skos:Concept';
const scheme = 'skos:ConceptScheme';
const target = '00000000-0000-4000-8000-00000000c101';
const schemeId = '00000000-0000-4000-8000-00000000c102';
const focusId = '00000000-0000-4000-8000-00000000c103';

function fact(property: string, content: string, groups: number[] = []): ConceptCreateFact {
  return {
    key: crypto.randomUUID(),
    statement: {
      property: { id: property },
      value: { type: 'value', content },
      qualifiers: [],
      references: groups.map((length, group) => ({
        parts: Array.from({ length }, (_, index) => ({
          property: { id: 'schema:url' },
          value: { type: 'value', content: `https://cite.example/${property}/${group}/${index}` },
        })),
      })),
      rank: 'normal',
    },
  };
}

test('concept creation admits released Concept and Scheme grains and their emitted fields', () => {
  const offered = conceptCreateTypes(bundledRelease, 'en');
  expect(offered.map(({ id }) => id).sort()).toEqual(
    Object.keys(bundledRelease.types)
      .filter((id) => conceptTypeAdmitted(bundledRelease, id))
      .sort(),
  );
  expect(conceptGrain(bundledRelease, concept)).toBe('concept');
  expect(conceptGrain(bundledRelease, scheme)).toBe('scheme');
  expect(conceptCreateFields(bundledRelease, concept)).toEqual([
    'skos:inScheme',
    'skos:broader',
    'foaf:focus',
    'skos:closeMatch',
    'schema:sameAs',
    'schema:url',
  ]);
  expect(conceptCreateFields(bundledRelease, scheme)).toEqual(['schema:sameAs', 'schema:url']);
  expect(conceptCreateFields(bundledRelease, concept)).not.toContain('schema:image');
  expect(genericCreateSpecializedPath(concept)).toBe('/catalogue/concept');
  expect(genericCreateSpecializedPath(scheme)).toBe('/catalogue/concept');
  expect(catalogueEntries.concept({ locale: 'ja' })).toMatchObject({
    group: 'create',
    href: '/ja/catalogue/concept',
  });
});

test('prepared Concept facts keep scheme, broader, focus and closeMatch distinct without inferred edges', () => {
  const facts = [fact('skos:inScheme', schemeId), fact('skos:broader', target), fact('foaf:focus', focusId)];
  const prepared = conceptCreateDraft(
    bundledRelease,
    { type: concept, labels: { en: 'Night', ja: '夜' }, descriptions: { en: 'A time of day' } },
    facts,
  );
  expect(prepared.errors).toEqual([]);
  expect(Object.keys(prepared.item.statements ?? {}).sort()).toEqual(['foaf:focus', 'skos:broader', 'skos:inScheme']);
  expect(prepared.item.statements?.['skos:closeMatch']).toBeUndefined();
  expect(prepared.item.statements?.['skos:narrower']).toBeUndefined();
  expect(conceptTargetAdmitted(bundledRelease, 'skos:inScheme', scheme)).toBe(true);
  expect(conceptTargetAdmitted(bundledRelease, 'skos:inScheme', concept)).toBe(false);
  const preferred: ConceptCreateFact = {
    ...fact('schema:url', 'https://example.test/concept'),
    statement: { ...fact('schema:url', 'https://example.test/concept').statement, rank: 'preferred' },
  };
  expect(conceptCreateDraft(bundledRelease, { type: concept, labels: { en: 'Night' } }, [preferred]).errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'unsupported' })]),
  );
  expect(canAddConceptFact([], 'schema:image', bundledRelease)).toBe(false);
});

test('created-reader admission requires the exact returned Concept Type', () => {
  const ready: CreatedReader = {
    state: 'ready',
    href: `/en/subjects/${target}/night`,
    identity: { id: target, type: concept, label: 'Night', bases: ['schema:Thing'] },
  };
  expect(conceptAdmitCreatedReader(ready, target, bundledRelease, concept).state).toBe('ready');
  expect(conceptAdmitCreatedReader(ready, target, bundledRelease, scheme).state).toBe('stale');
  expect(conceptAdmitCreatedReader({ state: 'unavailable' }, target, bundledRelease, concept).state).toBe(
    'unavailable',
  );
});

test('concept creation projects four holders at 32/128/512 input parts and copies seven reference parts to three targets', () => {
  const populations: number[][] = [[7], [7, 16, 8], [7, 16, 16, 16, 16, 16, 16, 16, 8]];
  expect(populations.map((groups) => 4 * (1 + groups.reduce((sum, length) => sum + length, 0)))).toEqual([
    32, 128, 512,
  ]);
  const properties = ['schema:url', 'schema:sameAs', 'skos:inScheme', 'skos:broader'] as const;
  for (const [index, groups] of populations.entries()) {
    const contents = ['https://example.test/a', 'https://example.test/b', schemeId, target];
    const facts = properties.map((property, holder) => fact(property, contents[holder]!, groups));
    expect(conceptCreateStructuredParts(facts)).toBe([32, 128, 512][index]);
    expect(conceptCreatePreparedFacts(facts, bundledRelease)).toHaveLength(4);
    const reuse = captureConceptCreateReuse(facts, facts[0]!.key, 0);
    expect(reuse).toBeTruthy();
    const copied = applyConceptCreateReuse(
      facts,
      { ...reuse!, selected: facts.slice(1).map((row) => `concept-initial-${row.key}`) },
      bundledRelease,
    );
    expect(copied.reuse.applied).toHaveLength(3);
    expect(conceptCreateStructuredParts(copied.facts)).toBe([53, 149, 533][index]);
  }
});

test('unknown Concept create retries the same key and later reads only the returned identity', async () => {
  const createdId = '00000000-0000-4000-8000-00000000c301';
  const calls: { method: string; path: string; key: string | null }[] = [];
  let lost = false;
  const item = {
    type: concept,
    labels: { en: 'Night', ja: '夜' },
    descriptions: { en: 'A time of day' },
    statements: {
      'skos:inScheme': [
        {
          property: { id: 'skos:inScheme' },
          value: { type: 'value', content: schemeId },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      ],
    },
  };
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      calls.push({ method: request.method, path, key: request.headers.get('idempotency-key') });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (request.method === 'GET' && path === '/v1/definitions/active') return json({ digest: definitions.digest });
      if (request.method === 'GET' && path === `/v1/definitions/releases/${definitions.digest}`)
        return json({ digest: definitions.digest, release: definitions.release });
      if (request.method === 'POST' && path === '/v1/subjects') {
        if (!lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json({ subject: { id: createdId, type: item.type, labels: item.labels } }, 201);
      }
      if (request.method === 'GET' && path === `/v1/subjects/${createdId}`)
        return json({
          subject: {
            id: createdId,
            type: item.type,
            labels: item.labels,
            descriptions: item.descriptions,
            aliases: {},
            statements: {},
            revision: 1,
            release: definitions.digest,
            context: '00000000-0000-8000-8000-000000000000',
            resolution: {},
            relationCounts: {},
            sourceRecords: [],
          },
          account: null,
          summary: null,
          related: {},
        });
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const request = new Request('https://site.invalid/api', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.invalid',
      'X-CSRF-Token': 'A'.repeat(22),
    },
  });
  const env = { AUTH_ISSUER: 'https://auth.invalid' } as Partial<SessionEnv>;
  const key = crypto.randomUUID();
  const first = await createConceptSubject(client, request, env, { key, item }, 'en', 'Bearer token');
  expect(first).toMatchObject({ ok: false, reason: 'unavailable' });
  const second = await createConceptSubject(client, request, env, { key, item }, 'en', 'Bearer token');
  expect(second).toMatchObject({ ok: true, id: createdId, reader: { state: 'ready' } });
  expect(
    calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects').map((call) => call.key),
  ).toEqual([key, key]);
});
