import { queryOptions } from '@tanstack/react-query';
import { notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { requestLanguages } from '../../kernel/languages';
import { kernelClient } from '../../kernel/client';
import { findTypeList, typeListHref, typeListTarget, type TypeListTarget } from './type-list-model';
import { isRecord } from './shared';
import type { SubjectPageData } from './subject';

const readTypeList = createServerFn({ method: 'GET', strict: false })
  .validator((value: { locale: string; node: string; page: string; cursor?: string }) => {
    if (
      !value.locale ||
      value.locale.length > 35 ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.node) ||
      value.page.length > 2048 ||
      (value.cursor !== undefined && (!value.cursor || value.cursor.length > 4864))
    )
      throw notFound();
    try {
      return { ...value, target: typeListTarget(JSON.parse(value.page)) };
    } catch {
      throw notFound();
    }
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    let authorization: string | undefined;
    if ('subject' in data.target && data.target.realm) {
      const { env } = await import('cloudflare:workers');
      const { prepareSession, viewerCredential } = await import('../../session/request');
      await prepareSession(getRequest(), env as Partial<import('../../session/client').SessionEnv>);
      authorization = viewerCredential(getRequest()) ?? undefined;
    }
    const result = await kernelClient(data.locale).pages.$read.post(
      {
        target: data.target,
        languages: requestLanguages(data.locale),
        ...(data.cursor ? { continuation: { node: data.node, cursor: data.cursor } } : {}),
      },
      { fetch: { redirect: 'manual' }, ...(authorization ? { headers: { authorization } } : {}) },
    );
    if (result.status === 404) throw notFound();
    if (result.status === 308) {
      const body = result.data ?? result.error?.value;
      if (isRecord(body) && isRecord(body.redirect) && typeof body.redirect.to === 'string')
        throw redirect({
          href: typeListHref(
            data.locale,
            { account: body.redirect.to, ...('view' in data.target ? { view: data.target.view } : {}) },
            data.node,
            data.cursor,
          ),
          statusCode: 308,
        });
    }
    if (result.status !== 200 || !result.data) throw new Error('presentation_not_ready');
    const response = result.data;
    const target: TypeListTarget =
      'subject' in data.target && response.subject && response.subject !== data.target.subject
        ? { ...data.target, subject: response.subject }
        : data.target;
    if (JSON.stringify(target) !== JSON.stringify(data.target))
      throw redirect({ href: typeListHref(data.locale, target, data.node, data.cursor), statusCode: 308 });
    const page = {
      ...response,
      subject: response.subject ?? null,
      ...(response.account && 'account' in target
        ? { account: { id: response.account, handle: target.account } }
        : { account: undefined }),
    } as SubjectPageData;
    if (!findTypeList(page.document, data.node)) throw notFound();
    return { page, target, node: data.node };
  });

export const typeListQuery = (locale: string, node: string, page: string, cursor?: string) =>
  queryOptions({
    queryKey: ['configured-type-list', 'anonymous-or-selected-realm', locale, node, page, cursor],
    staleTime: 0,
    gcTime: 0,
    queryFn: () => readTypeList({ data: { locale, node, page, ...(cursor !== undefined ? { cursor } : {}) } }),
  });
