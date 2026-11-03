import type { KernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import {
  parseNativeContextDirectoryPage,
  parseNativeContextLifecycle,
} from '../../community/setup-context-native';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { ContextDirectoryApi } from './directory-api';
import {
  parseCommand,
  contextId,
  unavailable,
  type Actions,
  type Command,
  type ContextDto,
  type DirectoryInput,
  type DirectoryWorkspace,
  type Failure,
  type MutationResult,
  type Result,
  type Workspace,
} from './model';

function continuity(headers?: HeadersInit): { session?: string } {
  const session = new Headers(headers).get('rezics-session-token');
  return session ? { session } : {};
}
/** Problems contribute only their public status/code, never private labels, explanations or owner history. */
export function failure(status: number, body?: unknown, mutation = false): Failure {
  const code = body && typeof body === 'object' ? Reflect.get(body, 'code') : undefined;
  if (status === 401) return { kind: 'signed-out' };
  if (status === 403) return { kind: 'denied' };
  if (status === 404 && code === 'not_found') return { kind: 'missing' };
  if (code === 'invalid_cursor' || code === 'stale_cursor') return { kind: 'stale' };
  if (status === 409 || status === 412 || code === 'idempotency_conflict') return { kind: 'conflict' };
  if (status === 400 || status === 422) return { kind: 'invalid' };
  return { kind: mutation ? 'unknown' : 'unavailable' };
}
function caught(error: unknown, mutation = false): Failure {
  return isPlatformClosedError(error) ? { kind: 'denied' } : { kind: mutation ? 'unknown' : 'unavailable' };
}
/** Generated GET /v1/contexts and GET /v1/contexts/{id}/lifecycle. No catalogue scan or ownership list. */
export function kernelContextDirectory(client: KernelClient): ContextDirectoryApi {
  return {
    async list(input, headers) {
      try {
        const response = await client.contexts.get({
          query: {
            ...(input.query ? { query: input.query } : {}),
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            deleted: input.deleted,
          },
          headers,
        });
        if (response.status !== 200 || !response.data)
          return { ...failure(response.status, response.error?.value), ...continuity(response.headers) };
        const page = parseNativeContextDirectoryPage(response.data);
        return page
          ? { kind: 'ready', value: page, ...continuity(response.headers) }
          : { ...unavailable, ...continuity(response.headers) };
      } catch (error) {
        return caught(error);
      }
    },
    async lifecycle(id, headers) {
      try {
        const response = await client.contexts({ id }).lifecycle.get({ headers });
        if (response.status !== 200 || !response.data)
          return { ...failure(response.status, response.error?.value), ...continuity(response.headers) };
        const entry = parseNativeContextLifecycle(response.data);
        return entry && entry.id === id
          ? { kind: 'ready', value: entry, ...continuity(response.headers) }
          : { ...unavailable, ...continuity(response.headers) };
      } catch (error) {
        return caught(error);
      }
    },
  };
}
export function createContextApi(
  client: KernelClient,
  authorization: string,
  directory: ContextDirectoryApi = kernelContextDirectory(client),
) {
  const headers = (session?: string): Record<string, string> => ({
    authorization,
    ...(session ? { 'rezics-session-token': session } : {}),
  });
  async function actions(id: string, session?: string): Promise<Result<Actions>> {
    try {
      const response = await client.viewerActions.post(
        { resources: [{ type: 'semantic.context', id }] },
        { headers: headers(session) },
      );
      if (response.status !== 200 || !response.data) return failure(response.status, response.error?.value);
      const resource = response.data.resources.find((entry) => entry.type === 'semantic.context' && entry.id === id);
      // A missing precise resolver is unavailable. It never implies creator authority or a grant.
      return resource && 'viewerActions' in resource
        ? { kind: 'ready', value: resource.viewerActions, ...continuity(response.headers) }
        : unavailable;
    } catch (error) {
      return caught(error);
    }
  }
  async function read(id: string, session?: string): Promise<Result<ContextDto>> {
    try {
      const response = await client.contexts({ id }).get({ headers: headers(session) });
      if (response.status !== 200 || !response.data)
        return { ...failure(response.status, response.error?.value), ...continuity(response.headers) };
      return response.data.context.id === id
        ? { kind: 'ready', value: response.data.context, ...continuity(response.headers) }
        : unavailable;
    } catch (error) {
      return caught(error);
    }
  }
  async function detail(id: string, session?: string): Promise<Result<Workspace>> {
    try {
      const [context, lifecycle, permissions] = await Promise.all([
        read(id, session),
        directory.lifecycle(id, headers(session)),
        actions(id, session),
      ]);
      for (const result of [context, lifecycle, permissions])
        if (result.kind === 'signed-out' || result.kind === 'denied') return result;
      const token = context.session ?? lifecycle.session ?? permissions.session ?? session;
      const next = token ? { session: token } : {};
      if (lifecycle.kind === 'ready' && lifecycle.value.id !== id) return unavailable;
      if (context.kind === 'ready') {
        if (lifecycle.kind === 'missing') return lifecycle;
        if (
          lifecycle.kind === 'ready' &&
          (lifecycle.value.state !== 'active' || lifecycle.value.kind !== context.value.kind)
        )
          return { kind: 'conflict', ...next };
        return {
          kind: 'ready',
          value: {
            context: context.value,
            lifecycle: lifecycle.kind === 'ready' ? lifecycle.value : null,
            actions: permissions,
            lifecycleUnavailable: lifecycle.kind !== 'ready',
          },
          ...next,
        };
      }
      if (context.kind === 'missing' && lifecycle.kind === 'ready' && lifecycle.value.state === 'deleted')
        return {
          kind: 'ready',
          value: { context: null, lifecycle: lifecycle.value, actions: permissions, lifecycleUnavailable: false },
          ...next,
        };
      return { ...context, ...next };
    } catch (error) {
      return caught(error);
    }
  }
  async function list(input: DirectoryInput): Promise<DirectoryWorkspace> {
    const [page, creation] = await Promise.all([
      directory.list(input, headers()).catch(() => unavailable),
      actions(PAGE_GLOBAL_CONTEXT),
    ]);
    const denied = [page, creation].find((result) => result.kind === 'signed-out' || result.kind === 'denied');
    return denied && denied.kind !== 'ready' ? { page: denied, creation: denied } : { page, creation };
  }
  async function submit(input: Command): Promise<MutationResult> {
    let command: Command;
    try {
      command = parseCommand(input);
    } catch {
      return { kind: 'invalid' };
    }
    const options = { headers: { ...headers(command.session), 'idempotency-key': JSON.stringify(command.key) } };
    try {
      let id: string;
      let session: string | undefined;
      if (command.operation === 'create') {
        const response = await client.contexts.post({ labels: { ...command.labels } }, options);
        if (response.status !== 201 || !response.data)
          return { ...failure(response.status, response.error?.value, true), ...continuity(response.headers) };
        id = response.data.context.id;
        if (!contextId.test(id) || response.data.context.kind !== 'community') return { kind: 'unknown' };
        session = continuity(response.headers).session;
      } else {
        const endpoint = client.contexts({ id: command.id });
        const response =
          command.operation === 'delete'
            ? await endpoint.delete(undefined, options)
            : await endpoint.$restore.post({}, options);
        if (response.status !== 200 || !response.data)
          return { ...failure(response.status, response.error?.value, true), ...continuity(response.headers) };
        id = response.data.context.id;
        if (
          id !== command.id ||
          response.data.context.state !== (command.operation === 'delete' ? 'deleted' : 'active')
        )
          return { kind: 'unknown' };
        session = continuity(response.headers).session;
      }
      // A native write response confirms the command, not a cached permission or successful current reading.
      const current = await detail(id, session ?? command.session);
      return { kind: 'confirmed', id, operation: command.operation, current, ...(session ? { session } : {}) };
    } catch (error) {
      return caught(error, true);
    }
  }
  return { list, detail, submit, creation: () => actions(PAGE_GLOBAL_CONTEXT) };
}
