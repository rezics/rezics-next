import { queryOptions } from '@tanstack/react-query';
import { notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { configuredListRetryAdmission } from './configured-list-retry-admission';
import type { SessionState } from '../../session/state';
import { requestLanguages } from '../../kernel/languages';
import { kernelClient } from '../../kernel/client';
import {
  findTypeList,
  hasSelectedRealmTarget,
  typeListHref,
  typeListTarget,
  typeListTargetFromPage,
  type TypeListTarget,
} from './type-list-model';
import { isRecord } from './shared';
import type { SubjectPageData } from './subject';

export type TypeListReaderState = 'unknown' | SessionState | 'public';
export type TypeListAdmissionMode = 'initial-hydration' | 'current' | 'public';

export type TypeListAdmissionInput = {
  state: TypeListReaderState;
  expectedReader?: string | null;
  incarnation: string;
  mode: TypeListAdmissionMode;
};

type TypeListReadRequest = {
  locale: string;
  node: string;
  page: string;
  cursor?: string;
  state: TypeListReaderState;
  expectedReader?: string | null;
  incarnation: string;
  mode: TypeListAdmissionMode;
  target: TypeListTarget;
  realm: string | null;
};

type TypeListReadAdmission = {
  request: TypeListReadRequest;
  reader: string | null;
  context: string | null;
};

export type TypeListQueryResult =
  | { kind: 'ready'; page: SubjectPageData; target: TypeListTarget; node: string; admission: TypeListReadAdmission }
  | { kind: 'admission-mismatch'; node: string; admission: { request: TypeListReadRequest } }
  | {
      kind: 'unavailable';
      admission: { request: TypeListReadRequest };
      retryAt?: number;
    };

type TypeListQueryLifetime = { isCurrent: () => boolean };

function selectedRealmReader(value: unknown): value is string | null | undefined {
  return (
    value === undefined || value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128)
  );
}

function readRequest(data: {
  locale: string;
  node: string;
  page: string;
  cursor?: string;
  state: TypeListReaderState;
  expectedReader?: string | null;
  incarnation: string;
  mode: TypeListAdmissionMode;
  target: TypeListTarget;
}): TypeListReadRequest {
  const realm = hasSelectedRealmTarget(data.target) ? data.target.realm : null;
  return {
    locale: data.locale,
    node: data.node,
    page: data.page,
    ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
    state: data.state,
    ...(data.expectedReader !== undefined ? { expectedReader: data.expectedReader } : {}),
    incarnation: data.incarnation,
    mode: data.mode,
    target: data.target,
    realm,
  };
}

const readTypeList = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const value = isRecord(input) ? input : {};
    if (
      typeof value.locale !== 'string' ||
      !value.locale ||
      value.locale.length > 35 ||
      typeof value.node !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.node) ||
      typeof value.page !== 'string' ||
      value.page.length > 2048 ||
      (value.cursor !== undefined &&
        (typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > 4864)) ||
      (value.expectedReader !== undefined && !selectedRealmReader(value.expectedReader)) ||
      !['unknown', 'signed-in', 'signed-out', 'unavailable', 'public'].includes(value.state as string) ||
      typeof value.incarnation !== 'string' ||
      !value.incarnation ||
      value.incarnation.length > 128 ||
      !['initial-hydration', 'current', 'public'].includes(value.mode as string)
    )
      throw notFound();
    let target: TypeListTarget;
    try {
      target = typeListTarget(JSON.parse(value.page));
    } catch {
      throw notFound();
    }
    const selectedRealm = hasSelectedRealmTarget(target);
    if (
      (selectedRealm &&
        (value.state === 'public' ||
          value.mode === 'public' ||
          (value.state === 'unknown' && value.expectedReader !== undefined) ||
          (value.state !== 'unknown' && value.expectedReader === undefined) ||
          ((value.state === 'signed-out' || value.state === 'unavailable') && value.expectedReader !== null) ||
          (value.mode === 'initial-hydration' && value.state !== 'unknown'))) ||
      (!selectedRealm &&
        (value.state !== 'public' ||
          value.mode !== 'public' ||
          value.expectedReader !== undefined ||
          value.incarnation !== 'public'))
    )
      throw notFound();
    return {
      locale: value.locale,
      node: value.node,
      page: value.page,
      target,
      ...(value.cursor !== undefined ? { cursor: value.cursor } : {}),
      state: value.state as TypeListReaderState,
      ...(value.expectedReader !== undefined ? { expectedReader: value.expectedReader as string | null } : {}),
      incarnation: value.incarnation,
      mode: value.mode as TypeListAdmissionMode,
    };
  })
  .handler(async ({ data }): Promise<TypeListQueryResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const admissionRequest = readRequest(data);
    let authorization: string | undefined;
    let reader: string | null = null;

    if (hasSelectedRealmTarget(data.target)) {
      const { env } = await import('cloudflare:workers');
      const { prepareSession, sessionSubject, viewerCredential } = await import('../../session/request');
      await prepareSession(request, env as Partial<import('../../session/client').SessionEnv>);
      authorization = viewerCredential(request) ?? undefined;
      if (authorization) {
        const subject = sessionSubject(request);
        reader =
          subject ??
          `credential:${Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authorization))),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('')}`;
      }
      if (data.expectedReader !== undefined && reader !== data.expectedReader)
        return { kind: 'admission-mismatch', node: data.node, admission: { request: admissionRequest } };
    }

    const result = await kernelClient(data.locale).pages.$read.post(
      {
        target: data.target,
        languages: requestLanguages(data.locale),
        ...(data.cursor !== undefined ? { continuation: { node: data.node, cursor: data.cursor } } : {}),
      },
      authorization ? { fetch: { redirect: 'manual' }, headers: { authorization } } : { fetch: { redirect: 'manual' } },
    );
    if (result.status === 404) throw notFound();
    if (result.status === 308) {
      const body: unknown = result.data ?? result.error?.value;
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
    if (result.status !== 200 || !result.data) {
      return {
        kind: 'unavailable',
        admission: { request: admissionRequest },
        ...configuredListRetryAdmission(result.status, result.response?.headers),
      };
    }
    const response = result.data;
    const target: TypeListTarget =
      'subject' in data.target && response.subject && response.subject !== data.target.subject
        ? { ...data.target, subject: response.subject }
        : data.target;
    if (JSON.stringify(target) !== JSON.stringify(data.target))
      throw redirect({ href: typeListHref(data.locale, target, data.node, data.cursor), statusCode: 308 });
    const now = Date.now();
    const reads = Object.fromEntries(
      Object.entries(response.reads).map(([key, read]) => [
        key,
        {
          status: read.status,
          body: read.body,
          ...configuredListRetryAdmission(read.status, read.headers, now),
        },
      ]),
    );
    const page = {
      ...response,
      reads,
      subject: response.subject ?? null,
      ...(response.account && 'account' in target
        ? { account: { id: response.account, handle: target.account } }
        : { account: undefined }),
    } as SubjectPageData;
    if (!findTypeList(page.document, data.node)) throw notFound();
    return {
      kind: 'ready',
      page,
      target,
      node: data.node,
      admission: {
        request: admissionRequest,
        reader,
        context: page.context?.id ?? null,
      },
    };
  });

export const typeListQuery = (
  locale: string,
  node: string,
  page: string,
  cursor: string | undefined,
  admission: TypeListAdmissionInput,
  lifetime?: TypeListQueryLifetime,
) => {
  const target = typeListTargetFromPage(page);
  const selectedRealm = hasSelectedRealmTarget(target);
  const state: TypeListReaderState = selectedRealm ? admission.state : 'public';
  const expectedReader = selectedRealm ? admission.expectedReader : undefined;
  const incarnation = selectedRealm ? admission.incarnation : 'public';
  const mode: TypeListAdmissionMode = selectedRealm ? admission.mode : 'public';
  const expectedReaderKey =
    expectedReader === undefined
      ? ['unobserved']
      : expectedReader === null
        ? ['anonymous']
        : ['reader', expectedReader];
  return queryOptions({
    queryKey: ['configured-type-list', locale, node, page, cursor ?? null, state, expectedReaderKey, mode, incarnation],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: mode !== 'initial-hydration',
    queryFn: async ({ signal }) => {
      if (lifetime && !lifetime.isCurrent()) throw new Error('Retired configured list');
      await Promise.resolve();
      if (signal.aborted || (lifetime && !lifetime.isCurrent())) throw new Error('Retired configured list');
      let result: TypeListQueryResult;
      try {
        result = await readTypeList({
          data: {
            locale,
            node,
            page,
            ...(cursor !== undefined ? { cursor } : {}),
            state,
            ...(expectedReader !== undefined ? { expectedReader } : {}),
            incarnation,
            mode,
          },
        });
      } catch (error) {
        if (signal.aborted || (lifetime && !lifetime.isCurrent())) throw new Error('Retired configured list');
        throw error;
      }
      if (signal.aborted || (lifetime && !lifetime.isCurrent())) throw new Error('Retired configured list');
      return result;
    },
  });
};
