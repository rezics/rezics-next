import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { requestForStory } from './react-start';

const kernelOrigin = 'http://kernel.local';
const runtime = globalThis as typeof globalThis & { __rezicsStoryFetchInstalled?: boolean };

/** Only the existing suggestions/trending BFF routes and recorded kernel belong to this browser bridge. */
export function createStoryFetch(
  liveFetch: typeof fetch,
  recordedFetch = createStoryRecordedKernelFetch(),
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin === kernelOrigin) return recordedFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (
      url.origin !== window.location.origin ||
      (url.pathname !== '/api/search/suggestions' && url.pathname !== '/api/search/trending') ||
      method.toUpperCase() !== 'GET'
    )
      return liveFetch(input, init);
    const request = requestForStory(input instanceof Request ? input : url, init);
    request.signal.throwIfAborted();
    const respond =
      url.pathname === '/api/search/suggestions'
        ? (await import('../src/search/suggestions')).suggestionResponse
        : (await import('../src/search/trending')).trendingResponse;
    request.signal.throwIfAborted();
    const response = await respond(request, env);
    request.signal.throwIfAborted();
    return response;
  }) as typeof fetch;
}

if (typeof window !== 'undefined' && !runtime.__rezicsStoryFetchInstalled) {
  globalThis.fetch = createStoryFetch(globalThis.fetch.bind(globalThis));
  runtime.__rezicsStoryFetchInstalled = true;
}

const session = {
  signedIn: async () => ({ signedIn: true, subject: 'story-viewer', csrfToken: 'story-csrf-token' }),
  credentialIfFresh: async () => ({
    status: 'active' as const,
    accessToken: 'recorded-story-token',
    subject: 'story-viewer',
    csrfToken: 'story-csrf-token',
  }),
  credential: async () => ({
    status: 'active' as const,
    accessToken: 'recorded-story-token',
    subject: 'story-viewer',
    csrfToken: 'story-csrf-token',
  }),
};

export const env = {
  KERNEL_ORIGIN: kernelOrigin,
  PUBLIC_ORIGIN: 'https://rezics.example',
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://kernel.local',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'storybook',
  WEBSITE_CLIENT_KEY: '{}',
  COLLECTION_FILTERS: 'true',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => session,
  },
} as unknown as Record<string, never>;
