import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { createContextApi } from './api';
import type { ContextDirectoryApi } from './directory-api';
import {
  unavailable,
  type Actions,
  type ContextDirectoryEntry,
  type ContextDto,
  type DirectoryInput,
  type DirectoryPage,
  type DirectoryWorkspace,
  type Result,
  type Workspace,
} from './model';

export const fixtureId = '018f1234-5678-7000-8000-000000000021';
export type Scenario =
  | 'directory'
  | 'empty'
  | 'deleted'
  | 'active'
  | 'global'
  | 'read-only'
  | 'permission-unavailable'
  | 'revoked'
  | 'conflict'
  | 'expired'
  | 'hold'
  | 'unknown'
  | 'unavailable'
  | 'stale'
  | 'create'
  | 'create-denied'
  | 'reread-unavailable';
export type Call = { method: string; path: string; query: string; headers: Headers; body: unknown };
const allActions: Actions = ['create', 'delete', 'restore'].map((operation) => ({
  action: `context:${operation}`,
  operations: [`context.${operation}`],
}));

/** Synthetic contract responses for ordinary story review and focused client tests; no native authority claim. */
export function contextFixture(scenario: Scenario = 'directory') {
  let deleted = scenario === 'deleted' || scenario === 'expired' || scenario === 'hold';
  let denied = scenario === 'revoked';
  let unknown = scenario === 'unknown';
  let readUnavailable = false;
  let labels = { en: 'Readers’ selections', ja: '読者の選択' } as Record<string, string>;
  const id = scenario === 'global' ? PAGE_GLOBAL_CONTEXT : fixtureId;
  const calls: Call[] = [];
  const writes = new Map<string, unknown>();
  let createdPolicy:
    | { settings: ContextDto['settings']; defaults: ContextDto['defaults'] }
    | undefined;
  const dto = (): ContextDto => ({
    id,
    kind: scenario === 'global' ? 'global' : 'community',
    labels: { ...labels },
    settings: createdPolicy
      ? createdPolicy.settings
      : { id: 'editorial', release: 'released-settings-digest' },
    defaults: createdPolicy
      ? createdPolicy.defaults
      : { 'core:description': 'inherit', 'core:rating': 'suppress' },
  });
  const entry = (): ContextDirectoryEntry => ({
    id,
    kind: dto().kind,
    labels: { ...labels },
    state: deleted ? 'deleted' : 'active',
    deletedAt: deleted ? '2026-10-01T10:00:00Z' : null,
    purgeAfter: deleted ? '2026-10-31T10:00:00Z' : null,
  });
  const permissions = (): Result<Actions> =>
    scenario === 'permission-unavailable'
      ? unavailable
      : {
          kind: 'ready',
          value: scenario === 'read-only' || scenario === 'create-denied' ? [] : allActions,
        };
  const page = (input: DirectoryInput): Result<DirectoryPage> => {
    if (denied) return { kind: 'missing' };
    if (scenario === 'unavailable') return unavailable;
    if (scenario === 'stale') return { kind: 'stale' };
    const matches =
      !input.query ||
      Object.values(labels).some((label) => label.toLocaleLowerCase().includes(input.query!.toLocaleLowerCase()));
    return {
      kind: 'ready',
      value: {
        contexts: scenario === 'empty' || !matches || input.deleted !== deleted || !!input.cursor ? [] : [entry()],
        next: scenario === 'directory' && !input.cursor ? 'opaque+/page==' : null,
      },
    };
  };
  const directory: ContextDirectoryApi = {
    async list(input, headers) {
      calls.push({
        method: 'GET',
        path: '/v1/contexts',
        query: new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)])).toString(),
        headers: new Headers(headers),
        body: null,
      });
      return page(input);
    },
    async lifecycle(target, headers) {
      calls.push({
        method: 'GET',
        path: `/v1/contexts/${target}/lifecycle`,
        query: '',
        headers: new Headers(headers),
        body: null,
      });
      return denied
        ? { kind: 'missing' }
        : readUnavailable
          ? unavailable
          : { kind: 'ready', value: entry(), session: 'current-context-session' };
    },
  };
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'current-context-session' },
    });
  const client = createKernelClient('https://context-fixture.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body: unknown = request.method === 'GET' || !request.body ? null : await request.json();
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: new Headers(request.headers),
        body,
      });
      if (url.pathname === '/v1/viewerActions') {
        if (scenario === 'permission-unavailable') return response({ code: 'overloaded' }, 503);
        const resource = (body as { resources: { id: string }[] }).resources[0]!;
        return response({
          resources: [
            {
              type: 'semantic.context',
              id: resource.id,
              ...(denied
                ? { error: 'not_found' }
                : { viewerActions: permissions().kind === 'ready' ? (permissions() as { value: Actions }).value : [] }),
            },
          ],
        });
      }
      if (request.method === 'GET')
        return denied || deleted
          ? response({ code: 'not_found' }, 404)
          : readUnavailable
            ? response({ code: 'overloaded' }, 503)
            : response({ context: dto() });
      // Even idempotent replay rechecks current native authority in this fixture.
      if (denied || scenario === 'read-only' || scenario === 'create-denied' || scenario === 'global')
        return response({ code: 'forbidden' }, 403);
      if (scenario === 'conflict' || scenario === 'expired' || scenario === 'hold')
        return response({ code: 'conflict' }, 409);
      const key = request.headers.get('idempotency-key') ?? '';
      const prior = writes.get(key);
      if (prior) return response(prior, url.pathname === '/v1/contexts' ? 201 : 200);
      let result: unknown;
      if (url.pathname === '/v1/contexts') {
        const posted = body as { labels: Record<string, string>; settings?: string };
        labels = { ...posted.labels };
        deleted = false;
        createdPolicy = posted.settings
          ? {
              settings: { id: posted.settings, release: 'released-settings-digest' },
              defaults: { 'core:description': 'inherit', 'core:rating': 'suppress' },
            }
          : { settings: null, defaults: {} };
        result = { context: dto() };
      } else {
        deleted = request.method === 'DELETE';
        result = { context: { id, state: deleted ? 'deleted' : 'active' } };
      }
      writes.set(key, result);
      if (scenario === 'reread-unavailable') readUnavailable = true;
      if (unknown) {
        unknown = false;
        throw new Error('Synthetic response loss after commit');
      }
      return response(result, url.pathname === '/v1/contexts' ? 201 : 200);
    }) as typeof fetch,
  });
  return {
    id,
    api: createContextApi(client, 'Bearer context-fixture', directory),
    client,
    directory,
    calls,
    revoke() {
      denied = true;
    },
    initialDirectory(input: DirectoryInput): DirectoryWorkspace {
      return { page: page(input), creation: permissions() };
    },
    initialCreation: permissions,
    initialDetail(): Result<Workspace> {
      return denied
        ? { kind: 'missing' }
        : scenario === 'unavailable'
          ? unavailable
          : {
              kind: 'ready',
              value: {
                context: deleted ? null : dto(),
                lifecycle: entry(),
                actions: permissions(),
                lifecycleUnavailable: false,
              },
            };
    },
  };
}
