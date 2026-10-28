import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { getLocale } from '../paraglide/runtime.js';
import type { HeadContext } from './head';
import { validatePublicOrigin } from './origin';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

export function pageHeadContext(path: string): HeadContext {
  return { origin: publicOrigin(), locale: getLocale(), path };
}
