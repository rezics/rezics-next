import { queryOptions } from '@tanstack/react-query';
import { isView, type View } from '@rezics/composition';
import { notFound } from '@tanstack/react-router';
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { personalRead, publicRead } from '../../kernel/query';
import { loadSubjectLibrarySlot, type SubjectLabelUndo } from '../../library/subject-slot';
import type { SessionEnv } from '../../session/client';
import { loadReader } from '../../subject/load-reader';
import type { LoadedSubject } from '../../subject/load-subject';
import type { typeFrame as TypeFrame } from '../../subject/definitions';
import { locales } from '../../paraglide/runtime.js';
import type { PagePaths } from '../../shell/head';
import { validatePageRealm, validatePageNode, validateViewCursor } from './view-cursor';
import { loadSubjectPage } from './subject';
import { readRatings, readOwnRating } from './subject-ratings';
import { readReactionCounts, readOwnReaction } from './subject-reactions';

const subjectKernelClient = createServerOnlyFn(async (locale: string) => {
  const { kernelClient } = await import('../../kernel/client');
  // Eden's treaty client is thenable; wrap it so this async boundary does not make a request to /v1.
  const { env } = await import('cloudflare:workers');
  const { prepareSession, viewerCredential } = await import('../../session/request');
  setResponseHeader('cache-control', 'private, no-store');
  await prepareSession(getRequest(), env as Partial<SessionEnv>);
  return { client: kernelClient(locale), authorization: viewerCredential(getRequest()) ?? undefined };
});

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
    };
  })
  .handler(async ({ data }) => {
    const { client, authorization } = await subjectKernelClient(data.locale);
    return loadSubjectPage(client, data.id, data.view, data.locale, { realm: data.realm, authorization });
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
      node: validatePageNode(value.node),
    };
  })
  .handler(async ({ data }) => {
    const { loadViewPages } = await import('./subject-frame');
    const { client, authorization } = await subjectKernelClient(data.locale);
    return loadViewPages(client, data.id, data.view, data.locale, data.cursor, {
      realm: data.realm,
      node: data.node,
      authorization,
    });
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
    return { id: value.id, locale: value.locale };
  })
  .handler(async ({ data }) => {
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    return loadSubject(kernelClient(data.locale), data.id, data.locale as never);
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

export function subjectUrlForView(subject: LoadedSubject, view?: string): string {
  return view && !subject.href.includes('/@') ? `${subject.href}/${encodeURIComponent(view)}` : subject.href;
}

export function keepSearch(href: string, search: string): string {
  return `${encodeURI(href)}${search ? (search.startsWith('?') ? search : `?${search}`) : ''}`;
}

export function subjectViewPaths(paths: PagePaths, view: string): PagePaths {
  return Object.fromEntries(
    locales.map((locale) => [locale, `${paths[locale]}/${encodeURIComponent(view)}`]),
  ) as PagePaths;
}

export const subjectPageQuery = (id: string, locale: string, view: View | 'overview' = 'overview', realm?: string) =>
  queryOptions({
    ...publicRead,
    staleTime: 0,
    gcTime: 0,
    queryKey: [...key('subject-page', id, locale, view), realm ?? null],
    queryFn: async () => readSubjectPage({ data: { id, locale, realm, ...(view !== 'overview' ? { view } : {}) } }),
  });

export const subjectViewPagesQuery = (
  id: string,
  locale: string,
  view: View,
  cursor?: string,
  realm?: string,
  node?: string,
) =>
  queryOptions({
    ...publicRead,
    staleTime: 0,
    gcTime: 0,
    queryKey: ['subject-view-pages', id, locale, view, cursor ?? null, realm ?? null, node ?? null] as const,
    queryFn: () =>
      readSubjectViewPages({ data: { id, locale, view, realm, node, ...(cursor !== undefined ? { cursor } : {}) } }),
  });

export const subjectCanonicalQuery = (id: string, locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['subject-canonical', id, locale] as const,
    queryFn: () => readSubjectCanonical({ data: { id, locale } }),
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
