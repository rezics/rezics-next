import { queryOptions } from '@tanstack/react-query';
import { isView, type View } from '@rezics/composition';
import { notFound } from '@tanstack/react-router';
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { personalRead, publicRead } from '../../kernel/query';
import { loadSubjectLibrarySlot, type SubjectLabelUndo } from '../../library/subject-slot';
import type { SessionEnv } from '../../session/client';
import { loadReader } from '../../subject/load-reader';
import type { typeFrame as TypeFrame } from '../../subject/definitions';
import { validatePageRealm, validatePageNode, validateViewCursor } from './view-cursor';
import { loadSubjectPage, PageReadError } from './subject';
import { loadContextSubject } from './context-subject';
import { readRatings, readOwnRating } from './subject-ratings';
import { readReactionCounts, readOwnReaction } from './subject-reactions';
import { communityOverview, withComposedCommunity } from './subject-community';
import { projectShareCardPage } from '../../media/share-card-page';
import { locales } from '../../paraglide/runtime.js';

export const subjectKernelClient = createServerOnlyFn(
  async (locale: string, realm?: string, expectedReader?: string | null) => {
    const { kernelClient } = await import('../../kernel/client');
    // Eden's treaty client is thenable; wrap it so this async boundary does not make a request to /v1.
    if (realm === undefined) return { client: kernelClient(locale), authorization: undefined, reader: null };
    const { env } = await import('cloudflare:workers');
    const { prepareSession, viewerCredential, sessionSubject } = await import('../../session/request');
    setResponseHeader('cache-control', 'private, no-store');
    await prepareSession(getRequest(), env as Partial<SessionEnv>);
    const authorization = viewerCredential(getRequest()) ?? undefined;
    // Explicit bearer callers have no BFF subject. A digest partitions their cache without exposing the credential.
    const digest =
      authorization && !sessionSubject(getRequest())
        ? Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authorization))),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('')
        : null;
    const reader = authorization ? (sessionSubject(getRequest()) ?? `credential:${digest}`) : null;
    if (expectedReader !== undefined && reader !== expectedReader)
      throw new PageReadError('dependency_unavailable', 503);
    return { client: kernelClient(locale), authorization, reader };
  },
);

/** Resolve the current request's cache partition. This value never grants native read authority. */
export const subjectRequestReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: { realm?: string | undefined }) => ({ realm: validatePageRealm(input.realm) }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return (await subjectKernelClient('en', data.realm)).reader;
  });

function validateReader(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 128) throw notFound();
  return value;
}

const readSubjectPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      (value.subjectType !== undefined && (typeof value.subjectType !== 'string' || value.subjectType.length > 128)) ||
      (value.view !== undefined && !isView(value.view))
    )
      throw notFound();
    return {
      id: value.id,
      locale: value.locale,
      view: value.view as View | undefined,
      realm: validatePageRealm(value.realm),
      reader: validateReader(value.reader),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { client, authorization } = await subjectKernelClient(data.locale, data.realm, data.reader);
    const loaded = await loadSubjectPage(client, data.id, data.view, data.locale, { realm: data.realm, authorization });
    if (loaded.kind === 'page') loaded.page.requestedReader = data.reader;
    const cardLocale = locales.find((locale) => locale === data.locale);
    const shareCard =
      data.realm === undefined && authorization === undefined && cardLocale !== undefined
        ? projectShareCardPage(loaded, { id: data.id, locale: cardLocale })
        : undefined;
    return { ...(await withComposedCommunity(client, loaded)), shareCard };
  });

const readSubjectViewPages = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      !isView(value.view) ||
      (value.cursor !== undefined && typeof value.cursor !== 'string')
    )
      throw notFound();
    return {
      id: value.id,
      locale: value.locale,
      subjectType: value.subjectType as string | undefined,
      view: value.view,
      cursor: validateViewCursor(value.cursor),
      realm: validatePageRealm(value.realm),
      reader: validateReader(value.reader),
      node: validatePageNode(value.node),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { loadViewPages } = await import('./subject-frame');
    const { client, authorization } = await subjectKernelClient(data.locale, data.realm, data.reader);
    const loaded = await loadViewPages(client, data.id, data.view, data.locale, data.cursor, {
      realm: data.realm,
      node: data.node,
      authorization,
    });
    if (loaded.kind !== 'page') return loaded;
    const cardLocale = locales.find((locale) => locale === data.locale);
    const shareCard =
      data.realm === undefined && authorization === undefined && cardLocale !== undefined
        ? projectShareCardPage({ kind: 'page', page: loaded.overview }, { id: data.id, locale: cardLocale })
        : undefined;
    loaded.page.requestedReader = data.reader;
    loaded.overview.requestedReader = data.reader;
    const result = await withComposedCommunity(client, { kind: 'page', page: loaded.page });
    if (result.kind !== 'page') return result;
    return {
      ...loaded,
      shareCard,
      page: result.page,
      overview: communityOverview(loaded.overview),
    };
  });

const readSubjectCanonical = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return {
      id: value.id,
      locale: value.locale,
      realm: validatePageRealm(value.realm),
      reader: validateReader(value.reader),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { client, authorization } = await subjectKernelClient(data.locale, data.realm, data.reader);
    return loadContextSubject(client, data.id, data.locale, { realm: data.realm, authorization });
  });

const readSubjectFrame = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.type !== 'string' ||
      value.type.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return { type: value.type, locale: value.locale };
  })
  .handler(async ({ data }) => {
    const { typeFrame } = await import('../../subject/definitions');
    return typeFrame(data.type, data.locale);
  });

const readSubjectRelations = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      !Array.isArray(value.properties) ||
      value.properties.some((item) => typeof item !== 'string' || item.length > 128) ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return { properties: value.properties as string[], locale: value.locale };
  })
  .handler(async ({ data }) => {
    const { relationLabels } = await import('../../subject/definitions');
    return relationLabels(data.properties, data.locale);
  });

const readSubjectLinks = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      (value.property !== undefined && (typeof value.property !== 'string' || value.property.length > 128)) ||
      (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 2048))
    )
      throw notFound();
    return {
      id: value.id,
      locale: value.locale,
      property: value.property as string | undefined,
      cursor: value.cursor as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    const result = await (await subjectKernelClient(data.locale)).client.subjects({ id: data.id }).links.get({
      query: {
        limit: 100,
        ...(data.property ? { property: data.property } : {}),
        ...(data.cursor ? { cursor: data.cursor } : {}),
      },
    });
    return { status: result.status, body: result.data ?? {} };
  });

const readSubjectLibrary = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      (value.subjectType !== undefined && (typeof value.subjectType !== 'string' || value.subjectType.length > 128)) ||
      (value.loadCollections !== undefined && typeof value.loadCollections !== 'boolean') ||
      (value.labelResult !== undefined && (typeof value.labelResult !== 'string' || value.labelResult.length > 64)) ||
      (value.labelUndo !== undefined &&
        (!value.labelUndo ||
          typeof value.labelUndo !== 'object' ||
          Array.isArray(value.labelUndo) ||
          typeof (value.labelUndo as Record<string, unknown>).labelId !== 'string' ||
          !(value.labelUndo as Record<string, unknown>).labelId ||
          ((value.labelUndo as Record<string, unknown>).labelId as string).length > 128 ||
          typeof (value.labelUndo as Record<string, unknown>).assignmentId !== 'string' ||
          !(value.labelUndo as Record<string, unknown>).assignmentId ||
          ((value.labelUndo as Record<string, unknown>).assignmentId as string).length > 128 ||
          !Number.isSafeInteger((value.labelUndo as Record<string, unknown>).revision) ||
          Number((value.labelUndo as Record<string, unknown>).revision) < 1))
    )
      throw notFound();
    return {
      id: value.id,
      locale: value.locale,
      subjectType: value.subjectType as string | undefined,
      loadCollections: value.loadCollections === true,
      labelResult: value.labelResult as string | undefined,
      labelUndo: value.labelUndo as SubjectLabelUndo | undefined,
    };
  })
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    setResponseHeader('cache-control', 'private, no-store');
    return loadSubjectLibrarySlot(
      (await subjectKernelClient(data.locale)).client,
      getRequest(),
      env as Partial<SessionEnv>,
      data.id,
      data.loadCollections,
      undefined,
      data.labelResult,
      data.labelUndo,
      data.subjectType,
    );
  });

const readSubjectReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return { id: value.id, locale: value.locale };
  })
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    setResponseHeader('cache-control', 'private, no-store');
    return loadReader((await subjectKernelClient(data.locale)).client, getRequest(), env as Partial<SessionEnv>);
  });

const readSubjectReactions = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return { id: value.id, locale: value.locale };
  })
  .handler(async ({ data }) => {
    return readReactionCounts((await subjectKernelClient(data.locale)).client, data.id);
  });

const readSubjectOwnReaction = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return { id: value.id, locale: value.locale };
  })
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    setResponseHeader('cache-control', 'private, no-store');
    return readOwnReaction(
      (await subjectKernelClient(data.locale)).client,
      getRequest(),
      env as Partial<SessionEnv>,
      data.id,
    );
  });

const readSubjectRatings = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return { id: value.id, locale: value.locale };
  })
  .handler(async ({ data }) => {
    return readRatings((await subjectKernelClient(data.locale)).client, data.id, null);
  });

const readSubjectOwnRating = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw notFound();
    return { id: value.id, locale: value.locale };
  })
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    setResponseHeader('cache-control', 'private, no-store');
    return readOwnRating(
      (await subjectKernelClient(data.locale)).client,
      getRequest(),
      env as Partial<SessionEnv>,
      data.id,
    );
  });

const key = (kind: string, id: string, locale: string, view?: string) =>
  [kind, id, locale, ...(view ? [view] : [])] as const;

export {
  keepSearch,
  subjectUrlForView,
  canonicalRedirect,
  accountHref,
  subjectViewPaths,
} from '../../subject/subject-href';

export const subjectPageQuery = (
  id: string,
  locale: string,
  view: View | 'overview' = 'overview',
  realm?: string,
  reader: string | null = null,
) =>
  queryOptions({
    ...publicRead,
    staleTime: 0,
    gcTime: 0,
    queryKey: [...key('subject-page', id, locale, view), realm ?? null, reader],
    retry: false,
    queryFn: async () =>
      readSubjectPage({ data: { id, locale, realm, reader, ...(view !== 'overview' ? { view } : {}) } }),
  });

export const subjectViewPagesQuery = (
  id: string,
  locale: string,
  view: View,
  cursor?: string,
  realm?: string,
  node?: string,
  reader: string | null = null,
) =>
  queryOptions({
    ...publicRead,
    staleTime: 0,
    gcTime: 0,
    queryKey: ['subject-view-pages', id, locale, view, cursor ?? null, realm ?? null, node ?? null, reader] as const,
    retry: false,
    queryFn: () =>
      readSubjectViewPages({
        data: { id, locale, view, realm, node, reader, ...(cursor !== undefined ? { cursor } : {}) },
      }),
  });

export const subjectCanonicalQuery = (id: string, locale: string, realm?: string, reader: string | null = null) =>
  queryOptions({
    ...publicRead,
    staleTime: 0,
    retry: false,
    gcTime: 0,
    queryKey: ['subject-canonical', id, locale, realm ?? null, reader] as const,
    queryFn: () => readSubjectCanonical({ data: { id, locale, realm, reader } }),
  });

export const subjectFrameQuery = (type: string, locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['subject-frame', type, locale] as const,
    queryFn: (): Promise<Awaited<ReturnType<typeof TypeFrame>>> =>
      type ? readSubjectFrame({ data: { type, locale } }) : Promise.resolve({}),
  });

export const subjectRelationsQuery = (properties: string[], locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['subject-relations', properties, locale] as const,
    queryFn: () => readSubjectRelations({ data: { properties, locale } }),
  });

export const subjectLinksQuery = (id: string, locale: string, property?: string, cursor?: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['subject-links', id, locale, property ?? null, cursor ?? null] as const,
    queryFn: () =>
      readSubjectLinks({ data: { id, locale, ...(property ? { property } : {}), ...(cursor ? { cursor } : {}) } }),
  });

export const subjectLibraryQuery = (
  id: string,
  locale: string,
  loadCollections = false,
  labelResult?: string,
  labelUndo?: SubjectLabelUndo,
  subjectType?: string,
) =>
  queryOptions({
    ...personalRead,
    queryKey: [
      'subject-library',
      id,
      locale,
      subjectType ?? null,
      ...(loadCollections ? [true] : []),
      ...(labelResult !== undefined || labelUndo
        ? [{ labelResult: labelResult ?? null, labelUndo: labelUndo ?? null }]
        : []),
    ] as const,
    queryFn: () =>
      readSubjectLibrary({
        data: { id, locale, loadCollections, labelResult, labelUndo, subjectType },
      }),
    retry: false,
  });

export const subjectReaderQuery = (id: string, locale: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['subject-reader', id, locale] as const,
    queryFn: () => readSubjectReader({ data: { id, locale } }),
    retry: false,
  });

export const subjectReactionsQuery = (id: string, locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['subject-reactions', id, locale] as const,
    queryFn: () => readSubjectReactions({ data: { id, locale } }),
  });

export const subjectRatingQuery = (id: string, locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['subject-rating', id, locale] as const,
    queryFn: () => readSubjectRatings({ data: { id, locale } }),
  });

export const subjectOwnReactionQuery = (id: string, locale: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['subject-own-reaction', id, locale] as const,
    queryFn: () => readSubjectOwnReaction({ data: { id, locale } }),
    retry: false,
  });

export const subjectOwnRatingQuery = (id: string, locale: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['subject-own-rating', id, locale] as const,
    queryFn: () => readSubjectOwnRating({ data: { id, locale } }),
    retry: false,
  });
