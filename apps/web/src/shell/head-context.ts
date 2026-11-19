import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { getLocale } from '../paraglide/runtime.js';
import type { HeadContext } from './head';
import { browserPublicOrigin, validatePublicOrigin } from './origin';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN, getRequest().url))
  .client(() => browserPublicOrigin());

export function pageHeadContext(path: string): HeadContext {
  return { origin: publicOrigin(), locale: getLocale(), path };
}
