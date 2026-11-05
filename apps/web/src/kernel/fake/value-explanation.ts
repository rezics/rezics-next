import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import definitions from '../recorded/definitions-release.json';
import { catalogueSourcesFixture } from './catalogue-sources';
import { readValueExplanation, type ValueTransport } from '../../features/catalogue/value-explanation';

export type ValueScenario =
  | 'selected'
  | 'paged'
  | 'review-denied'
  | 'review-error'
  | 'unresolved'
  | 'not-selected'
  | 'somevalue'
  | 'novalue'
  | 'concealed'
  | 'error'
  | 'loading'
  | 'document';
export const valueCursor = 'opaque:+/review?=next';
export const valueLastCursor = 'opaque:/review?=last';

/** Generated-client response examples for this consumer; no runtime producer or mutation is installed. */
export function valueExplanationFixture(scenario: ValueScenario = 'selected', locale = 'en') {
  const { id, read } = catalogueSourcesFixture();
  const property = scenario === 'document' ? 'schema:abstract' : 'schema:isbn';
  const selected = read.subject.statements['schema:isbn']![0]!;
  selected.property.id = property;
  selected.id = '00000000-0000-8000-8000-000000000025';
  selected.rank = 'preferred';
  selected.rezics = { release: definitions.digest, revision: 2 };
  selected.qualifiers = [
    {
      property: { id: 'schema:name', data_type: 'monolingualtext' },
      value: { type: 'value', content: { text: 'Édition originale', language: 'fr' } },
    },
  ];
  if (scenario === 'somevalue' || scenario === 'novalue') selected.value = { type: scenario };
  if (scenario === 'document') {
    selected.property.data_type = 'document';
    selected.value = {
      type: 'value',
      content: {
        document: '00000000-0000-8000-8000-000000000026',
        digest: 'sha256:unavailable',
        language: 'en',
      },
    };
  }
  const alternative = structuredClone(selected);
  alternative.id = '00000000-0000-8000-8000-000000000027';
  alternative.rank = 'normal';
  alternative.value = { type: 'value', content: 'UNSELECTED PRIVATE ALTERNATIVE' };
  read.subject.statements = { [property]: [alternative, selected] };
  read.subject.revision = 99;
  read.subject.release = definitions.digest;
  read.subject.sourceRecords = [];
  const address = { id, property, statement: selected.id, context: read.subject.context, locale };
  if (scenario === 'unresolved' || scenario === 'not-selected') {
    read.subject.statements = {};
    if (scenario === 'unresolved') read.subject.resolution[property] = 'unresolved';
  }
  const calls: {
    path: string;
    cursor: string | null;
    authorization: string | null;
    session: string | null;
    query: string;
    method: string;
  }[] = [];
  const client = createKernelClient('http://value.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        cursor: url.searchParams.get('cursor'),
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
        query: url.search,
        method: request.method,
      });
      const json = (body: unknown, status = 200) =>
        Response.json(body, {
          status,
          headers: { 'rezics-session-token': 'value-session' },
        });
      if (url.pathname === `/v1/subjects/${id}`) {
        if (scenario === 'loading') return new Promise<Response>(() => {});
        return scenario === 'concealed'
          ? json({ code: 'not_found' }, 404)
          : scenario === 'error'
            ? json({ code: 'overloaded' }, 503)
            : json(read);
      }
      if (decodeURIComponent(url.pathname) === `/v1/definitions/releases/${definitions.digest}`)
        return json(definitions);
      // Preserve this fixture's unavailable-detail outcome through the bound native client.
      if (url.pathname === `/v1/subjects/${id}/revisions/${selected.rezics.revision}`)
        return json({ code: 'overloaded' }, 503);
      if (url.pathname !== `/v1/subjects/${id}/candidates`) return json({ code: 'not_found' }, 404);
      if (scenario === 'review-denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'review-error') return json({ code: 'overloaded' }, 503);
      const cursor = url.searchParams.get('cursor');
      const candidate = (statement: typeof selected, revision: number) => ({
        id: statement.id,
        statement,
        release: definitions.digest,
        revision,
        decision: 'accepted',
        rank: 'normal',
        source: { source: 'PRIVATE SOURCE', external_id: 'PRIVATE RECORD' },
        retracted: null,
        retraction: null,
        head: 8,
      });
      return json(
        scenario === 'paged' && cursor !== valueLastCursor
          ? {
              candidates: cursor === valueCursor ? [] : [candidate(alternative, 90)],
              adoption: { mode: 'replace', head: 10 },
              next: cursor === valueCursor ? valueLastCursor : valueCursor,
            }
          : {
              candidates: [candidate(alternative, 90), candidate(selected, 2)],
              adoption: { mode: 'replace', head: 10 },
              next: null,
            },
      );
    }) as typeof fetch,
  });
  const transport: ValueTransport = (cursor, session) =>
    readValueExplanation(
      client,
      {
        ...address,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(session ? { session } : {}),
      },
      { authorization: 'Bearer value-viewer' },
    );
  return {
    id,
    property,
    read,
    selected,
    address,
    client,
    calls,
    transport,
    inlineDocument: () => {
      selected.value = {
        type: 'value',
        content: {
          document: fromPlainText('Authorized original words'),
          language: 'en',
        },
      };
    },
  };
}
