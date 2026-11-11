import type { Dependencies as ContentDependencies } from './routes.ts';
import { contentRoutes, subjectReactionRoutes } from './routes.ts';
import type { Dependencies as NoticeDependencies } from './notice-routes.ts';
import { noticeRoutes } from './notice-routes.ts';
import type { Dependencies as MediaDependencies } from './media-routes.ts';
import { mediaRoutes } from './media-routes.ts';
import { contentDeclaration } from './register.ts';
import { hostedChapterRoutes } from './hosted-chapters-routes.ts';

/** Explicit operands for Content's HTTP surface. The trusted kernel composition constructs each object; no
 * route reads the environment, the network, a UUID source or a clock by itself. */
export type ContentHttpDependencies = Readonly<{
  content: ContentDependencies;
  notice: NoticeDependencies;
  media: MediaDependencies;
}>;

/** Content's HTTP declaration. Mount order is part of the contract: content routes, then notices, then subject
 * reactions on the base application, then media on the content application. Returns the applications the kernel
 * composes further (its access routes continue from `media`). */
export function mountContentHttp(
  searched: Parameters<typeof contentRoutes>[0],
  app: Parameters<typeof subjectReactionRoutes>[0],
  dependencies: ContentHttpDependencies,
) {
  const content = hostedChapterRoutes(contentRoutes(searched, dependencies.content), dependencies.content);
  noticeRoutes(content as unknown as Parameters<typeof noticeRoutes>[0], dependencies.notice);
  subjectReactionRoutes(app, dependencies.content);
  const media = mediaRoutes(content as unknown as Parameters<typeof mediaRoutes>[0], dependencies.media);
  return { content, media };
}

/** The route surface Content contributes to the kernel's composed type. */
export type ContentHttpRoutes = ReturnType<typeof contentRoutes> &
  ReturnType<typeof hostedChapterRoutes> &
  ReturnType<typeof noticeRoutes> &
  ReturnType<typeof subjectReactionRoutes> &
  ReturnType<typeof mediaRoutes>;

/** HTTP composition reads the same declaration as the worker: events, operations, permissions, work,
 * effects, plus the mount function this module owns. */
export function contentHttpDeclaration() {
  return Object.freeze({
    ...contentDeclaration(),
    mount: mountContentHttp,
  });
}
