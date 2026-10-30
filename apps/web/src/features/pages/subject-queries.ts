import { queryOptions } from '@tanstack/react-query';
import { isView, type View } from '@rezics/composition';
import { notFound } from '@tanstack/react-router';
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { personalRead, publicRead } from '../../kernel/query';
import { loadSubjectLibrarySlot } from '../../library/subject-slot';
import type { SessionEnv } from '../../session/client';
import { loadReader } from '../../subject/load-reader';
import type { LoadedSubject } from '../../subject/load-subject';
import type { typeFrame as TypeFrame } from '../../subject/definitions';
import { locales } from '../../paraglide/runtime.js';
import type { PagePaths } from '../../shell/head';
import { loadSubjectPage } from './subject';
import { readRatings, readOwnRating } from './subject-ratings';
import { readReactionCounts, readOwnReaction } from './subject-reactions';

const subjectKernelClient = createServerOnlyFn(async (locale: string) => {
  const { kernelClient } = await import('../../kernel/client');
  // Eden's treaty client is thenable; wrap it so this async boundary does not make a request to /v1.
  return { client: kernelClient(locale) };
});

const readSubjectPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35 ||
      (value.view !== undefined && !isView(value.view))
    )
      throw notFound();
    return { id: value.id, locale: value.locale, view: value.view as View | undefined };
  })
  .handler(async ({ data }) => {
    return loadSubjectPage((await subjectKernelClient(data.locale)).client, data.id, data.view, data.locale);
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
      (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 2048))
    )
      throw notFound();
    return {
      id: value.id,
      locale: value.locale,
      view: value.view,
      cursor: value.cursor as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    const { loadViewPages } = await import('./subject-frame');
    return loadViewPages((await subjectKernelClient(data.locale)).client, data.id, data.view, data.locale, data.cursor);
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
      (value.loadCollections !== undefined && typeof value.loadCollections !== 'boolean')
    )
      throw notFound();
    return { id: value.id, locale: value.locale, loadCollections: value.loadCollections === true };
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

export const subjectPageQuery = (id: string, locale: string, view: View | 'overview' = 'overview') =>
  queryOptions({
    ...publicRead,
    queryKey: key('subject-page', id, locale, view),
    queryFn: async () => readSubjectPage({ data: { id, locale, ...(view !== 'overview' ? { view } : {}) } }),
  });

export const subjectViewPagesQuery = (id: string, locale: string, view: View, cursor?: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['subject-view-pages', id, locale, view, cursor ?? null] as const,
    queryFn: () => readSubjectViewPages({ data: { id, locale, view, ...(cursor !== undefined ? { cursor } : {}) } }),
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

export const subjectLibraryQuery = (id: string, locale: string, loadCollections = false) =>
  queryOptions({
    ...personalRead,
    queryKey: ['subject-library', id, locale, ...(loadCollections ? [true] : [])] as const,
    queryFn: () => readSubjectLibrary({ data: { id, locale, loadCollections } }),
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
