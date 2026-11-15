import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { personalRead } from '../../session/reading-policy';
import { Exposure, useOperation, type GatedOperation } from '../../kernel/exposure';
import { useLibraryWorkspaceAdmission } from '../library-workspace-admission';
import { csrfHeaders } from '../../threads/composer';
import type { useSession } from '../../session';
import type { Release } from '../../subject/definitions';
import type { CopyItem, CopyRemoved } from '../copies-read';
import { isMangaLibrarySubject } from './capabilities';
import { readConfiguredLibraryVisit } from './actions';
import { ConfiguredCopyPanel, configuredCopyOrigin } from './copy-panel';
import { ConfiguredProgressPanel } from './progress-panel';
import type { ConfiguredLibraryVisit } from './visit';

type ReaderSession = ReturnType<typeof useSession>;

const operations = [
  'copy.list',
  'copy.get',
  'copy.create',
  'copy.update',
  'copy.delete',
  'progress_session.list',
  'progress_session.create',
  'progress_session.read',
  'progress_session.record',
  'progress_session.changes',
] as const;

const target =
  'min-h-11 min-w-11 max-w-full cursor-pointer whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const quiet = `${target} inline-flex shrink-0 items-center justify-center rounded-lg border border-border px-4 hover:bg-muted disabled:opacity-60`;
const linkClass =
  'inline-flex min-h-11 min-w-0 max-w-full flex-wrap items-center text-sm text-primary underline-offset-4 [overflow-wrap:anywhere] hover:underline';

function ConfiguredRetry({
  message,
  disabled,
  onRetry,
}: {
  message: string;
  disabled?: boolean;
  onRetry: () => void;
}) {
  const statusId = useId();
  return (
    <div className="min-w-0 space-y-2">
      <p role="status" id={statusId} className="min-w-0 text-sm [overflow-wrap:anywhere]">
        {message}
      </p>
      <button type="button" className={quiet} disabled={disabled} aria-describedby={statusId} onClick={onRetry}>
        {m.library_configured_retry()}
      </button>
    </div>
  );
}

export function configuredLibraryVisitQuery(
  subjectId: string,
  type: string,
  locale: string,
  copyCursor: string | null,
  ready: boolean,
  lifetime: string,
) {
  return queryOptions({
    ...personalRead,
    queryKey: ['configured-library-visit', subjectId, type, locale, copyCursor, lifetime] as const,
    queryFn: () =>
      readConfiguredLibraryVisit({
        data: {
          subjectId,
          type,
          locale,
          ...(copyCursor ? { copyCursor } : {}),
        },
      }),
    enabled: personalRead.enabled && ready,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

function identityLabel(identity: 'series' | 'volume' | null): string {
  if (identity === 'series') return m.library_configured_series();
  if (identity === 'volume') return m.library_configured_volume();
  return m.library_configured_heading();
}

function VisitBody({
  visit,
  subject,
  locale,
  release,
  credential,
  current,
  returnTo,
  onCopyPage,
  onRefresh,
}: {
  visit: ConfiguredLibraryVisit;
  subject: { id: string; type: string; label: string };
  locale: string;
  release: Release | undefined;
  credential: string;
  current: (operation?: GatedOperation) => boolean;
  returnTo: string;
  onCopyPage: (cursor: string) => void;
  onRefresh: () => void;
}) {
  const [copies, setCopies] = useState(visit.state === 'ready' ? visit.copies.items : []);
  const visitKey = visit.state === 'ready' ? visit.copies.addKey : '';
  const seen = useRef(visitKey);
  if (seen.current !== visitKey) {
    seen.current = visitKey;
    setCopies(visit.state === 'ready' ? visit.copies.items : []);
  }
  const origin = useMemo(
    () =>
      visit.state === 'ready'
        ? configuredCopyOrigin({
            isCurrent: current,
            headers: (operation) => (current(operation) ? csrfHeaders() : null),
            profile: visit.copies.profile,
            subjectId: subject.id,
            subjectLabel: subject.label,
            subjectType: subject.type,
          })
        : undefined,
    [visit, subject, current],
  );

  if (visit.state === 'signed-out') return null;
  if (visit.state === 'refused')
    return (
      <p role="status" className="min-w-0 text-sm [overflow-wrap:anywhere]">
        {m.library_configured_refused()}
      </p>
    );
  if (visit.state === 'unavailable')
    return (
      <ConfiguredRetry
        message={visit.closed ? m.library_subject_closed() : m.library_configured_unavailable()}
        onRetry={() => current() && onRefresh()}
      />
    );
  if (visit.state === 'unsupported')
    return (
      <p role="status" className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {m.library_configured_unsupported()}
      </p>
    );

  const onCreated = (copy: CopyItem) => {
    if (!current()) return;
    setCopies((items) => [copy, ...items.filter((item) => item.id !== copy.id)]);
    onRefresh();
  };
  const onSaved = (copy: CopyItem) => {
    if (!current()) return;
    setCopies((items) => items.map((item) => (item.id === copy.id ? copy : item)));
    onRefresh();
  };
  const onRemoved = (id: string, _result: CopyRemoved, _deadline: number) => {
    if (!current()) return;
    setCopies((items) => items.filter((item) => item.id !== id));
    onRefresh();
  };

  return (
    <div className="mt-4 min-w-0 space-y-6 border-t border-border pt-4 [overflow-wrap:anywhere]">
      <div className="min-w-0 space-y-2">
        <h2 className="text-lg font-medium">{m.library_configured_heading()}</h2>
        <p className="text-sm text-muted-foreground">{identityLabel(visit.identity)}</p>
        {visit.entry.meaning === 'absent' ? (
          <p className="text-sm text-muted-foreground">{m.library_configured_absent_state()}</p>
        ) : visit.entry.meaning === 'historical' ? (
          <p className="text-sm text-muted-foreground">
            {m.library_configured_historical()} {visit.entry.label}
          </p>
        ) : (
          <p className="text-sm">{visit.entry.label}</p>
        )}
        {visit.capabilities.states.length ? (
          <p className="text-sm text-muted-foreground">
            {m.library_configured_admitted_states()}
            {': '}
            {visit.capabilities.states.map((state) => state.label.text).join(', ')}
          </p>
        ) : null}
      </div>
      {origin ? (
        <ConfiguredCopyPanel
          subjectId={subject.id}
          subjectType={subject.type}
          subjectLabel={subject.label}
          profile={visit.copies.profile}
          items={copies}
          next={visit.copies.next}
          addKey={visit.copies.addKey}
          sendKind={visit.copies.sendKind}
          originating={origin}
          onPage={onCopyPage}
          onCreated={onCreated}
          onSaved={onSaved}
          onRemoved={onRemoved}
        />
      ) : null}
      <ConfiguredProgressPanel
        subjectId={subject.id}
        type={subject.type}
        locale={locale}
        release={release}
        progress={visit.progress}
        credential={credential}
        current={current}
        onAcknowledged={onRefresh}
      />
      <Exposure operation="library_entry.get">
        <a className={linkClass} href={returnTo}>
          {m.library_configured_return()}
        </a>
      </Exposure>
    </div>
  );
}

/** Mounted owner-private manga Library visit: profile, copies, one manual measure, result and return. */
export function ConfiguredProfileControls({
  subject,
  locale,
  session,
  returnTo,
  visit: supplied,
  release,
}: {
  subject: { id: string; type: string; label: string };
  locale: string;
  session: ReaderSession;
  returnTo: string;
  visit?: ConfiguredLibraryVisit;
  release?: Release;
}) {
  const copyListAdmitted = useOperation('copy.list');
  const progressListAdmitted = useOperation('progress_session.list');
  const { store: admission } = useLibraryWorkspaceAdmission(operations);
  const [copyCursor, setCopyCursor] = useState<string | null>(null);
  const lifetime = useRef({ id: crypto.randomUUID(), active: true });
  useEffect(
    () => () => {
      lifetime.current.active = false;
    },
    [],
  );
  const ready =
    session.state === 'signed-in' &&
    !!session.subject &&
    !!session.csrfToken &&
    copyListAdmitted &&
    progressListAdmitted &&
    isMangaLibrarySubject(subject.type);
  const isCurrent = (operation?: GatedOperation) => {
    if (!lifetime.current.active || session.state !== 'signed-in' || !session.subject) return false;
    const gate = operation ?? 'copy.list';
    if (!(operations as readonly string[]).includes(gate)) return false;
    return admission.allowed(gate as (typeof operations)[number]);
  };
  const query = configuredLibraryVisitQuery(
    subject.id,
    subject.type,
    locale,
    copyCursor,
    ready && !supplied,
    lifetime.current.id,
  );
  const loaded = useQuery(query);
  const visit = supplied ?? loaded.data;
  if (!isMangaLibrarySubject(subject.type) || session.state === 'signed-out') return null;
  if (!visit) {
    if (!ready || supplied) return null;
    return loaded.isError ? (
      <ConfiguredRetry
        message={m.library_configured_unavailable()}
        disabled={loaded.isFetching}
        onRetry={() => isCurrent() && void loaded.refetch()}
      />
    ) : null;
  }
  return (
    <VisitBody
      visit={visit}
      subject={subject}
      locale={locale}
      release={release}
      credential={session.csrfToken ?? ''}
      current={isCurrent}
      returnTo={returnTo}
      onCopyPage={(cursor) => isCurrent('copy.list') && setCopyCursor(cursor)}
      onRefresh={() => {
        if (supplied || !isCurrent()) return;
        void loaded.refetch();
      }}
    />
  );
}
