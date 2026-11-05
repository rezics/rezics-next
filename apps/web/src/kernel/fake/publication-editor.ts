import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  createPublication,
  readPublicationEditor,
  type PublicationItem,
  type PublicationTransport,
} from '../../features/catalogue/publication-editor';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';
import recording from '../recorded/subject.json';

export const publicationCreatedId = '00000000-0000-4000-8000-00000000e001';
export type PublicationScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'unavailable'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'uncertain'
  | 'saving'
  | 'concealed'
  | 'reader-unavailable'
  | 'reader-concealed';

/** Isolated declared examples for stories and focused request tests, never an application mutation fallback. */
export function publicationFixture(scenario: PublicationScenario = 'ready', locale = 'en', workType = 'schema:Book') {
  const work = structuredClone(recording) as unknown as SubjectRead;
  work.subject.type = workType;
  const release = structuredClone(definitions.release) as Release;
  const calls: {
    method: string;
    path: string;
    body: unknown;
    key: string | null;
    authorization: string | null;
    session: string | null;
  }[] = [];
  const receipts = new Map<string, PublicationItem>();
  let activeScenario = scenario;
  let item: PublicationItem | undefined;
  let lost = false;
  let reads = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'publication-session' },
    });
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      const body: unknown = request.method === 'POST' ? await request.json() : null;
      const key = request.headers.get('idempotency-key');
      calls.push({
        method: request.method,
        path,
        body,
        key,
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      if (path === '/v1/definitions/active') return json({ digest: definitions.digest });
      if (path === `/v1/definitions/releases/${encodeURIComponent(definitions.digest)}`)
        return json({ digest: definitions.digest, release });
      if (request.method === 'GET' && path === `/v1/subjects/${work.subject.id}`) {
        if (activeScenario === 'loading') return new Promise<Response>(() => {});
        if (activeScenario === 'concealed') return json({ code: 'not_found' }, 404);
        if (activeScenario === 'unavailable' && reads++ === 0) return json({ code: 'semantic_not_ready' }, 503);
        return json(work);
      }
      if (request.method === 'POST' && path === '/v1/subjects') {
        if (activeScenario === 'saving') return new Promise<Response>(() => {});
        if (activeScenario === 'denied') return json({ code: 'forbidden' }, 403);
        if (activeScenario === 'invalid')
          return json(
            {
              code: 'invalid_request',
              errors: [{ pointer: '/statements/schema:isbn/0/value/content', code: 'invalid_format' }],
            },
            400,
          );
        if (activeScenario === 'conflict') return json({ code: 'idempotency_conflict' }, 422);
        item = receipts.get(key!) ?? (body as PublicationItem);
        receipts.set(key!, item);
        if (activeScenario === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json({ subject: created() }, 201);
      }
      if (request.method === 'GET' && path === `/v1/subjects/${publicationCreatedId}`) {
        if (activeScenario === 'reader-unavailable') return json({ code: 'semantic_not_ready' }, 503);
        if (activeScenario === 'reader-concealed') return json({ code: 'not_found' }, 404);
        return json({
          subject: created(),
          account: null,
          summary: null,
          related: { [work.subject.id]: { labels: work.subject.labels, type: workType } },
        } satisfies SubjectRead);
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  function created(): SubjectRead['subject'] {
    return {
      ...structuredClone(work.subject),
      id: publicationCreatedId,
      type: item?.type ?? 'bf:Instance',
      revision: 1,
      labels: item?.labels ?? {},
      descriptions: item?.descriptions ?? {},
      aliases: item?.aliases ?? {},
      relationCounts: {},
      resolution: {},
      statements: Object.fromEntries(
        Object.entries(item?.statements ?? {}).map(([property, entries]) => [
          property,
          entries.map((entry, index) => ({
            ...structuredClone(entry),
            id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            rank: entry.rank ?? 'normal',
            property: { id: property, data_type: release.properties[property]!.datatype },
            qualifiers: (entry.qualifiers ?? []).map((part) => ({
              ...part,
              property: { ...part.property, data_type: release.properties[part.property.id]!.datatype },
            })),
            references: entry.references.map((reference) => ({
              hash: 'citation',
              parts: reference.parts.map((part) => ({
                ...part,
                property: { ...part.property, data_type: release.properties[part.property.id]!.datatype },
              })),
            })),
            rezics: { release: definitions.digest, revision: 1 },
          })),
        ]),
      ),
    };
  }
  if (scenario === 'empty') delete release.types['bf:Instance'];
  const transport: PublicationTransport = {
    load: () => readPublicationEditor(client, work.subject.id, locale),
    submit: (command) =>
      createPublication(
        client,
        new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
        {},
        command,
        locale,
      ),
    read: (id) => readCreatedSubject(client, id, locale),
  };
  return {
    work,
    release,
    client,
    transport,
    calls,
    receipts,
    setScenario: (next: PublicationScenario) => {
      activeScenario = next;
    },
  };
}

export const routes: FakeRoute[] = [];
