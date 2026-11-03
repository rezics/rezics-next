import type { KernelClient } from '@rezics/client';
import { pageText } from '../pages/shared';
import { originalLanguage } from '../../subject/language';
import { subjectHref } from '../../subject/subject-href';
import type { SourceDefinitions } from './subject-sources';
import { readSubjectRevisionDetail, type RevisionDetailPort } from './subject-changes-detail';

/** Metadata comes from the generated native listing, never from a second history store. */
type NativePage = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['revisions']['get']>>['data']>;
export type RevisionRow = Pick<NativePage['revisions'][number], 'revision' | 'kind'>;
export type ChangesFailure = { kind: 'missing' | 'denied' | 'invalid' | 'conflict' | 'unavailable'; scope?: 'subject' };
export type ChangesPage = {
  id: string;
  title: ReturnType<typeof pageText>;
  typeLabel: ReturnType<typeof pageText>;
  href: string;
  revisions: RevisionRow[];
  next: string | null;
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
export type DetailRead = ChangesFailure | { kind: 'ready'; detail: ChangeDetail; session?: string };
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
};
export type ChangesEvent =
  | { type: 'list-start'; more: boolean }
  | { type: 'list'; result: ChangesRead; more: boolean }
  | { type: 'detail-start'; revision: number }
  | { type: 'detail'; result: DetailRead };

export function changesState(state: ChangesState, event: ChangesEvent): ChangesState {
  if (event.type === 'list-start')
    return event.more ? { ...state, failure: undefined, loading: 'more' } : { loading: 'list' };
  if (event.type === 'detail-start')
    // Discard the previous authorized payload before each read, including retries.
    return { ...state, selected: event.revision, detail: undefined, loading: 'detail' };
  if (event.type === 'detail') {
    if (event.result.kind !== 'ready' && event.result.scope === 'subject') return { failure: event.result };
    if (
      event.result.kind === 'ready' &&
      (event.result.detail.id !== state.page?.id || event.result.detail.revision !== state.selected)
    )
      return { ...state, loading: undefined, detail: { kind: 'unavailable' } };
    return { ...state, loading: undefined, detail: event.result };
  }
  if (event.result.kind !== 'ready') {
    if (event.result.kind === 'missing' || event.result.kind === 'denied') return { failure: event.result };
    return { ...state, loading: undefined, failure: event.result };
  }
  const page = event.result.page;
  if (state.page && state.page.id !== page.id) return { failure: { kind: 'unavailable' } };
  return {
    ...(event.more ? state : {}),
    loading: undefined,
    failure: undefined,
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

export function changesFailure(status: number): ChangesFailure {
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
              : 'unavailable',
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
    if (current.status !== 200 || !current.data) return { ...changesFailure(current.status), scope: 'subject' };
    if (current.data.subject.id !== id) return { kind: 'unavailable' };
    if (!revisions) return { kind: 'unavailable' };
    if (revisions.status !== 200 || !revisions.data) return changesFailure(revisions.status);
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
    if (current.status !== 200 || !current.data) return { ...changesFailure(current.status), scope: 'subject' };
    if (current.data.subject.id !== id) return { kind: 'unavailable', scope: 'subject' };
    if (detail.kind === 'ready' && (detail.detail.id !== id || detail.detail.revision !== revision))
      return { kind: 'unavailable' };
    if (detail.kind === 'ready' && 'property' in detail.detail.summary && options.definitions) {
      const definitions = await options.definitions.catch(() => undefined);
      detail.detail.propertyLabel = pageText(
        definitions?.properties[detail.detail.summary.property]?.labels,
        options.locale ?? 'en',
      );
    }
    return detail;
  } catch {
    return { kind: 'unavailable' };
  }
}
