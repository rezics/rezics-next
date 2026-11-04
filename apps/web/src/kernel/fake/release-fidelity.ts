import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { PropertyDefinition, Release, TypeDefinition } from '@rezics/definitions';
import { candidateContext } from '../../subject/candidates';
import { readReleaseFidelity } from '../../features/catalogue/release-fidelity/read';
import { RELEASE_ASSOCIATION_LIMIT } from '../../features/catalogue/release-fidelity/model';
import { proposeFact } from '../../features/catalogue/subject-facts';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';

export const releaseSubject = '00000000-0000-4000-8000-00000000a101';
export const releaseWork = '00000000-0000-4000-8000-00000000a102';
export const releaseAlt = '00000000-0000-4000-8000-00000000a103';
export const releaseSuperseded = '00000000-0000-4000-8000-00000000a104';
export const releaseCompleteness = '00000000-0000-4000-8000-00000000a115';
export const basedOnProperty = 'schema:isBasedOn';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export type ReleaseFidelityScenario =
  | 'ready'
  | 'tba'
  | 'partial-date'
  | 'absent-date'
  | 'unreadable-work'
  | 'concealed-work'
  | 'not-release'
  | 'stale'
  | 'denied'
  | 'unavailable'
  | 'detail-unavailable';

function labels(en: string): TypeDefinition['labels'] {
  return { en, de: en, es: en, fr: en, ja: en, ko: en, 'zh-Hans': en, 'zh-Hant': en };
}

function itemProperty(id: string, en: string, targets: string[]): PropertyDefinition {
  return {
    iri: `https://schema.org/${id.split(':')[1] ?? id}`,
    labels: labels(en),
    mappings: [],
    datatype: 'wikibase-item',
    multivalued: true,
    targets,
    qualifiers: ['schema:sameAs'],
    value: { type: 'string', pattern: UUID },
    relation: { group: 'derivation', order: 'name', inverse: 'none' },
  };
}

/** Test-only release-to-release properties; file/group descriptors come from the bundled release. */
export function withConcreteReleaseDescriptors(source: Release, files = true): Release {
  const release = structuredClone(source);
  const editionTargets = ['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'];
  release.properties[basedOnProperty] = itemProperty(basedOnProperty, 'based on', editionTargets);
  for (const type of editionTargets) {
    const definition = release.types[type];
    if (!definition) continue;
    if (!definition.properties.includes(basedOnProperty)) definition.properties.push(basedOnProperty);
  }
  if (!files) {
    delete release.types['schema:MediaObject'];
    delete release.types['rezics:ReleaseGroup'];
  }
  return release;
}

function statement(
  id: string,
  property: string,
  datatype: string,
  value: SubjectRead['subject']['statements'][string][number]['value'],
  digest: string,
  extras: Partial<SubjectRead['subject']['statements'][string][number]> = {},
): SubjectRead['subject']['statements'][string][number] {
  return {
    id,
    rank: 'normal',
    property: { id: property, data_type: datatype as never },
    value,
    qualifiers: [],
    references: [],
    rezics: { release: digest, revision: 1 },
    ...extras,
  };
}

export function releaseFidelityFixture(scenario: ReleaseFidelityScenario = 'ready', locale = 'en', population = 2) {
  const digest = definitions.digest;
  const release = withConcreteReleaseDescriptors(definitions.release as Release, scenario !== 'not-release');
  let active = scenario;
  const calls: { method: string; path: string; query: string; authorization: string | null; session: string | null }[] =
    [];
  const receipts = new Map<string, unknown>();
  const publicRead: SubjectRead = {
    subject: {
      id: releaseSubject,
      type: scenario === 'not-release' ? 'schema:Book' : 'bf:Instance',
      revision: 1,
      release: digest,
      context: candidateContext,
      labels: { en: 'Japanese paperback', ja: '文庫' },
      descriptions: {},
      aliases: {},
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [{ name: 'Bibliography', url: 'https://catalogue.example/release' }],
    },
    related: {},
    account: null,
    summary: null,
  };
  if (scenario !== 'not-release') {
    publicRead.subject.statements['schema:exampleOfWork'] = [
      statement(
        '00000000-0000-4000-8000-00000000a111',
        'schema:exampleOfWork',
        'wikibase-item',
        { type: 'value', content: releaseWork },
        digest,
        {
          qualifiers: [
            {
              property: { id: 'wdt:P31', data_type: 'wikibase-item' as const },
              value: { type: 'value' as const, content: releaseCompleteness },
            },
          ],
        },
      ),
    ];
    publicRead.subject.statements['schema:inLanguage'] = [
      statement(
        '00000000-0000-4000-8000-00000000a112',
        'schema:inLanguage',
        'string',
        { type: 'value', content: 'ja' },
        digest,
      ),
    ];
    publicRead.subject.statements['schema:isbn'] = [
      statement(
        '00000000-0000-4000-8000-00000000a113',
        'schema:isbn',
        'external-id',
        { type: 'value', content: '978-4-00-000000-0' },
        digest,
      ),
    ];
    if (scenario === 'tba')
      publicRead.subject.statements['schema:datePublished'] = [
        statement(
          '00000000-0000-4000-8000-00000000a114',
          'schema:datePublished',
          'time',
          { type: 'somevalue' },
          digest,
        ),
      ];
    else if (scenario === 'partial-date')
      publicRead.subject.statements['schema:datePublished'] = [
        statement(
          '00000000-0000-4000-8000-00000000a114',
          'schema:datePublished',
          'time',
          {
            type: 'value',
            content: {
              time: '+2004-00-00T00:00:00Z',
              precision: 9,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            },
          },
          digest,
        ),
      ];
    else if (scenario !== 'absent-date')
      publicRead.subject.statements['schema:datePublished'] = [
        statement(
          '00000000-0000-4000-8000-00000000a114',
          'schema:datePublished',
          'time',
          {
            type: 'value',
            content: {
              time: '+2004-10-15T00:00:00Z',
              precision: 11,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            },
          },
          digest,
        ),
      ];
    if (scenario === 'unreadable-work') publicRead.related = {};
    else if (scenario === 'concealed-work') publicRead.related = { [releaseWork]: { type: 'schema:Book', labels: {} } };
    else
      publicRead.related = {
        [releaseWork]: { type: 'schema:Book', labels: { en: 'The Traveller', ja: '旅人' } },
        [releaseCompleteness]: { type: 'skos:Concept', labels: { en: 'Complete' } },
      };
  }
  const relatedId = (index: number) => `00000000-0000-4000-8000-${(0xa103 + index).toString(16).padStart(12, '0')}`;
  function relationPage(property: string, cursor?: string | null) {
    const start = cursor ? Number(cursor) : 0;
    const count = Math.min(RELEASE_ASSOCIATION_LIMIT, Math.max(0, population - start));
    const relations = Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      const id = relatedId(index === 21 ? 20 : index);
      const concealed = index % 11 === 10 && index !== 21;
      const label = concealed
        ? undefined
        : {
            value: index === 0 ? 'English hardcover' : index >= 20 ? 'Repeated hardcover' : `Edition ${index}`,
            language: 'en',
          };
      return {
        statement: statement(
          `00000000-0000-4000-8000-${(0xa200 + index).toString(16).padStart(12, '0')}`,
          property,
          'wikibase-item',
          { type: 'value', content: id },
          index === 1 || index === 20 ? 'sha256:historical' : digest,
          {
            qualifiers:
              index === 0 || index === 20
                ? [
                    {
                      property: { id: 'schema:sameAs', data_type: 'url' as const },
                      value: { type: 'value' as const, content: index === 0 ? 'anidb:rel:9999' : 'anidb:rel:0020' },
                    },
                  ]
                : [],
          },
        ),
        summary: {
          id,
          type: 'bf:Instance',
          types: ['bf:Instance'],
          label,
          creativeWork: true,
          cover: null,
        },
        related: {
          [id]: {
            type: 'bf:Instance',
            types: ['bf:Instance'],
            label,
          },
        },
      };
    });
    const next = start + count < population ? String(start + count) : null;
    return { relations, next, count: { value: population, exact: true } };
  }
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'rezics-session-token': 'release-session' } });
  const client = createKernelClient('https://release-fidelity.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      if (active === 'denied') return json({}, 403);
      if (active === 'unavailable') return json({}, 503);
      if (url.pathname.startsWith('/v1/definitions/releases/')) {
        if (active === 'stale') return json({ digest: 'sha256:changed', release });
        return json({ digest, release });
      }
      if (request.method === 'GET' && url.pathname === `/v1/subjects/${releaseSubject}`) {
        if (active === 'stale') return json({ ...publicRead, subject: { ...publicRead.subject, id: releaseAlt } });
        return json(publicRead);
      }
      if (url.pathname === `/v1/subjects/${releaseSubject}/relations` && request.method === 'GET') {
        const property = url.searchParams.get('property') ?? '';
        if (property !== basedOnProperty) return json({ relations: [], next: null, count: { value: 0, exact: true } });
        return json(relationPage(property, url.searchParams.get('cursor')));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/subjects/')) {
        const id = url.pathname.split('/')[3]!;
        if (active === 'detail-unavailable') return json({}, 503);
        const listed = [...Array(population).keys()].some((index) => relatedId(index) === id);
        if (!listed) return json({}, 404);
        const detailLabel =
          id === releaseAlt ? 'English hardcover' : id === relatedId(20) ? 'Repeated hardcover' : 'Related edition';
        return json({
          subject: {
            ...structuredClone(publicRead.subject),
            id,
            type: 'bf:Instance',
            labels: { en: detailLabel },
            statements: {
              'schema:inLanguage': [
                statement(
                  '00000000-0000-4000-8000-00000000a115',
                  'schema:inLanguage',
                  'string',
                  { type: 'value', content: id === releaseAlt ? 'en' : 'fr' },
                  digest,
                ),
              ],
              'schema:datePublished': [
                statement(
                  '00000000-0000-4000-8000-00000000a116',
                  'schema:datePublished',
                  'time',
                  {
                    type: 'value',
                    content: {
                      time: id === releaseAlt ? '+2014-05-00T00:00:00Z' : '+2019-11-00T00:00:00Z',
                      precision: 10,
                      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
                    },
                  },
                  digest,
                ),
              ],
              'schema:isbn': [
                statement(
                  '00000000-0000-4000-8000-00000000a117',
                  'schema:isbn',
                  'external-id',
                  { type: 'value', content: id === releaseAlt ? '978-0-00-000000-0' : '978-1-11-000020-0' },
                  digest,
                ),
              ],
            },
          },
          related: {},
          account: null,
          summary: null,
        });
      }
      if (url.pathname === `/v1/subjects/${releaseSubject}/candidates` && request.method === 'POST') {
        const key = request.headers.get('idempotency-key');
        if (key && receipts.has(key)) return json(receipts.get(key), 201);
        if (active === 'stale') return json({ code: 'stale_editorial_head' }, 409);
        const result = { candidate: '00000000-0000-4000-8000-00000000a199', revision: 2 };
        if (key) receipts.set(key, result);
        return json(result, 201);
      }
      return json({}, 404);
    }) as typeof fetch,
  });
  return {
    client,
    release,
    digest,
    publicRead,
    calls,
    receipts,
    population,
    setScenario: (value: ReleaseFidelityScenario) => {
      active = value;
    },
    read: (stream?: string, cursor?: string, detail?: string, session?: string) =>
      readReleaseFidelity(client, 'Bearer contributor', {
        id: releaseSubject,
        locale,
        stream,
        cursor,
        detail,
        session,
      }),
    propose: (command: Parameters<typeof proposeFact>[2]) => proposeFact(client, 'Bearer contributor', command),
  };
}

export const routes: FakeRoute[] = [];
