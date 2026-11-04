import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { locales } from '../paraglide/runtime.js';
import { validExpectedReader, prepareExpectedReader, type ExpectedReader } from '../session/expected-reader';
import { readDiscoveryMutationPage, type DiscoveryRequest, type DiscoveryState } from './discovery';
import {
  boundDiscoveryPrivateBytes,
  discoveryCapabilities,
  discoveryMetadataFetch,
  type DiscoveryCapabilityPage,
} from './discovery-personal-capabilities';

export type DiscoveryBoundRequest = ExpectedReader & { request: DiscoveryRequest; locale: string };
export type DiscoveryBoundPage = { state: DiscoveryState; capabilities: DiscoveryCapabilityPage | null };
function validate(input: DiscoveryBoundRequest): DiscoveryBoundRequest {
  if (
    !input ||
    !validExpectedReader(input) ||
    !locales.some((locale) => locale === input.locale) ||
    input.request?.representation !== 'discovery-v1' ||
    new TextEncoder().encode(JSON.stringify(input.request)).byteLength > 65536
  )
    throw new Error('Invalid personal Search page');
  return structuredClone(input);
}
/** One read and one final admission, including empty/final pages. No retry, even for Top rated. */
export async function readBoundDiscoveryPage(
  input: DiscoveryBoundRequest,
  ports: {
    authorize: () => Promise<string | null>;
    read: (authorization: string) => Promise<DiscoveryState>;
    prepareCapabilities: (authorization: string) => Promise<(state: DiscoveryState) => DiscoveryCapabilityPage | null>;
  },
): Promise<DiscoveryBoundPage> {
  validate(input);
  const authorization = await ports.authorize();
  if (!authorization) return { state: { status: 'restart' }, capabilities: null };
  const project = await ports.prepareCapabilities(authorization);
  if ((await ports.authorize()) !== authorization) return { state: { status: 'restart' }, capabilities: null };
  const state = await ports.read(authorization);
  const capabilities = project(state);
  if ((await ports.authorize()) !== authorization) return { state: { status: 'restart' }, capabilities: null };
  if (boundDiscoveryPrivateBytes(state, capabilities) > 65536 && state.status === 'ready')
    return {
      state: {
        status: 'ready',
        page: {
          ...state.page,
          collectionFollows: { state: 'unavailable', reason: 'native' },
          accountFollows: { state: 'unavailable', reason: 'native' },
          ...(state.page.spaceEntries
            ? {
                spaceEntries: {
                  ...state.page.spaceEntries,
                  rows: state.page.spaceEntries.rows.map((row) => ({
                    ...row,
                    follow: { state: 'unavailable' as const },
                  })),
                },
              }
            : {}),
          viewerFacts: { state: 'unavailable', reason: 'response_limit', retryable: false },
        },
      },
      capabilities: null,
    };
  return { state, capabilities };
}
export const readDiscoveryPersonalPage = createServerFn({ method: 'POST' })
  .validator(validate)
  .handler(async ({ data }): Promise<DiscoveryBoundPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const [{ env }, { kernelClient }, { readReleaseForCaller }] = await Promise.all([
        import('cloudflare:workers'),
        import('../kernel/client'),
        import('../subject/definitions'),
      ]);
      const request = getRequest();
      const client = kernelClient(data.locale);
      const metadata = kernelClient(data.locale, undefined, discoveryMetadataFetch(request.signal));
      return await readBoundDiscoveryPage(data, {
        authorize: () => prepareExpectedReader(request, env, data),
        read: (authorization) =>
          readDiscoveryMutationPage(
            data.request,
            (body, signal) =>
              client.subjects.$search.post(body, { headers: { authorization }, fetch: { signal, cache: 'no-store' } }),
            request.signal,
          ),
        prepareCapabilities: async (authorization) => {
          const [release, admitted] = await Promise.all([
            readReleaseForCaller({ client: metadata, headers: { authorization } }).catch(() => undefined),
            metadata.platform.exposure
              .get({ headers: { authorization }, fetch: { signal: request.signal, cache: 'no-store' } })
              .then((response) => (!response.error ? response.data?.admitted : undefined))
              .catch(() => undefined),
          ]);
          return (state) =>
            state.status === 'ready' ? discoveryCapabilities(state.page, release, admitted, data.locale) : null;
        },
      });
    } catch (error) {
      if (getRequest().signal.aborted) throw error;
      return { state: { status: 'unavailable' }, capabilities: null };
    }
  });
