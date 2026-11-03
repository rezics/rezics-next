import { loadRoutePage } from './route';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { kernelClient } from '../../kernel/client';
import { requestLanguages } from '../../kernel/languages';
import { readDiscovery, readDiscoveryKinds, type DiscoveryRequest } from '../../search/discovery';
import {
  homeFeedId,
  homeSpaceAddress,
  readHomeSpace,
  type HomeSpaceRequest,
  type HomeSpaceResult,
} from './home-feed-spaces';
import { homeFeedKind } from './home-feed-kinds';
import {
  homeQuestionId,
  readHomeQuestionPage,
  readHomeQuestion,
  type QuestionPageResult,
  type QuestionPointResult,
} from './home-feed-questions';
import { publicRead } from '../../kernel/query';
import { validatePublicOrigin } from '../../shell/origin';
import { loadPublicHomeFeed, readHomeFeedPage, type FeedInput, type HomeFeedResult } from './home-feed-read';

function localeInput(locale: unknown): string {
  if (typeof locale !== 'string' || !locale || locale.length > 35) throw new Error('Invalid locale');
  return locale;
}
function feedInput(input: FeedInput & { locale: string }) {
  localeInput(input.locale);
  homeFeedKind(input.kind);
  homeFeedId(input.spaceId);
  homeFeedId(input.ratingQuestionId);
  if (
    !['home', 'following'].includes(input.stream) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 32768))
  )
    throw new Error('Invalid feed request');
  return input;
}

const readHomePage = createServerFn({ method: 'GET' })
  .validator(localeInput)
  .handler(async ({ data: locale }) => {
    const { env } = await import('cloudflare:workers');
    const client = kernelClient(locale);
    const [feed, catalogue] = await Promise.all([
      loadPublicHomeFeed(client),
      loadRoutePage(client, '/', locale).catch(() => ({ kind: 'missing' as const })),
    ]);
    const origin = validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN);
    return { feed, origin, catalogue };
  });

/** Only this anonymous result enters the reusable page query cache or hydration payload. */
export const homePageQuery = (locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['home-page', locale],
    queryFn: () => readHomePage({ data: locale }),
  });

export const readPublicHomePage = createServerFn({ method: 'GET' })
  .validator((input: Omit<FeedInput, 'stream'> & { locale: string }) => feedInput({ ...input, stream: 'home' }))
  .handler(({ data }) =>
    loadPublicHomeFeed(kernelClient(data.locale), data.cursor, data.kind, getRequest().signal, {
      ...(data.spaceId === undefined ? {} : { spaceId: data.spaceId }),
      ...(data.ratingQuestionId === undefined ? {} : { ratingQuestionId: data.ratingQuestionId }),
    }),
  );

/** Private feed data lives in the mounted viewer's component, outside shared query/hydration caches. */
export const readPrivateHomePage = createServerFn({ method: 'GET' })
  .validator((input: FeedInput & { locale: string; viewer: string }) => {
    feedInput(input);
    if (typeof input.viewer !== 'string' || !input.viewer || input.viewer.length > 256)
      throw new Error('Invalid viewer');
    return input;
  })
  .handler(async ({ data }): Promise<HomeFeedResult> => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const request = getRequest();
    try {
      await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
      const authorization = viewerCredential(request) ?? undefined;
      if (!authorization || sessionSubject(request) !== data.viewer)
        return { state: 'auth', code: 'authentication_required' };
      return readHomeFeedPage(
        kernelClient(data.locale),
        {
          stream: data.stream,
          ...(data.spaceId === undefined ? {} : { spaceId: data.spaceId }),
          ...(data.ratingQuestionId === undefined ? {} : { ratingQuestionId: data.ratingQuestionId }),
          ...(data.kind === undefined ? {} : { kind: data.kind }),
          ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
        },
        authorization,
        request.signal,
      );
    } catch {
      return { state: 'unavailable', code: 'dependency_unavailable' };
    }
  });

/** Anonymous bounded registry metadata, read only when the Home control needs choices. No hits are retained. */
export const readHomeKinds = createServerFn({ method: 'GET' })
  .validator((input: { locale: string; cursor?: string }) => {
    localeInput(input.locale);
    if (
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 32768)
    )
      throw new Error('Invalid kind cursor');
    return input;
  })
  .handler(async ({ data }) => {
    const client = kernelClient(data.locale);
    const request: DiscoveryRequest = {
      representation: 'discovery-v1',
      languages: requestLanguages(data.locale),
      limit: 1,
      kindPage: { limit: 8 },
    };
    const send = (body: DiscoveryRequest) =>
      client.subjects.$search.post(body, {
        fetch: { signal: getRequest().signal, cache: 'no-store', redirect: 'manual' },
      });
    const result =
      data.cursor !== undefined
        ? await readDiscoveryKinds(request, data.cursor, send)
        : await readDiscovery(request, send).then(({ discovery }) =>
            discovery.status === 'ready' ? { status: 'ready' as const, kinds: discovery.page.kinds } : discovery,
          );
    if (result.status === 'ready') {
      try {
        for (const kind of result.kinds.values) homeFeedKind(kind.id);
      } catch {
        return { status: 'unavailable' as const };
      }
    }
    return result;
  });

/** Exact Home metadata stays out of shared query caches and hydration, including viewer-derived Realm. */
export const readHomeSpaceChoice = createServerFn({ method: 'GET' })
  .validator((input: HomeSpaceRequest & { locale: string; viewer?: string }) => {
    localeInput(input.locale);
    if (input.viewer !== undefined && (typeof input.viewer !== 'string' || !input.viewer || input.viewer.length > 256))
      throw new Error('Invalid viewer');
    if (input.spaceId !== undefined) {
      homeFeedId(input.spaceId);
      if (input.address !== undefined) throw new Error('Invalid Space request');
    } else if (typeof input.address !== 'string' || !input.address || input.address.length > 2048)
      throw new Error('Invalid Space address');
    return input;
  })
  .handler(async ({ data }): Promise<HomeSpaceResult> => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const request = getRequest();
    let input: HomeSpaceRequest;
    try {
      input =
        data.spaceId === undefined
          ? { address: homeSpaceAddress(data.address, new URL(request.url).origin) }
          : { spaceId: data.spaceId };
    } catch {
      return { status: 'invalid' };
    }
    try {
      let authorization: string | undefined;
      if (data.viewer !== undefined) {
        const { env } = await import('cloudflare:workers');
        await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
        authorization = viewerCredential(request) ?? undefined;
        if (!authorization || sessionSubject(request) !== data.viewer) return { status: 'auth' };
      }
      return readHomeSpace(kernelClient(data.locale), input, authorization, request.signal);
    } catch {
      return { status: 'unavailable' };
    }
  });

/** Viewer-local metadata shares the feed's prepared identity, never its hydration/cache. */
export const readHomeQuestions = createServerFn({ method: 'GET' })
  .validator((input: { locale: string; cursor?: string; questionId?: string; viewer?: string }) => {
    localeInput(input.locale);
    homeQuestionId(input.questionId);
    if (
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 32768)
    )
      throw new Error('Invalid question cursor');
    if (input.questionId !== undefined && input.cursor !== undefined) throw new Error('Invalid question request');
    if (input.viewer !== undefined && (typeof input.viewer !== 'string' || !input.viewer || input.viewer.length > 256))
      throw new Error('Invalid viewer');
    return input;
  })
  .handler(async ({ data }): Promise<QuestionPageResult | QuestionPointResult> => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const request = getRequest();
    try {
      let authorization: string | undefined;
      if (data.viewer !== undefined) {
        const { env } = await import('cloudflare:workers');
        await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
        authorization = viewerCredential(request) ?? undefined;
        if (!authorization || sessionSubject(request) !== data.viewer)
          return { status: 'auth', code: 'authentication_required' };
      }
      return data.questionId === undefined
        ? readHomeQuestionPage(kernelClient(data.locale), data.cursor, authorization, request.signal)
        : readHomeQuestion(kernelClient(data.locale), data.questionId, authorization, request.signal);
    } catch {
      return { status: 'unavailable', code: 'dependency_unavailable' };
    }
  });
