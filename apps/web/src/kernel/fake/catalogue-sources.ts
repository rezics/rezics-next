import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { SourceDefinitions } from '../../features/catalogue/subject-sources';
import recording from '../recorded/subject.json';
import release from '../recorded/definitions-release.json';
import {
  recordedSelectedSynopsisRead,
  recordedSelectedSynopsisSelection,
  type RecordedSelectedSynopsisKind,
} from '../recorded/selected-synopsis';

export type SourcesScenario =
  | 'selected-facts'
  | 'no-citations'
  | 'partial-metadata'
  | 'empty'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'unavailable';
export const sourceDefinitions = release.release as unknown as SourceDefinitions;
export const citationUrl = 'https://catalogue.example.test/books/prince';
export { recordedSelectedSynopsisSelection, recordedSelectedSynopsisRead };

export type CatalogueSourcesExact = Exclude<RecordedSelectedSynopsisKind, 'empty'>;

/** A generated Subject DTO story seam; runtime availability still requires native proof. */
export function catalogueSourcesFixture(
  scenario: SourcesScenario = 'selected-facts',
  options: { exact?: CatalogueSourcesExact } = {},
) {
  const read = structuredClone(recording) as unknown as SubjectRead;
  const id = read.subject.id;
  const citation = {
    hash: 'not-a-user-label',
    parts: [
      {
        property: { id: 'schema:url', data_type: 'url' as const },
        value: { type: 'value' as const, content: citationUrl },
      },
    ],
  };
  const fact = (property: string, datatype: 'external-id' | 'time', content: unknown) => ({
    id: crypto.randomUUID(),
    rank: 'normal' as const,
    property: { id: property, data_type: datatype },
    value: { type: 'value' as const, content },
    qualifiers: [],
    references: scenario === 'no-citations' ? [] : [citation],
    rezics: { release: read.subject.release, revision: 1 },
  });
  read.subject.statements =
    scenario === 'empty'
      ? {}
      : {
          'schema:datePublished': [
            fact('schema:datePublished', 'time', {
              time: '+1943-04-06T00:00:00Z',
              precision: 11,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            }),
          ],
          'schema:isbn': [fact('schema:isbn', 'external-id', '9780156012195')],
        };
  // Reuse returned cover credit while keeping the detailed page free of media fetching.
  read.subject.sourceRecords =
    scenario === 'no-citations' || scenario === 'empty'
      ? []
      : [
          {
            name: 'Reviewed bibliography',
            url: citationUrl,
            ...(scenario !== 'partial-metadata'
              ? {
                  licence: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
                  attribution: 'Bibliography contributors',
                }
              : {}),
          },
        ];
  let exact = options.exact;
  const applyExact = () => {
    if (!exact) {
      delete read.selectedSynopsis;
      return;
    }
    const recorded = recordedSelectedSynopsisRead(exact);
    read.subject.statements['schema:abstract'] = structuredClone(recorded.subject.statements['schema:abstract'] ?? []);
    read.selectedSynopsis = recorded.selectedSynopsis;
  };
  applyExact();
  const calls: { path: string; authorization: string | null; session: string | null }[] = [];
  let outcome = scenario;
  const client = createKernelClient('http://sources.test', {
    session: 'sources-session',
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      calls.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      const status =
        outcome === 'denied'
          ? 401
          : outcome === 'invalid'
            ? 400
            : outcome === 'conflict'
              ? 409
              : outcome === 'unavailable'
                ? 503
                : 200;
      return new Response(JSON.stringify(status === 200 ? read : { type: 'about:blank', status }), {
        status,
        headers: { 'content-type': 'application/json', 'rezics-session-token': 'current-sources-session' },
      });
    }) as typeof fetch,
  });
  return {
    id,
    read,
    client,
    calls,
    recover: () => {
      outcome = 'selected-facts';
      if (exact) exact = 'matched';
      applyExact();
    },
  };
}

export const routes = [];
