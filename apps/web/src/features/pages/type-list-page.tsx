import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import { hasSelectedRealmTarget, typeListTargetFromPage } from './type-list-model';
import { typeListQuery, type TypeListAdmissionInput, type TypeListQueryResult } from './type-list-query';
import type { TypeListTarget } from './type-list-model';
import { findTypeList } from './type-list-model';
import type { SubjectPageData } from './subject';
import { PageData } from './data';
import { TypeList } from './type-list';
import { subjectPageMessages } from './route-support';

type ConfiguredListProps = {
  list: string;
  page: string;
  cursor?: string;
  locale: string;
  initialData?: TypeListQueryResult;
};

type ReaderRequest = TypeListQueryResult['admission']['request'];

function sameReaderRequest(
  request: ReaderRequest | undefined,
  input: { state: TypeListAdmissionInput['state']; expectedReader: string | null | undefined },
  locale: string,
  node: string,
  page: string,
  cursor?: string,
): request is ReaderRequest {
  return !!request &&
    request.locale === locale &&
    request.node === node &&
    request.page === page &&
    request.cursor === cursor &&
    request.state === input.state &&
    request.expectedReader === input.expectedReader;
}

function freshIncarnation(): string {
  return crypto.randomUUID();
}

/** A route list observes the current session before admitting rows or continuation controls. */
export function ConfiguredList({ list, page, cursor, locale, initialData }: ConfiguredListProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const target = typeListTargetFromPage(page);
  const selectedRealm = hasSelectedRealmTarget(target);
  const state: TypeListAdmissionInput['state'] = selectedRealm ? session.state : 'public';
  const expectedReader =
    !selectedRealm || state === 'unknown'
      ? undefined
      : state === 'signed-in'
        ? (session.subject ?? null)
        : null;
  const requestMatches = sameReaderRequest(
    initialData?.admission.request,
    { state, expectedReader },
    locale,
    list,
    page,
    cursor,
  );
  const mode: TypeListAdmissionInput['mode'] =
    !selectedRealm
      ? 'public'
      : state === 'unknown' && requestMatches && initialData.admission.request.mode === 'initial-hydration'
        ? 'initial-hydration'
        : 'current';
  const readerScope = JSON.stringify([
    locale,
    list,
    page,
    cursor ?? null,
    state,
    expectedReader === undefined ? ['unobserved'] : expectedReader === null ? ['anonymous'] : ['reader', expectedReader],
    mode,
  ]);
  type TrackedAdmission = {
    readerScope: string;
    incarnation: string;
    sourceToken: string | null;
    usedLoaderTokens: Set<string>;
  };
  const sourceToken = initialData?.admission.request.incarnation ?? null;
  const matchingLoaderToken = requestMatches ? sourceToken : null;
  const [tracked, setTracked] = useState<TrackedAdmission>(() => {
    const incarnation = matchingLoaderToken ?? (selectedRealm ? freshIncarnation() : 'public');
    return {
      readerScope,
      incarnation,
      sourceToken,
      usedLoaderTokens: new Set(matchingLoaderToken ? [matchingLoaderToken] : []),
    };
  });
  let current = tracked;
  if (tracked.readerScope !== readerScope || tracked.sourceToken !== sourceToken) {
    const usedLoaderTokens = new Set(tracked.usedLoaderTokens);
    const incarnation =
      !selectedRealm
        ? 'public'
        : matchingLoaderToken && !usedLoaderTokens.has(matchingLoaderToken)
          ? matchingLoaderToken
          : freshIncarnation();
    if (matchingLoaderToken) usedLoaderTokens.add(matchingLoaderToken);
    current = { readerScope, incarnation, sourceToken, usedLoaderTokens };
    setTracked(current);
  }
  const incarnation = current.incarnation;
  const admission: TypeListAdmissionInput = {
    state,
    ...(expectedReader !== undefined ? { expectedReader } : {}),
    incarnation,
    mode,
  };
  const options = typeListQuery(locale, list, page, cursor, admission);
  const loaderResult =
    requestMatches &&
    initialData?.admission.request.incarnation === incarnation &&
    initialData.admission.request.mode === mode
      ? initialData
      : undefined;
  const query = useQuery({
    ...options,
    ...(loaderResult ? { initialData: loaderResult, initialDataUpdatedAt: Date.now() } : {}),
  });
  const queryKey = options.queryKey;
  const queryKeyHash = JSON.stringify(queryKey);
  useEffect(() => {
    if (!selectedRealm) return;
    const retiredKey = queryKey;
    return () => {
      void queryClient.cancelQueries({ queryKey: retiredKey, exact: true });
      queryClient.removeQueries({ queryKey: retiredKey, exact: true });
    };
  }, [queryClient, queryKeyHash, selectedRealm]);

  if (query.isError) throw query.error;
  const result = query.data;
  if (!result || result.kind !== 'ready') return null;
  const request = result.admission.request;
  const isCurrentResult =
    request.locale === locale &&
    request.node === list &&
    request.page === page &&
    request.cursor === cursor &&
    request.state === state &&
    request.expectedReader === expectedReader &&
    request.incarnation === incarnation &&
    request.mode === mode &&
    request.realm === (selectedRealm ? target.realm : null) &&
    result.node === list &&
    JSON.stringify(result.target) === JSON.stringify(target) &&
    result.admission.context === (result.page.context?.id ?? null) &&
    (selectedRealm
      ? state === 'unknown'
        ? mode === 'initial-hydration' && !query.isFetchedAfterMount
        : result.admission.reader === expectedReader
      : result.admission.reader === null);
  if (!isCurrentResult) return null;
  return <TypeListPage page={result.page} target={result.target} node={result.node} locale={locale} />;
}

export function TypeListPage({
  page,
  target,
  node,
  locale,
}: {
  page: SubjectPageData;
  target: TypeListTarget;
  node: string;
  locale: string;
}) {
  const list = findTypeList(page.document, node);
  if (!list) return null;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageData
        locale={locale}
        subject={page.subject}
        document={page.document}
        reads={page.reads}
        context={page.context}
        continuation={page.continuation}
        {...(page.account ? { account: page.account } : {})}
        listTarget={target}
        fullList={node}
        messages={subjectPageMessages()}
      >
        <TypeList {...list.props} />
      </PageData>
    </div>
  );
}
