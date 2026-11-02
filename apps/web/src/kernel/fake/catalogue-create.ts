import { createKernelClient, type SubjectRead } from '@rezics/client';
import {
  createTypes,
  type CreateSubjectCommand,
  type CreateTransport,
  type InitialSubject,
} from '../../features/catalogue/create-subject';
import { createSubjectRecord, readCreatedSubject } from '../../features/catalogue/create-subject-request';
import type { SessionEnv } from '../../session/client';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';

export const catalogueCreatedId = '00000000-0000-4000-8000-00000000c001';
export type CreateScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'definitions-unavailable'
  | 'cursor-changed'
  | 'signed-out'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'uncertain'
  | 'saving'
  | 'reader-unavailable'
  | 'concealed'
  | 'mismatched';
type Call = {
  method: string;
  path: string;
  authorization: string | null;
  session: string | null;
  key: string | null;
  body: unknown;
};

/** Two endpoints and native-shaped responses, shared by focused requests and page interactions. No selected facts. */
export function catalogueCreateFixture(scenario: CreateScenario = 'ready', locale = 'en') {
  const calls: Call[] = [];
  const receipts = new Map<string, InitialSubject>();
  let item: InitialSubject | undefined;
  let activeScenario = scenario;
  let definitionReads = 0;
  let directoryReads = 0;
  let refreshes = 0;
  let lost = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'created-session' },
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
      if (request.method === 'POST' && path === '/v1/subjects') {
        if (activeScenario === 'saving') return new Promise<Response>(() => {});
        if (activeScenario === 'denied') return json({ code: 'forbidden' }, 403);
        if (activeScenario === 'signed-out') return json({ code: 'authentication_required' }, 401);
        if (activeScenario === 'invalid')
          return json({ code: 'invalid_request', errors: [{ pointer: '/labels/en', code: 'invalid_format' }] }, 400);
        if (activeScenario === 'conflict') return json({ code: 'idempotency_conflict' }, 422);
        item = receipts.get(key!) ?? (body as InitialSubject);
        receipts.set(key!, item);
        if (activeScenario === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json({ subject: subject() }, 201);
      }
      if (request.method === 'GET' && path === `/v1/subjects/${catalogueCreatedId}`) {
        if (activeScenario === 'reader-unavailable') return json({ code: 'semantic_not_ready' }, 503);
        if (activeScenario === 'concealed') return json({ code: 'not_found' }, 404);
        return json({
          subject: {
            ...subject(),
            ...(activeScenario === 'mismatched' ? { id: '00000000-0000-4000-8000-00000000c002' } : {}),
          },
          account: null,
          summary: null,
          related: {},
        } satisfies SubjectRead);
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });

  function subject(): SubjectRead['subject'] {
    return {
      id: catalogueCreatedId,
      type: item?.type ?? 'schema:Movie',
      revision: 1,
      release: definitions.digest,
      context: '00000000-0000-8000-8000-000000000000',
      labels: item?.labels ?? {},
      descriptions: item?.descriptions ?? {},
      aliases: item?.aliases ?? {},
      resolution: {},
      relationCounts: {},
      statements: {},
      sourceRecords: [],
    };
  }
  const request = () =>
    new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } });
  const directoryTypes = () =>
    (activeScenario === 'empty' ? [] : createTypes(definitions.release, locale)).map((type) => ({
      ...type,
      labelLanguage: locale,
      ...(type.description ? { descriptionLanguage: locale } : {}),
    }));
  const transport: CreateTransport = {
    definitions: async (refresh = false) => {
      definitionReads++;
      if (refresh) refreshes++;
      if (activeScenario === 'loading') return new Promise(() => {});
      if (activeScenario === 'definitions-unavailable' && definitionReads === 1) return { ok: false };
      return { ok: true, types: activeScenario === 'empty' ? [] : createTypes(definitions.release, locale) };
    },
    typeDirectory: {
      page: async (input) => {
        directoryReads++;
        if (activeScenario === 'loading') return new Promise(() => {});
        if (activeScenario === 'definitions-unavailable' && directoryReads === 1)
          return { ok: false, reason: 'unavailable' };
        if (activeScenario === 'cursor-changed' && input.cursor !== undefined) return { ok: false, reason: 'stale' };
        const types = directoryTypes();
        if (input.typeId !== undefined) {
          return { ok: true, types: types.filter((type) => type.id === input.typeId), next: null };
        }
        const matching = types
          .filter((type) => type.label.startsWith(input.query ?? ''))
          .sort((a, b) =>
            a.id === 'schema:Movie' ? -1 : b.id === 'schema:Movie' ? 1 : a.label.localeCompare(b.label),
          );
        const after = input.cursor ? Number(input.cursor) : 0;
        return {
          ok: true,
          types: matching.slice(after, after + 1),
          next: after + 1 < matching.length ? String(after + 1) : null,
        };
      },
      descriptor: async (typeId) => {
        if (activeScenario === 'loading') return new Promise(() => {});
        const type = directoryTypes().find((entry) => entry.id === typeId);
        return type ? { ok: true, type } : { ok: false, reason: 'missing' };
      },
    },
    submit: (command: CreateSubjectCommand) =>
      createSubjectRecord(client, request(), {} as Partial<SessionEnv>, command, locale),
    read: (id) => readCreatedSubject(client, id, locale),
  };
  return {
    client,
    transport,
    calls,
    receipts,
    setScenario: (next: CreateScenario) => {
      activeScenario = next;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

// This module supplies an isolated typed request seam; it does not intercept unrelated application fake routes.
export const routes: FakeRoute[] = [];
