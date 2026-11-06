import { synopsisVisit } from '../pages/subject-summary-reading/visit';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { loadSubjectPage, subjectBody } from '../pages/subject';
import { subjectKernelClient } from '../pages/subject-queries';
import { validatePageRealm } from '../pages/view-cursor';
import { contextHref } from '../pages/context-navigation';
import { explainSubjectSources, readSubjectSources, type SourcesResult } from './subject-sources';

export const loadSubjectSources = createServerFn({ method: 'GET', strict: false })
  .validator(
    (input: {
      id: string;
      locale: string;
      realm?: string | undefined;
      via?: string | undefined;
      reader?: string | null;
    }) => {
      if (
        !input ||
        typeof input.id !== 'string' ||
        input.id.length > 128 ||
        typeof input.locale !== 'string' ||
        input.locale.length > 35 ||
        (input.reader !== undefined &&
          input.reader !== null &&
          (typeof input.reader !== 'string' || !input.reader || input.reader.length > 128))
      )
        throw new Error('Invalid subject sources request');
      if (synopsisVisit(input.via, input.id, input.locale).kind === 'invalid')
        throw new Error('Invalid synopsis visit');
      return {
        via: input.via,
        id: input.id,
        locale: input.locale,
        realm: validatePageRealm(input.realm),
        reader: input.reader,
      };
    },
  )
  .handler(async ({ data }): Promise<SourcesResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { kernelClient } = await import('../../kernel/client');
    const { readRelease } = await import('../../subject/definitions');
    // Start independent reads together; missing labels must not hide permitted citations.
    const definitions = readRelease().catch(() => undefined);
    if (!data.realm)
      return readSubjectSources(kernelClient(data.locale), data.id, data.locale, definitions, false, data.via);
    if (synopsisVisit(data.via, data.id, data.locale).kind === 'selected') return { kind: 'unsupported' };
    const { client, authorization } = await subjectKernelClient(data.locale, data.realm, data.reader);
    let loaded = await loadSubjectPage(client, data.id, undefined, data.locale, { realm: data.realm, authorization });
    if (loaded.kind === 'redirect' && loaded.target !== 'account')
      loaded = await loadSubjectPage(client, loaded.id, undefined, data.locale, { realm: data.realm, authorization });
    if (loaded.kind === 'missing') return loaded;
    if (loaded.kind !== 'page') return { kind: 'unavailable' };
    const read = subjectBody(loaded.page);
    if (!read) return { kind: 'unavailable' };
    const page = explainSubjectSources(read, data.locale, await definitions);
    return {
      kind: 'ready',
      page: {
        ...page,
        viewer: { state: 'public', actions: { state: 'unavailable' } },
        realm: data.realm,
        context: loaded.page.context,
        // A candidate comparison is a separate editorial journey with independent Context authority.
        fields: page.fields.map(({ compareHref: _compare, ...field }) => ({
          ...field,
          facts: field.facts.map(({ correctionHref: _correction, ...fact }) => fact),
        })),
        href: contextHref(page.href, data.realm),
        sourcesHref: contextHref(page.sourcesHref, data.realm),
      },
    };
  });

/** Hydrated private reading; the loader never serializes a viewer's action envelope into SSR. */
export const readCurrentSubjectSources = createServerFn({ method: 'POST', strict: false })
  .validator((input: { id: string; locale: string; expectedReader: string | null; via?: string | undefined }) => {
    if (
      !input ||
      !/^[0-9a-f-]{36}$/i.test(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      (input.expectedReader !== null && (typeof input.expectedReader !== 'string' || input.expectedReader.length > 128))
    )
      throw new Error('Invalid Sources reader');
    if (synopsisVisit(input.via, input.id, input.locale).kind === 'invalid') throw new Error('Invalid synopsis visit');
    return input;
  })
  .handler(async ({ data }): Promise<SourcesResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { getRequest } = await import('@tanstack/react-start/server');
    const { env } = await import('cloudflare:workers');
    const { prepareSession, sessionSubject, viewerCredential } = await import('../../session/request');
    const request = getRequest();
    await prepareSession(request, env);
    if ((sessionSubject(request) ?? null) !== data.expectedReader) return { kind: 'denied' };
    const authorization = viewerCredential(request) ?? undefined;
    const { kernelClient } = await import('../../kernel/client');
    const { readRelease } = await import('../../subject/definitions');
    const result = await readSubjectSources(
      kernelClient(data.locale, authorization),
      data.id,
      data.locale,
      readRelease().catch(() => undefined),
      true,
      data.via,
    );
    if (result.kind === 'ready' && result.page.viewer)
      result.page.viewer.state = data.expectedReader ? 'signed-in' : 'signed-out';
    return result;
  });
