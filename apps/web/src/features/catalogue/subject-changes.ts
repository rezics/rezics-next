import type { KernelClient } from '@rezics/client';
import { pageText } from '../pages/shared';
import { originalLanguage } from '../../subject/language';
import { candidateContext } from '../../subject/candidates';
import { subjectHref } from '../../subject/subject-href';
import type { SourceDefinitions } from './subject-sources';
import { readSubjectRevisionDetail, type RevisionDetailPort } from './subject-changes-detail';

/** Metadata comes from the generated native listing, never from a second history store. */
type NativePage = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['revisions']['get']>>['data']>;
type NativeViewerActionsResponse = Awaited<ReturnType<KernelClient['viewerActions']['post']>>;
export type RevisionRow = Pick<NativePage['revisions'][number], 'revision' | 'kind'>;
export type CurrentOperation = 'subject.propose' | 'subject.terms';
export type CurrentOperationsRead =
  | { state: 'available'; operations: CurrentOperation[] }
  | { state: 'preparing' }
  | { state: 'unavailable' };
export type ChangesFailure = {
  kind: 'missing' | 'denied' | 'invalid' | 'conflict' | 'preparing' | 'unavailable';
  scope?: 'subject';
  currentOperations?: CurrentOperationsRead;
};
export type ChangesPage = {
  id: string;
  title: ReturnType<typeof pageText>;
  typeLabel: ReturnType<typeof pageText>;
  href: string;
  revisions: RevisionRow[];
  next: string | null;
  currentOperations?: CurrentOperationsRead;
};
export type ChangesRead = ChangesFailure | { kind: 'ready'; page: ChangesPage; session?: string };
export type NativeRevisionDetail = NonNullable<
  Awaited<ReturnType<ReturnType<ReturnType<KernelClient['subjects']>['revisions']>['get']>>['data']
>;
type NativeCandidate = Extract<NativeRevisionDetail['change'], { kind: 'candidate' }>;
type NativeDecision = Extract<NativeRevisionDetail['change'], { kind: 'decision' }>;
type NativeAdoption = Extract<NativeRevisionDetail['change'], { kind: 'adoption' }>;

/** Presentation of the generated native response.
 * Only an adapter of the published closed producer response may supply these values.
 * Historical values, actors, sources, tokens and write bases are deliberately absent.
 */
export type ChangeSummary =
  | { kind: 'limited' }
  | Extract<NativeRevisionDetail['change'], { kind: 'terms' }>
  | (Pick<NativeCandidate, 'kind' | 'candidate' | 'property'> & Partial<Pick<NativeCandidate, 'context' | 'reading'>>)
  | (Pick<NativeDecision, 'kind' | 'candidate' | 'property' | 'context'> & {
      decision: NativeDecision['verdict'];
    } & Partial<Pick<NativeDecision, 'head' | 'reading'>>)
  | (Pick<NativeAdoption, 'kind' | 'property' | 'context'> &
      Partial<Pick<NativeAdoption, 'head' | 'mode' | 'selection'>>);
export type ChangeDetail = {
  id: string;
  revision: number;
  summary: ChangeSummary;
  metadata?: NativeRevisionDetail['revision'];
  /** Localized, emitted definition labels. Missing labels remain neutral. */
  propertyLabel?: ReturnType<typeof pageText>;
};
export type DetailRead =
  | ChangesFailure
  | {
      kind: 'ready';
      detail: ChangeDetail;
      currentOperations?: CurrentOperationsRead;
      session?: string;
    };
export type ChangesTransport = {
  list: (cursor?: string, session?: string) => Promise<ChangesRead>;
  detail: (revision: number, session?: string) => Promise<DetailRead>;
};
export type ChangesState = {
  page?: ChangesPage | undefined;
  selected?: number | undefined;
  detail?: DetailRead | undefined;
  failure?: ChangesFailure | undefined;
  loading?: 'list' | 'more' | 'detail' | undefined;
  currentOperations?: CurrentOperationsRead | undefined;
};
export type ChangesEvent =
  | { type: 'list-start'; more: boolean }
  | { type: 'list'; result: ChangesRead; more: boolean }
  | { type: 'detail-start'; revision: number }
  | { type: 'detail'; result: DetailRead };

export function changesState(state: ChangesState, event: ChangesEvent): ChangesState {
  if (event.type === 'list-start')
    return event.more
      ? { ...state, failure: undefined, loading: 'more', currentOperations: { state: 'unavailable' } }
      : { loading: 'list', currentOperations: { state: 'unavailable' } };
  if (event.type === 'detail-start')
    // Discard the previous authorized payload before each read, including retries.
    return {
      ...state,
      selected: event.revision,
      detail: undefined,
      loading: 'detail',
      currentOperations: { state: 'unavailable' },
    };
  if (event.type === 'detail') {
    const currentOperations = event.result.currentOperations ?? { state: 'unavailable' as const };
    if (event.result.kind !== 'ready' && event.result.scope === 'subject')
      return { failure: event.result, currentOperations: { state: 'unavailable' } };
    if (
      event.result.kind === 'ready' &&
      (event.result.detail.id !== state.page?.id || event.result.detail.revision !== state.selected)
    )
      return { ...state, loading: undefined, detail: { kind: 'unavailable' }, currentOperations };
    return { ...state, loading: undefined, detail: event.result, currentOperations };
  }
  if (event.result.kind !== 'ready') {
    const currentOperations = event.result.currentOperations ?? { state: 'unavailable' as const };
    if (event.result.kind === 'missing' || event.result.kind === 'denied')
      return { failure: event.result, currentOperations: { state: 'unavailable' } };
    return { ...state, loading: undefined, failure: event.result, currentOperations };
  }
  const page = event.result.page;
  if (state.page && state.page.id !== page.id) return { failure: { kind: 'unavailable' } };
  return {
    ...(event.more ? state : {}),
    loading: undefined,
    failure: undefined,
    currentOperations: page.currentOperations ?? { state: 'unavailable' },
    page:
      event.more && state.page
        ? {
            ...page,
            revisions: [
              ...new Map([...state.page.revisions, ...page.revisions].map((row) => [row.revision, row])).values(),
            ].slice(-100),
          }
        : page,
  };
}

function problemCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const code = Reflect.get(value, 'code');
  return typeof code === 'string' ? code : undefined;
}

export function changesFailure(status: number, error?: unknown): ChangesFailure {
  return {
    kind:
      status === 404
        ? 'missing'
        : status === 401 || status === 403
          ? 'denied'
          : status === 400 || status === 422
            ? 'invalid'
            : status === 409
              ? 'conflict'
              : status === 503 && problemCode(error) === 'semantic_not_ready'
                ? 'preparing'
                : 'unavailable',
  };
}

function currentOperationsRead(
  result: NativeViewerActionsResponse | null,
  id: string,
  type: string,
): CurrentOperationsRead {
  if (!result) return { state: 'unavailable' };
  if (result.status === 503 && problemCode(result.error?.value) === 'semantic_not_ready') return { state: 'preparing' };
  if (result.status !== 200 || !result.data || result.data.resources.length !== 2) return { state: 'unavailable' };
  const context = result.data.resources.filter(
    (resource) => resource.type === 'semantic.context' && resource.id === candidateContext,
  );
  const subject = result.data.resources.filter((resource) => resource.type === type && resource.id === id);
  if (context.length !== 1 || subject.length !== 1 || 'error' in context[0]! || 'error' in subject[0]!)
    return { state: 'unavailable' };
  const component = context[0]!.viewerActions;
  if (component.length > 64 || component.reduce((count, entry) => count + entry.operations.length, 0) > 256)
    return { state: 'unavailable' };
  const supported = new Set<CurrentOperation>(['subject.propose', 'subject.terms']);
  return {
    state: 'available',
    operations: [
      ...new Set(
        component
          .filter((entry) => entry.action === 'statement:propose')
          .flatMap((entry) => entry.operations)
          .filter((operation): operation is CurrentOperation => supported.has(operation as CurrentOperation)),
      ),
    ],
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenOf = (headers: HeadersInit | undefined, fallback?: string) =>
  new Headers(headers).get('rezics-session-token') ?? fallback;

export async function readSubjectChanges(
  client: KernelClient,
  id: string,
  locale: string,
  options: {
    authorization?: string | undefined;
    cursor?: string | undefined;
    session?: string | undefined;
    definitions?: Promise<SourceDefinitions | undefined>;
  } = {},
): Promise<ChangesRead> {
  if (!uuid.test(id)) return { kind: 'missing' };
  try {
    const headers = {
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.session ? { 'rezics-session-token': options.session } : {}),
    };
    const [current, revisions, definitions] = await Promise.all([
      // Navigation returns to the actual PUBLIC reading, with no privileged fallback.
      client.subjects({ id }).get({
        fetch: { redirect: 'manual', cache: 'no-store' },
        ...(options.session ? { headers: { 'rezics-session-token': options.session } } : {}),
      }),
      client
        .subjects({ id })
        .revisions.get({
          query: { limit: 20, ...(options.cursor !== undefined ? { cursor: options.cursor } : {}) },
          headers,
          fetch: { cache: 'no-store', redirect: 'manual' },
        })
        .catch(() => null),
      options.definitions?.catch(() => undefined),
    ]);
    if (current.status !== 200 || !current.data) {
      const failure = changesFailure(current.status, current.error?.value);
      return {
        ...failure,
        ...(['missing', 'denied'].includes(failure.kind) ? { scope: 'subject' as const } : {}),
      };
    }
    if (current.data.subject.id !== id) return { kind: 'unavailable', scope: 'subject' };
    const currentActions = await client.viewerActions
      .post(
        {
          resources: [
            { type: 'semantic.context', id: candidateContext },
            { type: current.data.subject.type, id },
          ],
        },
        { headers, fetch: { cache: 'no-store', redirect: 'manual' } },
      )
      .catch(() => null);
    const currentOperations = currentOperationsRead(currentActions, id, current.data.subject.type);
    if (!revisions) return { kind: 'unavailable', currentOperations };
    if (revisions.status !== 200 || !revisions.data)
      return { ...changesFailure(revisions.status, revisions.error?.value), currentOperations };
    const title = pageText(current.data.subject.labels, locale, originalLanguage(current.data.subject));
    const session = tokenOf(revisions.headers, options.session);
    return {
      kind: 'ready',
      page: {
        id,
        title,
        typeLabel: pageText(definitions?.types[current.data.subject.type]?.labels, locale),
        href: subjectHref({ id, label: title.text }, locale).href,
        // No provenance or release identifiers are serialized into the private page model.
        revisions: revisions.data.revisions.map(({ revision, kind }) => ({ revision, kind })),
        next: revisions.data.next,
        currentOperations,
      },
      ...(session ? { session } : {}),
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function readSubjectChange(
  client: KernelClient,
  id: string,
  revision: number,
  options: {
    authorization?: string | undefined;
    session?: string | undefined;
    locale?: string;
    definitions?: Promise<SourceDefinitions | undefined>;
  } = {},
  port: RevisionDetailPort = readSubjectRevisionDetail,
): Promise<DetailRead> {
  if (!uuid.test(id) || !Number.isSafeInteger(revision) || revision < 1) return { kind: 'invalid' };
  try {
    const [current, detail] = await Promise.all([
      client.subjects({ id }).get({
        fetch: { cache: 'no-store', redirect: 'manual' },
        ...(options.session ? { headers: { 'rezics-session-token': options.session } } : {}),
      }),
      port(client, { id, revision, ...options, locale: options.locale ?? 'en' }).catch((): DetailRead => ({
        kind: 'unavailable',
      })),
    ]);
    if ([401, 403, 404].includes(current.status) || (current.status === 200 && !current.data))
      return { ...changesFailure(current.status, current.error?.value), scope: 'subject' };
    if (current.status === 200 && current.data?.subject.id !== id) return { kind: 'unavailable', scope: 'subject' };
    const currentActions =
      current.status === 200 && current.data?.subject.id === id
        ? await client.viewerActions
            .post(
              {
                resources: [
                  { type: 'semantic.context', id: candidateContext },
                  { type: current.data.subject.type, id },
                ],
              },
              {
                headers: {
                  ...(options.authorization ? { authorization: options.authorization } : {}),
                  ...(options.session ? { 'rezics-session-token': options.session } : {}),
                },
                fetch: { cache: 'no-store', redirect: 'manual' },
              },
            )
            .catch(() => null)
        : null;
    const currentOperations =
      current.status === 200 && current.data?.subject.id === id
        ? currentOperationsRead(currentActions, id, current.data.subject.type)
        : current.status === 503 && problemCode(current.error?.value) === 'semantic_not_ready'
          ? { state: 'preparing' as const }
          : { state: 'unavailable' as const };
    if (detail.kind !== 'ready') return detail;
    if (detail.detail.id !== id || detail.detail.revision !== revision)
      return { kind: 'unavailable', currentOperations };
    if ('property' in detail.detail.summary && options.definitions) {
      const definitions = await options.definitions.catch(() => undefined);
      detail.detail.propertyLabel = pageText(
        definitions?.properties[detail.detail.summary.property]?.labels,
        options.locale ?? 'en',
      );
    }
    return { ...detail, currentOperations };
  } catch {
    return { kind: 'unavailable' };
  }
}
