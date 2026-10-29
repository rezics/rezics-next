import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse, Persona, SearchDriver } from '../../../../specs/search-driver.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { createSearchDriver } from './outcome-driver.ts';

const bookFilter = { type: { in: ['schema:Book'] } };
const properties = ['type', 'schema:inLanguage', 'schema:author'];
type FacetValue = { value: string; labels: Record<string, string> };
type Facet = { property: string; values: FacetValue[] };
const word = () =>
  `deletion${randomUUID()
    .replaceAll('-', '')
    .replace(/[0-9]/g, (n) => String.fromCharCode(97 + Number(n)))}`;

async function create(driver: SearchDriver, label: string, author?: Subject): Promise<Subject> {
  const response = await driver.request(
    'editor',
    'POST',
    '/v1/subjects',
    {
      type: author ? 'schema:Book' : 'schema:Person',
      labels: { en: label },
      statements: author
        ? {
            'schema:author': [
              { property: { id: 'schema:author' }, value: { type: 'value', content: author.id }, rank: 'normal' },
            ],
            'schema:inLanguage': [
              { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' }, rank: 'normal' },
            ],
          }
        : {},
    },
    { 'Idempotency-Key': `"${randomUUID()}"` },
  );
  expect(response.status).toBe(201);
  const subject = response.body.subject as Subject;
  expect(response.headers.get('location')).toBe(`/v1/subjects/${subject.id}`);
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return subject;
}

function problem(response: HttpResponse, status: 401 | 503) {
  const code = status === 503 ? 'index_not_ready' : 'invalid_credentials';
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({
    type: `https://rezics.com/problems/${code}`,
    title: status === 503 ? 'Search Index Not Ready' : 'Invalid Credentials',
    status,
    code,
    retryable: status === 503,
    effect_status: 'not_applicable',
    request_id: expect.any(String),
  });
  expect((response.body.request_id as string).length).toBeGreaterThan(0);
  expect(
    Object.keys(response.body).every((key) =>
      ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id', 'detail', 'errors'].includes(key),
    ),
  ).toBe(true);
  if (response.body.detail !== undefined) {
    expect(typeof response.body.detail).toBe('string');
    expect([...(response.body.detail as string)].length).toBeLessThanOrEqual(512);
  }
  if (response.body.errors !== undefined) {
    expect(Array.isArray(response.body.errors)).toBe(true);
    const errors = response.body.errors as { pointer: string; code: string }[];
    expect(errors.length).toBeLessThanOrEqual(16);
    for (const error of errors) {
      expect(Object.keys(error).sort()).toEqual(['code', 'pointer']);
      expect(error.pointer).toMatch(/^(?:\/(?:[^~/]|~[01])*)*$/);
      expect(['required', 'unknown_field', 'invalid_type', 'invalid_format', 'out_of_range', 'unsupported']).toContain(
        error.code,
      );
    }
  }
  if (status === 503) expect(response.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
  else expect(response.headers.get('www-authenticate')).toContain('invalid_token');
}

function successful(response: HttpResponse) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.body).not.toHaveProperty('total');
  expect(response.body.as_of).toEqual(
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  );
  const asOf = Date.parse(response.body.as_of as string);
  expect(Number.isFinite(asOf)).toBe(true);
  expect(asOf).toBeLessThanOrEqual(Date.now());
}

function expectedFacetValues(author: Subject, visible: boolean): Record<string, FacetValue[]> {
  return {
    type: visible
      ? [
          {
            value: 'schema:Book',
            labels: {
              de: 'Buch',
              en: 'book',
              es: 'libro',
              fr: 'livre',
              ja: '書籍',
              ko: '책',
              'zh-Hans': '书籍',
              'zh-Hant': '書籍',
            },
          },
        ]
      : [],
    'schema:inLanguage': visible ? [{ value: 'en', labels: {} }] : [],
    'schema:author': visible ? [{ value: author.id, labels: author.labels }] : [],
  };
}

function requiredFacetValues(values: Record<string, FacetValue[]>, property: string): FacetValue[] {
  const expected = values[property];
  if (expected === undefined) throw new Error(`Unexpected facet property: ${property}`);
  return expected;
}

async function views(driver: SearchDriver, persona: Persona, marker: string) {
  return [
    await driver.request(persona, 'POST', '/v1/subjects:search', { text: marker, filter: bookFilter, limit: 1 }),
    await driver.request(persona, 'POST', '/v1/subjects:facets', {
      text: marker,
      filter: bookFilter,
      facets: properties.map((property) => ({ property })),
    }),
    await driver.request(persona, 'GET', `/v1/subjects:suggest?q=${marker}&limit=10`),
  ];
}

function safe(responses: HttpResponse[], removed: Subject, visible: Subject[], author: Subject, converged: boolean) {
  responses.forEach((response, route) => {
    // Fail closed is allowed during lag, but only with the existing typed problem.
    if (!converged && response.status === 503) {
      problem(response, 503);
      return;
    }
    successful(response);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(removed.id);
    expect(serialized).not.toContain(removed.labels.en!);
    if (route !== 1) {
      expect(Array.isArray(response.body.subjects)).toBe(true);
      const subjects = response.body.subjects as { id: string }[];
      expect(subjects.map(({ id }) => id).sort()).toEqual(visible.map(({ id }) => id).sort());
    }
    if (route === 1) {
      const facets = response.body.facets as Facet[];
      expect(Array.isArray(facets)).toBe(true);
      expect(facets.map(({ property }) => property).sort()).toEqual([...properties].sort());
      for (const facet of facets) {
        expect(facet).not.toHaveProperty('relation');
        const expected = requiredFacetValues(expectedFacetValues(author, true), facet.property);
        expect(Array.isArray(facet.values)).toBe(true);
        expect(new Set(facet.values.map(({ value }) => value)).size).toBe(facet.values.length);
        if (visible.length === 0 || converged) {
          expect(facet.values).toEqual(visible.length > 0 ? expected : []);
        } else {
          expect(facet.values.length).toBeLessThanOrEqual(1);
          const expectedValue = expected[0];
          if (expectedValue === undefined) throw new Error(`Expected a visible value for ${facet.property}`);
          for (const bucket of facet.values) expect(bucket).toEqual(expectedValue);
        }
        for (const bucket of facet.values) expect(bucket).not.toHaveProperty('count');
      }
    }
  });
}

function complete(responses: HttpResponse[], visible: Subject[], author: Subject) {
  if (responses.some((response) => response.status !== 200)) return false;
  const expectedIds = visible.map(({ id }) => id).sort();
  for (const route of [0, 2]) {
    const subjects = responses[route]!.body.subjects as { id: string }[];
    if (JSON.stringify(subjects.map(({ id }) => id).sort()) !== JSON.stringify(expectedIds)) return false;
  }
  const facets = responses[1]!.body.facets as Facet[];
  if (JSON.stringify(facets.map(({ property }) => property).sort()) !== JSON.stringify([...properties].sort()))
    return false;
  const expected = expectedFacetValues(author, visible.length > 0);
  return facets.every(
    (facet) =>
      JSON.stringify(facet.values.map(({ value }) => value)) ===
      JSON.stringify(expected[facet.property]!.map(({ value }) => value)),
  );
}

async function eventually(read: () => Promise<boolean>, detail: string) {
  // At most 60 rounds of real requests; no background polling survives the test.
  const deadline = performance.now() + 30_000;
  for (let attempt = 0; attempt < 60 && performance.now() < deadline; attempt++) {
    if (await read()) return;
    await Bun.sleep(250);
  }
  throw new Error(detail);
}

for (const mode of ['hidden', 'taken_down'] as const) {
  for (const mixed of [false, true]) {
    test(`${mode} source deletion immediately withholds ${mixed ? 'mixed visible/source' : 'hidden-only'} hits and facet values`, async () => {
      const driver = await createSearchDriver();
      try {
        const marker = word();
        const author = await create(driver, `${word()} Author`);
        const removed = await create(driver, `${marker} Removed`, author);
        const visible = mixed ? [await create(driver, `${marker} Visible`, author)] : [];
        // The author target remains visible while the removed source contributes hits and facet values.
        for (const subject of [author, removed, ...visible]) {
          await eventually(async () => {
            const response = await driver.request('anonymous', 'POST', '/v1/subjects:search', {
              text: subject.labels.en,
              limit: 20,
            });
            if (response.status === 503) {
              problem(response, 503);
              return false;
            }
            successful(response);
            return (response.body.subjects as { id: string }[]).some(({ id }) => id === subject.id);
          }, `Initial subject ${subject.id} was not indexed`);
        }
        await eventually(async () => {
          const response = await driver.request('anonymous', 'GET', `/v1/subjects:suggest?q=${marker}&limit=10`);
          if (response.status === 503) {
            problem(response, 503);
            return false;
          }
          successful(response);
          const ids = new Set((response.body.subjects as { id: string }[]).map(({ id }) => id));
          const expected = [removed, ...visible].map(({ id }) => id);
          return expected.every((id) => ids.has(id)) && [...ids].every((id) => expected.includes(id));
        }, 'Initial typeahead subjects were not indexed');
        const sessions = new Map<Persona, (string | null)[]>();
        for (const persona of ['anonymous', 'editor'] as const) {
          const initial = await views(driver, persona, marker);
          initial.forEach(successful);
          const originalSearch = await driver.request(persona, 'POST', '/v1/subjects:search', {
            text: marker,
            filter: bookFilter,
            limit: 20,
          });
          successful(originalSearch);
          expect(originalSearch.body).not.toHaveProperty('total');
          expect((originalSearch.body.subjects as { id: string }[]).map(({ id }) => id).sort()).toEqual(
            [removed, ...visible].map(({ id }) => id).sort(),
          );
          expect(originalSearch.body.next).toBeNull();
          // Prove the source supplied every original type, code and item value before deletion.
          const facets = initial[1]!.body.facets as Facet[];
          expect(facets.map(({ property }) => property).sort()).toEqual([...properties].sort());
          const originalValues = expectedFacetValues(author, true);
          for (const facet of facets) {
            expect(facet).not.toHaveProperty('relation');
            expect(facet.values).toEqual(requiredFacetValues(originalValues, facet.property));
            for (const value of facet.values) expect(value).not.toHaveProperty('count');
          }
          sessions.set(
            persona,
            initial.map((response) => response.headers.get('rezics-session-token')),
          );
        }
        await driver.indexing('paused');
        try {
          await driver.remove(removed.id, mode);
          for (const persona of ['anonymous', 'editor'] as const) {
            safe(await views(driver, persona, marker), removed, visible, author, false);
            const value = await driver.request(persona, 'GET', `/v1/subjects/${author.id}`);
            expect(value.status).toBe(200);
            expect((value.body.subject as Subject).id).toBe(author.id);
            expect((value.body.subject as Subject).labels).toEqual(author.labels);
          }
          for (const response of await views(driver, 'suspended', marker)) problem(response, 401);
        } finally {
          await driver.indexing('running');
        }
        await eventually(async () => {
          let ready = true;
          for (const persona of ['anonymous', 'editor'] as const) {
            const responses = await views(driver, persona, marker);
            safe(responses, removed, visible, author, false);
            if (!complete(responses, visible, author)) {
              ready = false;
              continue;
            }
            safe(responses, removed, visible, author, true);
            responses.forEach((response, route) => {
              // Tokens may advance and as_of reflects real progress; preserve the wire contract.
              const previous = sessions.get(persona)![route];
              const current = response.headers.get('rezics-session-token');
              if (previous === null) expect(current).toBeNull();
              else expect(current).toBeTruthy();
            });
          }
          return ready;
        }, 'Deletion did not converge to exact visible hits and current facet values');
      } finally {
        await driver.close();
      }
    }, 600_000);
  }
}
