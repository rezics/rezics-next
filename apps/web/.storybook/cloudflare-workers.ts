import { createStoryRecordedKernelFetch } from '../src/kernel/fake';

const kernelOrigin = 'http://kernel.local';
const recordedFetch = createStoryRecordedKernelFetch();
const runtime = globalThis as typeof globalThis & { __rezicsStoryFetchInstalled?: boolean };

if (!runtime.__rezicsStoryFetchInstalled) {
  const liveFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    return url.origin === kernelOrigin ? recordedFetch(input, init) : liveFetch(input, init);
  }) as typeof fetch;
  runtime.__rezicsStoryFetchInstalled = true;
}

const session = {
  signedIn: async () => ({ signedIn: true, subject: 'story-viewer', csrfToken: 'story-csrf-token' }),
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
