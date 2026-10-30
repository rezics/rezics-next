import type { KernelClient } from '@rezics/client';
import { requestLanguages } from '../../../kernel/languages';
import { isPlatformClosedError } from '../../../kernel/platform-closed';
import type { Release } from '../../../subject/definitions';
import {
  unavailable,
  validRevision,
  type Failure,
  type Loaded,
  type Mutation,
  type Options,
  type Permissions,
  type Preview,
  type Result,
  type ZoneConfigurationResponse,
  type ZoneOwned,
} from './model';

type ResponseLike = { status: number; error?: { value?: unknown } | null; response?: Response };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function failure(result: ResponseLike): Failure {
  const body = result.error?.value;
  const errors =
    record(body) && Array.isArray(body.errors)
      ? body.errors.flatMap((item: unknown) =>
          record(item) && typeof item.pointer === 'string' && typeof item.code === 'string'
            ? [{ pointer: item.pointer, code: item.code }]
            : [],
        )
      : [];
  const retryAfter = result.response?.headers.get('retry-after');
  return {
    kind: 'failure',
    status: result.status,
    code: record(body) && typeof body.code === 'string' ? body.code : 'request_failed',
    ...(errors.length ? { errors } : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}
export function caught(error: unknown): Failure {
  return isPlatformClosedError(error) ? { kind: 'failure', status: 403, code: 'platform_closed' } : unavailable;
}
export async function configuration(
  client: KernelClient,
  id: string,
  authorization: string,
): Promise<Result<ZoneConfigurationResponse>> {
  try {
    const result = await client.zones({ id }).configuration.get({ headers: { authorization } });
    return result.status === 200 && result.data ? { kind: 'ready', value: result.data } : failure(result);
  } catch (error) {
    return caught(error);
  }
}
export async function permissions(client: KernelClient, id: string, authorization: string): Promise<Permissions> {
  try {
    const result = await client.viewerActions.post(
      { resources: [{ type: 'semantic.zone', id }] },
      { headers: { authorization } },
    );
    const resource = result.data?.resources.find((entry) => entry.type === 'semantic.zone' && entry.id === id);
    if (result.status !== 200 || !resource || !('viewerActions' in resource))
      return {
        configure: false,
        publish: false,
        available: false,
        failure:
          result.status !== 200
            ? failure(result)
            : resource && 'error' in resource
              ? { kind: 'failure', status: 404, code: resource.error }
              : unavailable,
      };
    const admits = (action: string, operation: string) =>
      resource.viewerActions.some((entry) => entry.action === action && entry.operations.includes(operation));
    return {
      configure: admits('zone:configure', 'zone.configure'),
      publish: admits('zone:publish', 'zone.publish'),
      available: true,
    };
  } catch (error) {
    return { configure: false, publish: false, available: false, failure: caught(error) };
  }
}
export async function collections(
  client: KernelClient,
  authorization: string,
  cursor?: string,
): Promise<Options['collections']> {
  try {
    const result = await client.collections.get({
      headers: { authorization },
      query: { curatorAccountId: null, limit: 20, ...(cursor ? { cursor } : {}) },
    });
    return result.status === 200 && result.data
      ? {
          kind: 'ready',
          value: {
            items: result.data.collections.map((entry) => ({ id: entry.id, title: entry.title ?? entry.id })),
            next: result.data.next,
          },
        }
      : failure(result);
  } catch (error) {
    return caught(error);
  }
}
export async function scopes(readRelease: () => Promise<Release>): Promise<Options['scopes']> {
  try {
    const release = await readRelease();
    if (!release.digest) return unavailable;
    return { kind: 'ready', value: { release: release.digest, ids: Object.keys(release.filters ?? {}).sort() } };
  } catch (error) {
    return caught(error);
  }
}
/** Independent reads share only this request's current viewer credential. */
export async function loadConfiguration(
  client: KernelClient,
  id: string,
  authorization: string,
  readRelease: () => Promise<Release>,
): Promise<Loaded> {
  const [resource, actions, filters, mounts] = await Promise.all([
    configuration(client, id, authorization),
    permissions(client, id, authorization),
    scopes(readRelease),
    collections(client, authorization),
  ]);
  return { resource, permissions: actions, options: { scopes: filters, collections: mounts } };
}
export async function mutate(client: KernelClient, authorization: string, input: Mutation): Promise<Result<ZoneOwned>> {
  if (!validRevision(input.revision)) return { kind: 'failure', status: 400, code: 'invalid_revision' };
  const headers = { authorization, 'if-match': `"${input.revision}"`, 'idempotency-key': `"${input.key}"` };
  try {
    const route = client.zones({ id: input.id });
    const result =
      input.operation === 'save'
        ? await route.configuration.put(input.body, { headers })
        : await route.$publish.post(input.body, { headers });
    return result.status === 200 && result.data ? { kind: 'ready', value: result.data.zone } : failure(result);
  } catch (error) {
    return caught(error);
  }
}
/** This is the real page operation with the reader credential; configure never supplies a fallback. */
export async function preview(
  client: KernelClient,
  authorization: string,
  id: string,
  route: string,
  locale: string,
): Promise<Preview> {
  try {
    const result = await client
      .zones({ id })
      .$readPage.post({ target: { route }, languages: requestLanguages(locale) }, { headers: { authorization } });
    if (result.status === 200 && result.data && 'document' in result.data) return { kind: 'ready', value: result.data };
    if (result.status === 202)
      return { kind: 'preparing', retryAfter: result.response.headers.get('retry-after') ?? '1' };
    return failure(result);
  } catch (error) {
    return caught(error);
  }
}
