import { createKernelClient } from '@rezics/client';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { locales } from '../paraglide/runtime.js';
import { requestLanguages } from './languages.ts';
import { withPlatformClosedRecognition } from './platform-closed.ts';
import { recordPageReadCacheControl } from '../security/page-cache.ts';

const kernelOrigin = createIsomorphicFn()
  .server(() => (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN)
  .client(() => undefined as string | undefined);

const currentRequest = createIsomorphicFn()
  .server((given?: Request) => {
    try {
      return given ?? getRequest();
    } catch {
      return given;
    }
  })
  .client((given?: Request) => given);

/** Mark the response private and require an SSR request. */
export const preparePrivatePage = createIsomorphicFn()
  .server(() => {
    setResponseHeader('cache-control', 'private, no-store');
    void getRequest();
  })
  .client(() => undefined);

export function hasKernelOrigin(): boolean {
  return Boolean(kernelOrigin());
}

export function configuredKernelOrigin(): string | undefined {
  return kernelOrigin();
}

/** Carry the owner's restrictive cache policy through SSR, including nested server functions. */
function pageFetch(fetcher: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const response = await fetcher(input, init);
    const request = currentRequest();
    if (request) recordPageReadCacheControl(request, response.headers.get('cache-control'));
    return response;
  }) as typeof fetch;
}

/** The reader's request languages, with descending q-values for sibling scripts. */
export function acceptLanguage(locale: string): string {
  return requestLanguages(locale)
    .map((tag, index) => (index === 0 ? tag : `${tag};q=${Math.max(1 - index / 10, 0.1).toFixed(1)}`))
    .join(', ');
}

function uiLocale(value: string | undefined): string | undefined {
  return locales.find((locale) => locale === value);
}

/**
 * The reader's locale for a call that was not given one: the locale in the page address, or in the address of the
 * page that called a server function.
 */
export function requestLocale(given?: Request): string | undefined {
  const request = currentRequest(given);
  if (!request) return undefined;
  const page = request;
  const fromPath = (value: string | null) => {
    try {
      return value === null ? undefined : uiLocale(new URL(value, page.url).pathname.split('/')[1]);
    } catch {
      return undefined;
    }
  };
  return fromPath(page.url) ?? fromPath(page.headers.get('referer'));
}

/** One reader's kernel client. Every call asks for the reader's language chain, so embedded labels follow it. */
export function kernelClient(
  locale?: string,
  authorization?: string,
  decorateFetch: (fetcher: typeof fetch) => typeof fetch = (fetcher) => fetcher,
) {
  const language = uiLocale(locale) ?? requestLocale();
  const headers = {
    ...(language === undefined ? {} : { 'accept-language': acceptLanguage(language) }),
    ...(authorization === undefined ? {} : { authorization }),
  };
  const origin = kernelOrigin();
  if (origin)
    return withPlatformClosedRecognition(
      createKernelClient(origin, { headers, fetch: pageFetch(decorateFetch(globalThis.fetch)) }),
    );
  if (import.meta.env.DEV) {
    return withPlatformClosedRecognition(
      createKernelClient('http://kernel.local', {
        headers,
        fetch: pageFetch(
          decorateFetch((async (input, init) => {
            const [{ createFakeKernelFetch }, { default: fixtures }] = await Promise.all([
              import('./fake.ts'),
              import('./fixtures.json'),
            ]);
            return createFakeKernelFetch(fixtures as unknown as Parameters<typeof createFakeKernelFetch>[0])(
              input,
              init,
            );
          }) as typeof fetch),
        ),
      }),
    );
  }
  throw new Error('KERNEL_ORIGIN is required to read subjects');
}
