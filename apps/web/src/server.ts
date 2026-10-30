import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { authRequest } from './session/routes.ts';
import { prepareSession } from './session/request.ts';
import { cookie, clearCookie, SESSION_COOKIE, validId } from './session/cookies.ts';
import type { SessionEnv } from './session/client.ts';
import { sessionSubject } from './session/request.ts';
import { readSessionState } from './session/state.ts';
import {
  carriesSession,
  csrfTokenFromRequest,
  csrfTokenMatches,
  isAllowedSiteOrigin,
  isUnsafeRequest,
} from './session/csrf.ts';
import { problem, problemResponse } from './media/kernel.ts';
import { mediaRequest, type MediaEnv } from './media/index.ts';
import { sitemapResponse, type SitemapEnv } from './sitemap/serve.ts';
import { sitemapFeeds } from './sitemap/feeds.ts';
import {
  exportSitemapFeedSegment,
  publishSitemapExport,
  readSitemapFeedFiles,
  sitemapR2Store,
  sitemapStepRetryPolicy,
  startDailySitemapExport,
  startSitemapWorkflow,
  type SitemapStepRunner,
  type SitemapWorkflowBinding,
} from './sitemap/export.ts';
import { suggestSubjects } from './search/suggestions.ts';
import { limitRead, readLimitKey, type ReadRateLimitEnv } from './rate-limit/read.ts';
import { orderStatusResponse } from './checkout/order.server.ts';
import { startCheckout } from './checkout/start.ts';
import { submitNotificationForm } from './settings/actions.server.ts';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { paraglideMiddleware } from './paraglide/server.js';
import { isPublicCacheRequest } from './router.tsx';
import {
  cachePublicPage,
  consumeDehydratedPageData,
  dehydratedPageDataFromRouter,
  isPublicCacheRender,
  privateServerFunctionResponse,
  recordDehydratedPageData,
} from './security/page-cache.ts';
import { createNonce, requestNonce } from './security/nonce.ts';
import {
  defineCustomServerStrategy,
  extractLocaleFromRequestAsync,
  extractLocaleFromRequestWithStrategies,
  localizeUrl,
  locales,
} from './paraglide/runtime.js';

export { SessionStore } from './session/store.ts';

type SitemapWorkflowEnv = SitemapEnv & {
  PUBLIC_ORIGIN: string;
  SITEMAP_EXPORT: SitemapWorkflowBinding;
};

type SitemapWorkflowParams = { runId?: string; feedType?: string; segment?: number };

class WorkflowSitemapSteps implements SitemapStepRunner {
  constructor(private readonly step: WorkflowStep) {}

  do<T>(name: string, run: () => Promise<T>, retry: Parameters<SitemapStepRunner['do']>[2]): Promise<T> {
    const result = this.step.do(
      name,
      {
        retries: {
          limit: retry.limit,
          delay: ({ ctx, error }) => {
            if (!retry.shouldRetry(error)) throw new NonRetryableError(error.message);
            return retry.delay(error, ctx.attempt);
          },
        },
      },
      async () => {
        try {
          return (await run()) as never;
        } catch (error) {
          if (!retry.shouldRetry(error)) {
            throw new NonRetryableError(error instanceof Error ? error.message : String(error));
          }
          throw error;
        }
      },
    );
    return result as Promise<T>;
  }
}

export class SitemapExport extends WorkflowEntrypoint<SitemapWorkflowEnv, SitemapWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<SitemapWorkflowParams>>, step: WorkflowStep): Promise<void> {
    const log = (record: { message: 'sitemap export failed'; feed: string; step: string; error: unknown }) =>
      console.error(record.message, {
        feed: record.feed,
        step: record.step,
        error: record.error instanceof Error ? record.error.message : String(record.error),
      });
    try {
      const params = event.payload ?? {};
      const runId = params.runId ?? event.instanceId;
      const store = sitemapR2Store(this.env.SITEMAPS);
      const runner = new WorkflowSitemapSteps(step);
      const feeds = sitemapFeeds();
      if (params.feedType) {
        const feed = feeds.find((candidate) => candidate.type === params.feedType);
        if (!feed) throw new Error(`Sitemap feed ${params.feedType} is not registered`);
        const completed = await exportSitemapFeedSegment(
          runId,
          feed,
          { runId, origin: this.env.PUBLIC_ORIGIN, store, runner, feeds: [feed], now: () => event.timestamp, log },
          params.segment ?? 0,
        );
        if (!completed) {
          const nextSegment = (params.segment ?? 0) + 1;
          const nextId = `${runId}-${feed.type}-${nextSegment}`;
          await runner.do(
            `start-continuation-${nextSegment}`,
            () =>
              startSitemapWorkflow(this.env.SITEMAP_EXPORT, nextId, {
                runId,
                feedType: feed.type,
                segment: nextSegment,
              }),
            sitemapStepRetryPolicy(),
          );
        }
        return;
      }

      const indexSnapshot = await runner.do('capture-index', () => store.head('index.xml'), sitemapStepRetryPolicy());
      for (const feed of feeds) {
        if (!/^[a-z]+$/.test(feed.type))
          throw new Error(`Sitemap feed type must contain lowercase letters: ${feed.type}`);
      }
      if (new Set(feeds.map((feed) => feed.type)).size !== feeds.length)
        throw new Error('Sitemap feed types must be unique');
      await Promise.all(
        feeds.map((feed) =>
          runner.do(
            `start-feed-${feed.type}`,
            () =>
              startSitemapWorkflow(this.env.SITEMAP_EXPORT, `${runId}-${feed.type}`, {
                runId,
                feedType: feed.type,
                segment: 0,
              }),
            sitemapStepRetryPolicy(),
          ),
        ),
      );
      await Promise.all(
        feeds.map(async (feed) => {
          let segment = 0;
          for (;;) {
            const childId = segment === 0 ? `${runId}-${feed.type}` : `${runId}-${feed.type}-${segment}`;
            let poll = 0;
            for (;;) {
              const status = await runner.do(
                `status-${feed.type}-${segment}-${poll}`,
                async () => this.env.SITEMAP_EXPORT.get(childId).then((instance) => instance.status()),
                sitemapStepRetryPolicy(),
              );
              if (status.status === 'complete') break;
              if (status.status === 'errored' || status.status === 'terminated')
                throw new Error(status.error?.message ?? `Sitemap feed ${feed.type} workflow ${childId} failed`);
              await step.sleep(`wait-${feed.type}-${segment}-${poll}`, '5 minutes');
              poll += 1;
            }
            const list = await runner.do(
              `check-feed-list-${feed.type}-${segment}`,
              () => store.head(`runs/${runId}/${feed.type}.json`),
              sitemapStepRetryPolicy(),
            );
            if (list) return;
            segment += 1;
          }
        }),
      );
      await runner.do(
        'publish-index',
        async () => {
          const filesByFeed = new Map<string, Awaited<ReturnType<typeof readSitemapFeedFiles>>>();
          for (const feed of feeds) filesByFeed.set(feed.type, await readSitemapFeedFiles(store, runId, feed.type));
          await publishSitemapExport({
            runId,
            origin: this.env.PUBLIC_ORIGIN,
            store,
            indexSnapshot,
            filesByFeed,
            now: event.timestamp,
            log,
          });
          return true;
        },
        sitemapStepRetryPolicy(),
      );
    } catch (error) {
      const params = event.payload ?? {};
      log({
        message: 'sitemap export failed',
        feed: params.feedType ?? 'publication',
        step: params.feedType ? `feed-segment-${params.segment ?? 0}` : 'publish-index',
        error,
      });
      throw error;
    }
  }
}

export function scheduled(
  controller: ScheduledController,
  workerEnv: SitemapWorkflowEnv,
  context: ExecutionContext,
): void {
  context.waitUntil(startDailySitemapExport(workerEnv.SITEMAP_EXPORT, controller.scheduledTime));
}

defineCustomServerStrategy('custom-accept-language', {
  getLocale(request) {
    if (!request) return undefined;
    try {
      return extractLocaleFromRequestWithStrategies(request, ['url', 'cookie']);
    } catch {
      // Continue to the custom header strategy when neither runtime strategy matches.
    }
    return matchUiLocaleTag(request.headers.get('accept-language'));
  },
});

const fetchHandler = createStartHandler((options) => {
  if (isPublicCacheRender(options.request))
    recordDehydratedPageData(options.request, dehydratedPageDataFromRouter(options.router));
  return defaultStreamHandler(options);
});

const nativeMediaStoragePath = '/_native/media-storage';
const mediaKeyPattern =
  /^m\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/i;
const mediaPrefixPattern = /^m\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/i;

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Native acceptance bridges the kernel's real S3 adapter to this Worker-owned local R2 bucket. */
async function nativeMediaStorageRequest(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== nativeMediaStoragePath && !url.pathname.startsWith(`${nativeMediaStoragePath}/`)) return;
  const nativeEnv = env as Partial<{ MEDIA: R2Bucket; NATIVE_MEDIA_STORAGE_TOKEN: string }>;
  const token = nativeEnv.NATIVE_MEDIA_STORAGE_TOKEN;
  const media = nativeEnv.MEDIA;
  if (!token || request.headers.get('x-native-media-storage-key') !== token)
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!media) return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });

  let path: string[];
  try {
    path = url.pathname.slice(nativeMediaStoragePath.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  if (path[0] !== 'content-media') return new Response(null, { status: 404 });
  const key = path.slice(1).join('/');
  if (key && (key.length > 1024 || !mediaKeyPattern.test(key))) return new Response(null, { status: 404 });

  if (request.method === 'GET' && !key) {
    const prefix = url.searchParams.get('prefix') ?? '';
    const maxKeys = Number(url.searchParams.get('max-keys') ?? '1000');
    const cursor = url.searchParams.get('continuation-token') ?? undefined;
    if (
      url.searchParams.get('list-type') !== '2' ||
      url.searchParams.get('encoding-type') !== 'url' ||
      !mediaPrefixPattern.test(prefix) ||
      !Number.isInteger(maxKeys) ||
      maxKeys < 1 ||
      maxKeys > 1000
    )
      return new Response(null, { status: 400 });
    try {
      const result = await media.list({ prefix, limit: maxKeys, ...(cursor ? { cursor } : {}) });
      const entries = result.objects
        .map(
          ({ key: objectKey, size }) =>
            `<Contents><Key>${encodeURIComponent(objectKey)}</Key><Size>${size}</Size></Contents>`,
        )
        .join('');
      const continuation =
        result.truncated && result.cursor ? `<NextContinuationToken>${xml(result.cursor)}</NextContinuationToken>` : '';
      const body =
        `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix>` +
        `<KeyCount>${result.objects.length}</KeyCount><IsTruncated>${result.truncated}</IsTruncated>${entries}${continuation}</ListBucketResult>`;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/xml', 'cache-control': 'no-store' },
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  }

  if (!key) return new Response(null, { status: 404 });
  if (request.method === 'GET') {
    try {
      const object = await media.get(key);
      if (!object)
        return new Response('<Error><Code>NoSuchKey</Code></Error>', {
          status: 404,
          headers: { 'content-type': 'application/xml', 'cache-control': 'no-store' },
        });
      const headers = new Headers({
        'content-length': String(object.size),
        'cache-control': 'no-store',
      });
      if (object.httpMetadata?.contentType) headers.set('content-type', object.httpMetadata.contentType);
      return new Response(object.body, { status: 200, headers });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
  if (request.method === 'PUT') {
    try {
      if (!request.body) return new Response(null, { status: 400 });
      const contentType = request.headers.get('content-type');
      await media.put(key, request.body, {
        ...(contentType ? { httpMetadata: { contentType } } : {}),
      });
      return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
  if (request.method === 'DELETE') {
    try {
      await media.delete(key);
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
  return new Response(null, { status: 405, headers: { allow: 'GET, PUT, DELETE' } });
}

async function fetchRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const nativeStorage = await nativeMediaStorageRequest(request);
  if (nativeStorage) return nativeStorage;
  // Crawler files read no session and make no kernel request.
  if (url.pathname === '/robots.txt') return fetchHandler(request);
  const publicEnv = env as Partial<SitemapEnv> & { PUBLIC_ORIGIN?: string };
  const crawlerFile = await sitemapResponse(request, publicEnv);
  if (crawlerFile) return crawlerFile;
  const sessionEnv = env as Partial<SessionEnv>;
  if (
    isUnsafeRequest(request) &&
    carriesSession(request) &&
    !isAllowedSiteOrigin(request, request.headers.get('origin'), sessionEnv.SITE_ORIGINS)
  )
    return problemResponse(problem(403, 'forbidden', 'Forbidden'));
  if (url.pathname === '/library/entry') {
    const [{ libraryEntryFormResponse }, { kernelClient }, { default: stylesheet }] = await Promise.all([
      import('./library/entry-form'),
      import('./kernel/client'),
      import('./styles.css?url'),
    ]);
    return libraryEntryFormResponse(request, sessionEnv, kernelClient(), stylesheet);
  }
  const orderStatus = /^\/orders\/([^/]+)\/status$/.exec(url.pathname);
  if (orderStatus && request.method === 'GET') {
    try {
      await prepareSession(request, sessionEnv);
      const refused = await limitRead(
        request,
        env as typeof env & ReadRateLimitEnv,
        readLimitKey(request, sessionSubject(request)),
      );
      if (refused) return refused;
      return await orderStatusResponse(request, orderStatus[1]!);
    } catch (error) {
      return problemResponse(error);
    }
  }
  if (url.pathname === '/checkout') {
    if (request.method !== 'POST')
      return problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow: 'POST' });
    try {
      return await startCheckout(request, sessionEnv);
    } catch (error) {
      return problemResponse(error);
    }
  }
  if (request.method === 'POST' && locales.some((locale) => url.pathname === `/${locale}/settings`)) {
    try {
      return await submitNotificationForm(request);
    } catch (error) {
      return problemResponse(error);
    }
  }
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  const isServerFn = url.pathname === '/_serverFn' || url.pathname.startsWith('/_serverFn/');
  const isMedia = url.pathname === '/media' || url.pathname.startsWith('/media/');
  if (
    isRead &&
    !isMedia &&
    !isServerFn &&
    !url.pathname.startsWith('/auth/') &&
    url.pathname !== '/api/search/suggestions'
  ) {
    const redirect = await pageRedirect(request, url);
    if (redirect) return redirect;
  }
  let clearSessionCookie = false;
  let mediaSessionError: unknown;

  if (isRead) {
    let subject: string | undefined;
    if (isMedia) {
      try {
        clearSessionCookie = await prepareSession(request, env as Partial<SessionEnv>);
      } catch (error) {
        mediaSessionError = error;
      }
      subject = sessionSubject(request);
    } else if (isServerFn || url.pathname === '/api/search/suggestions') {
      const identity = await readSessionState(request, sessionEnv);
      if (identity.state === 'signed-in') subject = identity.subject;
    }

    // Public document admission must not resolve or inspect a reader's session.
    const publicPage =
      !isMedia && !isServerFn && !url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/api/');
    const key = publicPage ? `ip:${request.headers.get('CF-Connecting-IP') ?? ''}` : readLimitKey(request, subject);
    const refused = await limitRead(request, env as typeof env & ReadRateLimitEnv, key);
    if (refused) return refused;
    if (mediaSessionError !== undefined) return problemResponse(mediaSessionError);
  }

  if (isServerFn) return privateServerFunctionResponse(await fetchHandler(request));

  if (url.pathname.startsWith('/auth/')) {
    if (isUnsafeRequest(request) && carriesSession(request)) {
      const id = cookie(request, SESSION_COOKIE);
      const token = await csrfTokenFromRequest(request);
      if (url.pathname === '/auth/sign-out') {
        if (!validId(id) || !sessionEnv.SESSIONS) return problemResponse(problem(403, 'forbidden', 'Forbidden'));
        try {
          const ended = await sessionEnv.SESSIONS.get(sessionEnv.SESSIONS.idFromName(id)).end(token);
          if (typeof ended !== 'object' || ended === null || !ended.allowed)
            return problemResponse(problem(403, 'forbidden', 'Forbidden'));
          return authRequest(request, sessionEnv, { idToken: ended.idToken });
        } catch (error) {
          return problemResponse(error);
        }
      }
      if (!validId(id) || !sessionEnv.SESSIONS || token === null)
        return problemResponse(problem(403, 'forbidden', 'Forbidden'));
      try {
        const result = await sessionEnv.SESSIONS.get(sessionEnv.SESSIONS.idFromName(id)).signedIn();
        const signedIn = typeof result === 'object' ? result.signedIn : Boolean(result);
        const csrfToken = typeof result === 'object' ? (result.csrfToken ?? undefined) : undefined;
        if (!signedIn || !csrfTokenMatches(csrfToken, token))
          return problemResponse(problem(403, 'forbidden', 'Forbidden'));
      } catch {
        return problemResponse(problem(403, 'forbidden', 'Forbidden'));
      }
    }
    return authRequest(request, sessionEnv);
  }
  if (url.pathname === '/api/search/suggestions') {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
    const query = url.searchParams.get('q')?.trim() ?? '';
    if (!query || query.length > 256)
      return Response.json(
        { subjects: [], as_of: new Date().toISOString() },
        { headers: { 'cache-control': 'no-store' } },
      );
    try {
      return Response.json(await suggestSubjects(query, request), { headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json(
        { error: 'Suggestions unavailable' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
  }
  if (url.pathname !== '/media' && !url.pathname.startsWith('/media/')) return siteRequest(request);
  try {
    if (!isRead) clearSessionCookie = await prepareSession(request, env as Partial<SessionEnv>);
    const response = await mediaRequest(request, env as Partial<MediaEnv>);
    if (!clearSessionCookie) return response;
    const headers = new Headers(response.headers);
    headers.append('set-cookie', clearCookie(SESSION_COOKIE));
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    return problemResponse(error);
  }
}

const worker = {
  async fetch(request: Request) {
    const publicRoute = isPublicCacheRequest(request);
    return cachePublicPage(request, {
      publicRoute,
      cache: (caches as CacheStorage & { default: Cache }).default,
      buildId: (env as Partial<{ BUILD_ID: string }>).BUILD_ID ?? 'development',
      dehydratedData: () => consumeDehydratedPageData(request),
      freshNonce: () => requestNonce(request) ?? createNonce(request),
      render: () => fetchRequest(request),
    });
  },
};

export default {
  scheduled,
  async fetch(request: Request) {
    const response = await worker.fetch(request);
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/auth/') && !path.startsWith('/_serverFn/')) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

async function pageRedirect(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    return new Response(null, { status: 301, headers: { Location: url.href } });
  }
  const first = url.pathname.split('/')[1];
  if (!url.pathname.startsWith('/_serverFn/') && !locales.some((locale) => locale === first)) {
    const locale = await extractLocaleFromRequestAsync(request);
    const location = localizeUrl(url, { locale });
    return new Response(null, {
      status: 302,
      headers: { Location: location.href, Vary: 'Cookie, Accept-Language', 'Cache-Control': 'private, no-store' },
    });
  }
}

async function siteRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  // Server function RPCs are locale-neutral and must reach Start at their root endpoint.
  const response = pathname.startsWith('/_serverFn/')
    ? await fetchHandler(request)
    : await paraglideMiddleware(request, () => fetchHandler(request));
  const headers = new Headers(response.headers);
  const location = headers.get('Location');
  const destination = location ? new URL(location, request.url).pathname : '';
  const publicAgentMove = response.status === 302 && /^\/[^/]+\/@[^/]+(?:\/[^/]+)?$/.test(destination);
  headers.set('Cache-Control', publicAgentMove ? 'public, max-age=300' : 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function matchUiLocaleTag(header: string | null): string | undefined {
  const entries = (header ?? '').split(',').map((part, index) => ({
    tag: part.split(';')[0]!.trim().toLowerCase(),
    index,
    quality: Number(/;\s*q=([0-9.]+)/i.exec(part)?.[1] ?? 1),
  }));
  entries.sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const { tag, quality } of entries) {
    if (quality <= 0) continue;
    const exact = locales.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language, ...subtags] = tag.split('-');
    if (language === 'zh')
      return subtags.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    const base = locales.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return undefined;
}
