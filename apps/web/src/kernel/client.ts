import { localeChain } from '@rezics/composition';
import { createKernelClient } from '@rezics/client';
import { getRequest } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { locales } from '../paraglide/runtime.js';
import { withPlatformClosedRecognition } from './platform-closed.ts';

/** The chain in order with descending q-values: `zh-Hans, zh;q=0.9, zh-Hant;q=0.8, en;q=0.7`. */
export function acceptLanguage(locale: string): string {
  return localeChain(locale)
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
  let request: Request | undefined;
  try {
    request = given ?? getRequest();
  } catch {
    request = undefined;
  }
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
export function kernelClient(locale?: string) {
  const language = uiLocale(locale) ?? requestLocale();
  const headers = language === undefined ? undefined : { 'accept-language': acceptLanguage(language) };
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (origin) return withPlatformClosedRecognition(createKernelClient(origin, { ...(headers ? { headers } : {}) }));
  if (import.meta.env.DEV) {
    return withPlatformClosedRecognition(
      createKernelClient('http://kernel.local', {
        ...(headers ? { headers } : {}),
        fetch: (async (input, init) => {
          const [{ createFakeKernelFetch }, { default: fixtures }] = await Promise.all([
            import('./fake.ts'),
            import('./fixtures.json'),
          ]);
          return createFakeKernelFetch(fixtures as unknown as Parameters<typeof createFakeKernelFetch>[0])(input, init);
        }) as typeof fetch,
      }),
    );
  }
  throw new Error('KERNEL_ORIGIN is required to read subjects');
}
