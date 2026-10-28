import { env } from 'cloudflare:workers';
import { createIsomorphicFn } from '@tanstack/react-start';
import { validatePublicOrigin } from '../shell/origin';
import type { SpacePageData } from './space';
import { communityPageHead } from './space-head-data';

export { communityPageHead } from './space-head-data';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

export function spacePageHead(page: SpacePageData | undefined, locale: string, path: string) {
  return communityPageHead(page, publicOrigin(), locale, path);
}
