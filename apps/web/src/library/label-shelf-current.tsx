import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useState, useSyncExternalStore } from 'react';
import { exposureQuery, useSession } from '../session/query';
import { LabelShelfPage } from './entries-page';
import {
  labelShelfSource,
  type CurrentLabelShelfData,
  type LabelShelfPageData,
  type LabelShelfSource,
} from './label-shelf-read';
import { validateShelfSearch, type ShelfDisplay } from './shelf-params';

const subscribe = () => () => {};
const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Match the existing server validator, including omitted versus supplied result/Undo values.
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
    typeof search.undoAssignmentId === 'string' &&
    typeof search.undoLabelId === 'string' &&
    revision !== undefined &&
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
type Lifetime = { scope: string; id: string; active: boolean; initial?: CurrentLabelShelfData };

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
  read,
}: {
  initial: CurrentLabelShelfData;
  locale: string;
  display: ShelfDisplay;
  read: ReadShelf;
}) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const session = useSession();
  const search = useLocation({ select: (location) => location.search });
  const source = sourceAt(search);
  const exposure = useQuery({ ...exposureQuery, enabled: hydrated && session.state === 'signed-in' });
  const groups = ['personal_library', 'reading_progress', 'library_label.assignment_list'] as const;
  // Only the server snapshot may use actual loader identity in place of browser observation.
  const subject = hydrated
    ? session.state === 'signed-in' && session.subject?.trim()
      ? session.subject
      : null
    : initial.provenance.subject;
  const admission = groups.map((group) => !hydrated || exposure.data?.includes(group) === true);
  const admitted = admission.every(Boolean);
  const state = hydrated ? session.state : subject ? 'signed-in' : initial.state;
  const scope = JSON.stringify([state, subject, admission, sourceKey(source), locale]);
  const [lifetime, setLifetime] = useState<Lifetime>(() => ({
    scope,
    id: crypto.randomUUID(),
    active: true,
    ...(subject && admitted && matches(initial, subject, source, locale) ? { initial } : {}),
  }));
  if (lifetime.scope !== scope || !lifetime.active) {
    // Render-time retirement prevents both an old subtree commit and late cache acceptance, including ABA.
    lifetime.active = false;
    setLifetime({ scope, id: crypto.randomUUID(), active: true });
  }

  let fallback: LabelShelfPageData | undefined;
  if (!hydrated && initial.state !== 'loaded') fallback = initial;
  else if (state === 'signed-out') fallback = { state: 'signed-out' };
  else if (!subject) fallback = { state: state === 'unknown' ? 'preparing' : 'unavailable' };
  else if (!admitted) fallback = { state: exposure.data ? 'closed' : 'preparing' };
  else if (!source.labelId || !lifetime.active) fallback = { state: 'preparing' };
  if (fallback) return <LabelShelfPage page={fallback} locale={locale} display={display} />;
  return (
    <LabelShelfLifetime
      key={lifetime.id}
      lifetime={lifetime}
      subject={subject!}
      source={source}
      locale={locale}
      display={display}
      hydrated={hydrated}
      read={read}
    />
  );
}

function LabelShelfLifetime({
  lifetime,
  subject,
  source,
  locale,
  display,
  hydrated,
  read,
}: {
  lifetime: Lifetime;
  subject: string;
  source: LabelShelfSource;
  locale: string;
  display: ShelfDisplay;
  hydrated: boolean;
  read: ReadShelf;
}) {
  const query = useQuery({
    queryKey: ['library', 'label-shelf', subject, sourceKey(source), locale, lifetime.id],
    enabled: hydrated,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    ...(lifetime.initial ? { initialData: lifetime.initial } : {}),
    queryFn: async ({ signal }) => {
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
      if (signal.aborted || !lifetime.active || !matches(data, subject, source, locale))
        throw new Error('Label shelf read no longer matches its viewer and source');
      return data;
    },
  });
  const page: LabelShelfPageData =
    lifetime.active && query.data && matches(query.data, subject, source, locale)
      ? query.data
      : { state: query.isError ? 'unavailable' : 'preparing' };
  // CSRF and command keys remain exactly those captured by this payload's originating read.
  return <LabelShelfPage page={page} locale={locale} display={display} />;
}
