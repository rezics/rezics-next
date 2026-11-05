import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { consolidationEnvelope } from './label-consolidation/envelope';
import { consolidationTransport } from './label-consolidation/route';
import { ConsolidationWorkspace } from './label-consolidation/workspace';
import { m } from '../paraglide/messages.js';
import { usePrivateReportOrigin, usePrivateReportPayload } from './private-report-current-origin';
import { LabelShelfPage } from './entries-page';
import {
  labelShelfSource,
  type CurrentLabelShelfData,
  type LabelShelfPageData,
  type LabelShelfSource,
} from './label-shelf-read';
import { validateShelfSearch, type ShelfDisplay } from './shelf-params';
import type { ShelfPresentationResolution } from './shelf-preferences';

const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Keep the exact supplied result/Undo values; only valid native identifiers and revisions enter a read.
function sourceAt(search: Record<string, unknown>): LabelShelfSource {
  const shelf = validateShelfSearch(search);
  const revision =
    typeof search.undoRevision === 'number' ||
    (typeof search.undoRevision === 'string' && /^\d+$/.test(search.undoRevision))
      ? Number(search.undoRevision)
      : undefined;
  return labelShelfSource({
    labelId: shelf.label ?? '',
    ...(shelf.cursor ? { cursor: shelf.cursor } : {}),
    ...(typeof search.undoSubjectId === 'string' &&
    routeId.test(search.undoSubjectId) &&
    typeof search.undoAssignmentId === 'string' &&
    routeId.test(search.undoAssignmentId) &&
    typeof search.undoLabelId === 'string' &&
    routeId.test(search.undoLabelId) &&
    revision !== undefined &&
    Number.isSafeInteger(revision) &&
    revision > 0
      ? {
          undo: {
            subjectId: search.undoSubjectId,
            assignmentId: search.undoAssignmentId,
            labelId: search.undoLabelId,
            revision,
          },
        }
      : {}),
    ...(typeof search.labelResult === 'string' ? { labelResult: search.labelResult } : {}),
    ...(typeof search.undoKey === 'string' && routeId.test(search.undoKey) ? { undoKey: search.undoKey } : {}),
  });
}

function sourceKey(source: LabelShelfSource): string {
  return JSON.stringify([
    source.labelId,
    source.cursor,
    source.undo?.labelId ?? null,
    source.undo?.subjectId ?? null,
    source.undo?.assignmentId ?? null,
    source.undo?.revision ?? null,
    source.labelResult,
    source.undoKey,
  ]);
}

type ReadInput = {
  labelId: string;
  cursor?: string;
  undoLabelId?: string;
  undoSubjectId?: string;
  undoAssignmentId?: string;
  undoRevision?: number;
  undoKey?: string;
  labelResult?: string;
};
type ReadShelf = (options: { data: ReadInput }) => Promise<CurrentLabelShelfData>;
type Payload = { owner: number; value?: CurrentLabelShelfData };
const readGroups = ['personal_library', 'reading_progress', 'library_label.assignment_list'] as const;

function addressOf(source: LabelShelfSource, locale: string): string {
  return JSON.stringify([sourceKey(source), locale]);
}

function addressAt(href: string, locale: string): string {
  const url = new URL(href, 'https://report.invalid');
  const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  return parts.at(-1) === 'library' && parts.length <= 2
    ? addressOf(sourceAt(Object.fromEntries(url.searchParams)), parts.length === 2 ? parts[0]! : locale)
    : href;
}

function matches(data: CurrentLabelShelfData, subject: string, source: LabelShelfSource, locale: string): boolean {
  return (
    subject.trim().length > 0 &&
    data.provenance.subject === subject &&
    data.provenance.locale === locale &&
    sourceKey(data.provenance.source) === sourceKey(source) &&
    (data.state !== 'loaded' || data.label.id === source.labelId)
  );
}

/** Own the entire private page, including its heading and native forms, above pure presentation. */
export function CurrentLabelShelf({
  initial,
  locale,
  display,
  presentation,
  read,
}: {
  initial: CurrentLabelShelfData;
  locale: string;
  display: ShelfDisplay;
  presentation?: ShelfPresentationResolution;
  read: ReadShelf;
}) {
  const search = useLocation({ select: (location) => location.search });
  const source = sourceAt(search);
  const { origin, value, hydrated } = usePrivateReportOrigin(
    addressOf(source, locale),
    locale,
    (href) => addressAt(href, locale),
    false,
  );
  // Accepted payloads survive healthy credential/admission refreshes without manufacturing new native intents.
  const payload = useRef<Payload>({ owner: value.owner });
  const seed = useRef(true);
  if (payload.current.owner !== value.owner) payload.current = { owner: value.owner };
  if (hydrated && value.subject && seed.current) {
    seed.current = false;
    if (matches(initial, value.subject, source, locale)) payload.current.value = initial;
  }
  if (!hydrated) {
    const serverPage: LabelShelfPageData =
      initial.state !== 'loaded' ||
      (initial.provenance.subject &&
        routeId.test(source.labelId) &&
        matches(initial, initial.provenance.subject, source, locale))
        ? initial
        : { state: 'preparing' };
    return (
      <LabelShelfPage page={serverPage} locale={locale} display={display} {...(presentation ? { presentation } : {})} />
    );
  }
  const enrolled = origin.capture(...readGroups);
  const current = () => enrolled() && origin.read().owner === value.owner && origin.read().subject === value.subject;
  if (!value.subject || !routeId.test(source.labelId) || !current()) {
    const page: LabelShelfPageData = {
      state:
        value.state === 'signed-out'
          ? 'signed-out'
          : value.unavailable || (!value.subject && value.state !== 'unknown')
            ? 'unavailable'
            : value.authority
              ? 'closed'
              : 'preparing',
    };
    return <LabelShelfPage page={page} locale={locale} display={display} {...(presentation ? { presentation } : {})} />;
  }
  return (
    <LabelShelfRead
      key={origin.version(...readGroups)}
      origin={origin}
      originatingRead={current}
      episode={origin.version(...readGroups)}
      payload={payload.current}
      subject={value.subject}
      source={source}
      locale={locale}
      display={display}
      {...(presentation ? { presentation } : {})}
      read={read}
    />
  );
}

function LabelShelfRead({
  origin,
  originatingRead,
  episode,
  payload,
  subject,
  source,
  locale,
  display,
  presentation,
  read,
}: {
  origin: ReturnType<typeof usePrivateReportOrigin>['origin'];
  originatingRead: () => boolean;
  episode: string;
  payload: Payload;
  subject: string;
  source: LabelShelfSource;
  locale: string;
  display: ShelfDisplay;
  presentation?: ShelfPresentationResolution;
  read: ReadShelf;
}) {
  const client = useQueryClient();
  const current = originatingRead;
  const key = ['library', 'label-shelf', subject, sourceKey(source), locale, episode];
  const query = useQuery({
    queryKey: key,
    enabled: current(),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    ...(payload.value ? { initialData: payload.value } : {}),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      if (!current()) throw new Error('Obsolete label shelf read');
      const data = await read({
        data: {
          labelId: source.labelId,
          ...(source.cursor !== null ? { cursor: source.cursor } : {}),
          ...(source.undo
            ? {
                undoLabelId: source.undo.labelId,
                undoSubjectId: source.undo.subjectId,
                undoAssignmentId: source.undo.assignmentId,
                undoRevision: source.undo.revision,
              }
            : {}),
          ...(source.undoKey !== null ? { undoKey: source.undoKey } : {}),
          ...(source.labelResult !== null ? { labelResult: source.labelResult } : {}),
        },
      });
      signal.throwIfAborted();
      if (!current() || !matches(data, subject, source, locale))
        throw new Error('Label shelf read no longer matches its viewer and source');
      return data;
    },
  });
  const capturePayload = usePrivateReportPayload(client, key);
  const sameRead = capturePayload(query.data);
  const isCurrent = () => current() && sameRead();
  const binding = useMemo(
    () => ({
      id: crypto.randomUUID(),
      envelope: consolidationEnvelope(origin, isCurrent, (notify) => client.getQueryCache().subscribe(notify)),
    }),
    [origin, client, query.data, query.dataUpdatedAt, query.isError, episode],
  );
  const [reopened, setReopened] = useState<{ binding: string; page: LabelShelfPageData } | null>(null);
  const [refreshState, setRefreshState] = useState<'idle' | 'loading' | 'unavailable'>('idle');
  const refreshing = useRef(false);
  const pendingRefresh = useRef<[string, string] | null>(null);
  const refreshReaders = async (sourceId: string, targetId: string) => {
    if (!isCurrent()) return;
    if (refreshing.current) {
      pendingRefresh.current = [sourceId, targetId];
      return;
    }
    const captured = origin.capture(...readGroups);
    const refreshSources = [
      labelShelfSource({ labelId: sourceId, ...(source.cursor !== null ? { cursor: source.cursor } : {}) }),
      labelShelfSource({ labelId: targetId }),
    ] as const;
    refreshing.current = true;
    setRefreshState('loading');
    try {
      const results = await Promise.allSettled(
        refreshSources.map((requested) =>
          read({
            data: {
              labelId: requested.labelId,
              ...(requested.cursor !== null ? { cursor: requested.cursor } : {}),
            },
          }),
        ),
      );
      if (!isCurrent() || !captured()) return;
      const sourceResult = results[0];
      if (
        sourceResult?.status === 'fulfilled' &&
        sourceResult.value.state === 'loaded' &&
        matches(sourceResult.value, subject, refreshSources[0], locale)
      ) {
        setReopened({
          binding: binding.id,
          page: {
            ...sourceResult.value,
            ...(query.data?.state === 'loaded' && query.data.undo
              ? {
                  undo: query.data.undo,
                  ...(query.data.undoKey ? { undoKey: query.data.undoKey } : {}),
                }
              : {}),
          },
        });
      }
      setRefreshState(
        results.every(
          (result, index) =>
            result.status === 'fulfilled' &&
            result.value.state === 'loaded' &&
            matches(result.value, subject, refreshSources[index]!, locale),
        )
          ? 'idle'
          : 'unavailable',
      );
    } catch {
      if (isCurrent()) setRefreshState('unavailable');
    } finally {
      refreshing.current = false;
      const pending = pendingRefresh.current;
      pendingRefresh.current = null;
      if (pending && isCurrent()) void refreshReaders(...pending);
    }
  };
  const write = origin.capture(...readGroups, 'library_label.unassign');
  const accepted = isCurrent() && query.data && matches(query.data, subject, source, locale) ? query.data : undefined;
  if (accepted?.state === 'loaded') payload.value = accepted;
  const page: LabelShelfPageData = accepted ?? { state: query.isError ? 'unavailable' : 'preparing' };
  const canUnassign = () => isCurrent() && page.state === 'loaded' && !!page.csrfToken?.trim() && write();
  // CSRF, revisions and command keys remain exactly those captured by this payload's originating read.
  const shown = reopened?.binding === binding.id ? reopened.page : page;
  if (page.state !== 'loaded')
    return (
      <LabelShelfPage
        page={page}
        locale={locale}
        display={display}
        {...(presentation ? { presentation } : {})}
        isCurrent={isCurrent}
        canUnassign={canUnassign}
      />
    );
  return (
    <ConsolidationWorkspace
      key={binding.id}
      page={shown.state === 'loaded' ? shown : page}
      viewer={subject}
      locale={locale}
      envelope={binding.envelope}
      isCurrent={isCurrent}
      transport={(headers) => consolidationTransport(subject, source.labelId, headers)}
      refreshAssignments={(source, target) => {
        void refreshReaders(source, target);
      }}
      canUndo={() => isCurrent() && origin.capture(...readGroups, 'library_label.unassign')()}
      csrfToken={() => origin.read().csrfToken}
    >
      {refreshState !== 'idle' ? (
        <p role="status">
          {refreshState === 'loading' ? m.library_consolidation_refreshing() : m.library_consolidation_refresh_failed()}
        </p>
      ) : null}
      <LabelShelfPage
        page={shown}
        locale={locale}
        display={display}
        {...(presentation ? { presentation } : {})}
        isCurrent={isCurrent}
        canUnassign={canUnassign}
      />
    </ConsolidationWorkspace>
  );
}
