import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { loadSubjectPage, subjectBody } from '../pages/subject';
import { subjectKernelClient } from '../pages/subject-queries';
import { validatePageRealm } from '../pages/view-cursor';
import { contextHref } from '../pages/context-navigation';
import { explainSubjectSources, readSubjectSources, type SourcesResult } from './subject-sources';

export const loadSubjectSources = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; locale: string; realm?: string | undefined; reader?: string | null }) => {
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
    return { id: input.id, locale: input.locale, realm: validatePageRealm(input.realm), reader: input.reader };
  })
  .handler(async ({ data }): Promise<SourcesResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ kernelClient }, { readRelease }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/definitions'),
    ]);
    // Start independent reads together; missing labels must not hide permitted citations.
    const definitions = readRelease().catch(() => undefined);
    if (!data.realm) return readSubjectSources(kernelClient(data.locale), data.id, data.locale, definitions);
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
        fields: page.fields.map(({ compareHref: _compare, ...field }) => field),
        href: contextHref(page.href, data.realm),
        sourcesHref: contextHref(page.sourcesHref, data.realm),
      },
    };
  });

/** Hydrated private reading; the loader never serializes a viewer's action envelope into SSR. */
export const readCurrentSubjectSources = createServerFn({ method: 'POST', strict: false })
  .validator((input: { id: string; locale: string; expectedReader: string }) => {
    if (
      !input ||
      !/^[0-9a-f-]{36}$/i.test(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      typeof input.expectedReader !== 'string' ||
      input.expectedReader.length > 128
    )
      throw new Error('Invalid Sources reader');
    return input;
  })
  .handler(async ({ data }): Promise<SourcesResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { candidateAuthorization } = await import('../../subject/candidate-admission');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { kind: 'denied' };
    const [{ kernelClient }, { readRelease }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/definitions'),
    ]);
    return readSubjectSources(
      kernelClient(data.locale, authorization),
      data.id,
      data.locale,
      readRelease().catch(() => undefined),
      true,
    );
  });
