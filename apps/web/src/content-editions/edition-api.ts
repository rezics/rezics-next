import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { parseEditionMetadata, parseEditionRevision } from './edition-schema';
import type { EditionApi, EditionRead } from './contract';
export * from './contract';
export {
  editionSubjectIdentitySchema,
  parseEditionMetadata,
  parseEditionRevision,
  parseEditionSourceRecognition,
} from './edition-schema';

function member(value: unknown, key: string): unknown {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * Isolated adapter for Content's editionRoutes declaration while the installed generated
 * client catches up. Use its real Eden proxy/transport without casting an undelivered
 * client type. Every response crosses the owner's closed decoder before becoming data.
 */
export function createNativeEditionApi(client?: KernelClient): EditionApi {
  async function read<T>(
    id: string,
    authorization: string,
    revision: boolean,
    decode: (value: unknown) => T | null,
  ): Promise<EditionRead<T>> {
    if (!client) return { state: 'unavailable', status: 503, reason: 'native-pending' };
    try {
      // These exact paths and the `id` parameter come from Content's editionRoutes.
      const editions = member(client, 'contentEditions');
      if (typeof editions !== 'function') return { state: 'unavailable', status: 503, reason: 'source' };
      const resource: unknown = Reflect.apply(editions, client, [{ id }]);
      const endpoint = revision ? member(resource, 'revision') : resource;
      const get = member(endpoint, 'get');
      if (typeof get !== 'function') return { state: 'unavailable', status: 503, reason: 'source' };
      const result: unknown = await Reflect.apply(get, endpoint, [
        { headers: { authorization }, fetch: { redirect: 'manual', cache: 'no-store' } },
      ]);
      const status = member(result, 'status');
      if (status === 401 || status === 403) return { state: 'refused', status };
      if (status !== 200 || member(result, 'error'))
        return {
          state: 'unavailable',
          status: typeof status === 'number' && status >= 400 && status <= 599 ? status : 502,
          reason: status === 404 || status === 410 ? 'source' : 'dependency',
        };
      const value = decode(member(result, 'data'));
      return value === null ? { state: 'version-mismatch', status: 502 } : { state: 'available', value };
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'refused', status: 403 };
      return { state: 'unavailable', status: 503, reason: 'dependency' };
    }
  }
  return {
    readMetadata: (id, authorization) => read(id, authorization, false, parseEditionMetadata),
    readRevision: (id, authorization) => read(id, authorization, true, parseEditionRevision),
  };
}

/** Explicit unbound result for callers without native transport. The served reader binds a real client. */
export const nativeEditionApi = createNativeEditionApi();
