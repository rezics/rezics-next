import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { contextHref } from '../../pages/context-navigation';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { linkClass, linkColor } from '../../pages/shared';
import { MusicReleaseFacts, MusicReleaseOccurrenceFacts, MusicReleaseSlot } from './facts';
import {
  acceptMusicReleaseAddress,
  musicReleaseFirstAddress,
  musicReleaseMatchesAddress,
  musicReleaseNavigation,
  musicReleaseNextAddress,
  musicReleaseOccurrenceKey,
  requestMusicReleaseAddress,
  type MusicReleaseAddress,
  type MusicReleaseRead,
  type MusicReleasePending,
  type MusicReleaseTransport,
  type MusicReleaseWindowIntent,
} from './model';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const link = `${action} ${linkClass} ${linkColor} underline`;
type Ready = Extract<MusicReleaseRead, { ok: true }>;
type Failure = Extract<MusicReleaseRead, { ok: false }>;
type Props = {
  id: string;
  context: string;
  locale: string;
  realm?: string | undefined;
  transport: MusicReleaseTransport;
  source: object | string;
  reader: string | null;
  initial?: MusicReleaseRead;
  /** Re-enter the ordinary Subject loader. Success must supply a replacement source observation. */
  recoverCurrentPage?: (() => Promise<void>) | undefined;
};
type Admission = { source: Props['source']; key: string; retired: boolean; reason?: Failure['reason'] };
type Recovery = {
  token: object;
  source: Props['source'];
  descriptor: string;
  status: 'pending' | 'complete' | 'failed';
};

/** Keep the shared session/provider retirement interface; recovery requires a new Subject observation. */
export function MusicReleaseReader(props: Props) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const descriptor = JSON.stringify([props.id, props.context, props.locale, props.realm, props.reader]);
  const reading = useSubjectCommunityReading({ source: props.source, reader: props.reader, descriptor });
  const [admission, setAdmission] = useState<Admission>({
    source: props.source,
    key: reading.key,
    retired: !reading.available,
  });
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const recoveryIdle = useRef({});
  const recoveryReading = useSubjectCommunityReading({
    source: recovery?.token ?? recoveryIdle.current,
    reader: props.reader,
    descriptor,
  });
  const allowInitial = useRef(true);
  const recovering = useRef(false);
  const mounted = useRef(false);
  const latest = useRef({ source: props.source, descriptor });
  latest.current = { source: props.source, descriptor };
  // A new source may be equal in content. It still invalidates every control from the previous observation.
  if (
    admission.source !== props.source ||
    admission.key !== reading.key ||
    (!reading.available && !admission.retired)
  ) {
    allowInitial.current = false;
    setAdmission({ source: props.source, key: reading.key, retired: true });
  } else if (
    admission.retired &&
    recovery?.status === 'complete' &&
    recovery.source !== props.source &&
    recovery.descriptor === descriptor &&
    reading.available &&
    recoveryReading.available
  ) {
    setAdmission({ source: props.source, key: reading.key, retired: false });
    setRecovery(null);
  }
  const admitted =
    !admission.retired && admission.source === props.source && admission.key === reading.key && reading.available;
  const currentAdmission = useRef(admission);
  currentAdmission.current = admission;
  const current = () => admitted && currentAdmission.current === admission && reading.isCurrent();
  const o = { locale: props.locale as never };
  const currentSubjectHref = contextHref(subjectHref({ id: props.id, label: '' }, props.locale).href, props.realm);
  const focusHeading = () => heading.current?.focus();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      focusHeading();
  }, [admitted, admission]);

  const recover = async (event: MouseEvent<HTMLButtonElement>) => {
    if (recovering.current || !props.recoverCurrentPage) return;
    const trigger = event.currentTarget;
    const keyboard = event.detail === 0;
    const attempt: Recovery = { token: {}, source: props.source, descriptor, status: 'pending' };
    recovering.current = true;
    setRecovery(attempt);
    try {
      await props.recoverCurrentPage();
      if (!mounted.current || latest.current.descriptor !== attempt.descriptor) return;
      // A resolved invalidation without a newly admitted source never rebinds the old request.
      setRecovery({
        ...attempt,
        status: 'complete',
      });
      if (
        keyboard &&
        (document.activeElement === trigger || (!trigger.isConnected && document.activeElement === document.body))
      )
        focusHeading();
    } catch {
      if (mounted.current && latest.current.descriptor === attempt.descriptor)
        setRecovery({ ...attempt, status: 'failed' });
    } finally {
      recovering.current = false;
    }
  };
  return (
    <section
      data-slot="music-release-reader"
      aria-labelledby={headingId}
      className="min-w-0 space-y-4"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <h2 id={headingId} ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {m.music_release_title({}, o)}
      </h2>
      {admitted ? (
        <MusicReleaseWindow
          key={reading.key}
          {...props}
          // An example initial body belongs only to the original observation, never a recovered source.
          initial={allowInitial.current ? props.initial : undefined}
          current={current}
          focusHeading={focusHeading}
          retire={(reason) => {
            if (current()) {
              allowInitial.current = false;
              setAdmission({ ...admission, retired: true, reason });
            }
          }}
        />
      ) : (
        <div className="space-y-3" aria-busy={recovery?.status === 'pending'}>
          <p role="status">
            {admission.reason === 'withheld'
              ? m.music_release_withheld({}, o)
              : admission.reason === 'invalid'
                ? m.music_release_invalid({}, o)
                : m.music_release_retired({}, o)}
          </p>
          <p className="text-sm text-muted-foreground">{m.music_release_recovery_scope({}, o)}</p>
          {recovery &&
          (recovery.status === 'failed' ||
            (recovery.status === 'complete' && (!recoveryReading.available || recovery.source === props.source))) ? (
            <p role="alert">{m.music_release_recovery_failed({}, o)}</p>
          ) : null}
          {props.recoverCurrentPage ? (
            <button
              type="button"
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              disabled={recovery?.status === 'pending'}
              onClick={recover}
            >
              {recovery?.status === 'pending' ? m.candidate_loading({}, o) : m.music_release_recover({}, o)}
            </button>
          ) : (
            <a className={link} href={currentSubjectHref}>
              {m.music_release_recover({}, o)}
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/** One response body, eight previous addresses and one selected exact occurrence. */
export function MusicReleaseWindow({
  id,
  context,
  locale,
  realm,
  transport,
  initial,
  current,
  focusHeading,
  retire,
}: Omit<Props, 'source' | 'reader'> & {
  current: () => boolean;
  focusHeading: () => void;
  retire: (reason: Failure['reason']) => void;
}) {
  const o = { locale: locale as never };
  const [page, setPage] = useState<Ready | undefined>(initial?.ok ? initial : undefined);
  const [failure, setFailure] = useState<Failure | undefined>(initial && !initial.ok ? initial : undefined);
  const [busy, setBusy] = useState(!initial);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [previousCount, setPreviousCount] = useState(0);
  const inspectionId = useId();
  const inspectionHeading = useRef<HTMLHeadingElement>(null);
  const selectionOpener = useRef<HTMLButtonElement | null>(null);
  const keyboardSelection = useRef(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const base = { id, context };
  const navigation = useRef(musicReleaseNavigation(base, initial?.ok ? initial : undefined));
  const origin = useRef<HTMLAnchorElement | null>(null);
  const selected = page?.rows.find((row) => musicReleaseOccurrenceKey(row) === selectedKey);
  const next = page ? musicReleaseNextAddress(navigation.current, page) : undefined;
  const previous = navigation.current.previous.at(-1);

  const clearSelection = () => {
    selectionOpener.current = null;
    keyboardSelection.current = false;
    setSelectedKey(null);
  };
  const returnFocus = (event: MouseEvent<HTMLAnchorElement>) => {
    // A mouse visit must also discard any earlier keyboard return origin.
    origin.current =
      event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
        ? event.currentTarget
        : null;
  };
  useEffect(() => {
    const restore = () => {
      const target = origin.current;
      origin.current = null;
      if (!current() || !target) return;
      if (target.isConnected && (document.activeElement === target || document.activeElement === document.body))
        target.focus();
      else if (!target.isConnected && document.activeElement === document.body) focusHeading();
    };
    window.addEventListener('focus', restore);
    return () => window.removeEventListener('focus', restore);
  }, [current, focusHeading]);

  const read = async (
    address: MusicReleaseAddress,
    intent: MusicReleaseWindowIntent,
    trigger?: HTMLButtonElement,
    keyboard = false,
  ) => {
    if (!mounted.current || !current() || inFlight.current) return;
    inFlight.current = true;
    const turn = ++sequence.current;
    navigation.current = requestMusicReleaseAddress(navigation.current, address, intent);
    if (intent === 'start' && address.stream !== page?.stream?.key) clearSelection();
    setBusy(true);
    setFailure(undefined);
    let result: MusicReleaseRead;
    try {
      result = await transport(address);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !current() || sequence.current !== turn) return;
    inFlight.current = false;
    setBusy(false);
    if (result.ok && !musicReleaseMatchesAddress(result, address)) result = { ok: false, reason: 'invalid' };
    if (result.ok) {
      navigation.current = acceptMusicReleaseAddress(navigation.current, result.stream?.key);
      setPreviousCount(navigation.current.previous.length);
      // Keep an outstanding origin only for the connectedness check on return; never keep a prior row body.
      clearSelection();
      setPage(result);
      if (
        keyboard &&
        trigger &&
        (trigger === document.activeElement || (!trigger.isConnected && document.activeElement === document.body))
      )
        focusHeading();
    } else if (result.reason === 'unavailable') {
      setFailure(result);
    } else {
      clearSelection();
      origin.current = null;
      navigation.current = { previous: [] };
      setPage(undefined);
      retire(result.reason);
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!initial) void read(base, 'start');
    else if (!initial.ok && initial.reason !== 'unavailable') retire(initial.reason);
    return () => {
      mounted.current = false;
      inFlight.current = false;
      sequence.current++;
      origin.current = null;
    };
    // The parent retires/remounts this window for every source, address, viewer or locale observation.
  }, []);
  const request =
    (address: MusicReleaseAddress, intent: MusicReleaseWindowIntent) => (event: MouseEvent<HTMLButtonElement>) => {
      if (!busy) void read(address, intent, event.currentTarget, event.detail === 0);
    };
  const closeInspection = (event: MouseEvent<HTMLButtonElement>) => {
    const opener = selectionOpener.current;
    const keyboard = event.detail === 0;
    clearSelection();
    if (!keyboard || !current()) return;
    if (opener?.isConnected) opener.focus();
    else if (document.activeElement === document.body || document.activeElement === event.currentTarget) focusHeading();
  };
  useLayoutEffect(() => {
    if (selectedKey && keyboardSelection.current && current()) {
      keyboardSelection.current = false;
      inspectionHeading.current?.focus();
    }
  }, [selectedKey]);

  return (
    <div className="min-w-0 space-y-4" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{m.music_release_scope({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.music_release_return({}, o)}</p>
      {busy ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {failure ? (
        <div role="alert" className="space-y-2">
          <p>{page ? m.music_release_window_unavailable({}, o) : m.music_release_unavailable({}, o)}</p>
          <MusicReleasePendingWindow pending={navigation.current.pending} page={page} locale={locale} />
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy}
            onClick={(event) => {
              const pending = navigation.current.pending;
              if (pending) void read(pending.address, pending.intent, event.currentTarget, event.detail === 0);
              else void read(base, 'start', event.currentTarget, event.detail === 0);
            }}
          >
            {m.album_tracks_retry({}, o)}
          </button>
        </div>
      ) : null}
      {page ? <MusicReleaseFacts page={page} locale={locale} realm={realm} onNavigate={returnFocus} /> : null}
      {page && page.admitted && !page.stream ? <p role="status">{m.music_release_unconfigured({}, o)}</p> : null}
      {page?.stream ? (
        <>
          <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.work_parts_relation({}, o)}>
            {page.streams.map((stream) => (
              <button
                key={stream.key}
                type="button"
                aria-pressed={stream.key === page.stream?.key}
                disabled={busy}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={request(musicReleaseFirstAddress(base, stream.key), 'start')}
              >
                <span lang={stream.label.lang ?? undefined}>{stream.label.text || stream.property}</span>
                <span className="sr-only">
                  {' · '}
                  {stream.direction === 'forward' ? m.music_release_forward({}, o) : m.music_release_inverse({}, o)}
                </span>
              </button>
            ))}
          </nav>
          <MusicReleaseWindowIdentity page={page} locale={locale} previousCount={previousCount} />
          <p className="text-sm text-muted-foreground">{m.work_parts_slice({}, o)}</p>
          <p role="status" className="text-sm text-muted-foreground">
            {page.caughtUp ? m.album_tracks_current({}, o) : m.work_parts_pending({}, o)}
          </p>
          {!page.rows.length ? (
            <p role="status">{page.next ? m.music_release_empty_continued({}, o) : m.work_parts_empty({}, o)}</p>
          ) : null}
          <ul className="min-w-0 divide-y divide-border" aria-label={m.music_release_occurrences({}, o)}>
            {page.rows.map((row) => {
              const key = musicReleaseOccurrenceKey(row);
              const summary = row.summary;
              const type = summary ? page.types[summary.type] : undefined;
              const chosen = selectedKey === key;
              return (
                <li key={key} data-slot="music-release-row" data-selected={chosen || undefined} className="min-w-0">
                  <ContentItemFrame as="div" className="min-w-0 space-y-3 py-4">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium [overflow-wrap:anywhere]" lang={summary?.label?.language}>
                        {summary?.label?.value || m.work_parts_unresolved({}, o)}
                      </p>
                      {summary ? (
                        <p className="text-sm text-muted-foreground" lang={type?.lang ?? undefined}>
                          {type?.text || summary.type}
                        </p>
                      ) : null}
                      <MusicReleaseSlot row={row} page={page} locale={locale} />
                    </div>
                    <button
                      type="button"
                      className={`${buttonVariants({ variant: chosen ? 'secondary' : 'outline' })} ${action}`}
                      disabled={busy}
                      aria-pressed={chosen}
                      aria-expanded={chosen}
                      aria-controls={chosen ? inspectionId : undefined}
                      onClick={(event) => {
                        if (!current() || busy) return;
                        selectionOpener.current = event.currentTarget;
                        keyboardSelection.current = event.detail === 0;
                        setSelectedKey(key);
                        if (chosen && event.detail === 0) inspectionHeading.current?.focus();
                      }}
                    >
                      {m.music_release_inspect({}, o)}
                      <span className="sr-only">
                        {' · '}
                        {summary?.label?.value || m.work_parts_unresolved({}, o)}
                      </span>
                    </button>
                  </ContentItemFrame>
                </li>
              );
            })}
          </ul>
          {selected ? (
            <section
              id={inspectionId}
              role="region"
              aria-labelledby={`${inspectionId}-heading`}
              data-slot="music-release-inspection"
              className="min-w-0 space-y-4 rounded-lg border border-border p-4 [overflow-wrap:anywhere]"
            >
              <header className="flex min-w-0 items-start justify-between gap-3">
                <h3 id={`${inspectionId}-heading`} ref={inspectionHeading} tabIndex={-1} className="font-semibold">
                  {m.music_release_occurrence({}, o)}
                  {' · '}
                  <span lang={selected.summary?.label?.language}>
                    {selected.summary?.label?.value || m.work_parts_unresolved({}, o)}
                  </span>
                </h3>
                <button
                  type="button"
                  className={`${buttonVariants({ variant: 'outline' })} ${action} shrink-0`}
                  onClick={closeInspection}
                >
                  {m.candidate_close({}, o)}
                </button>
              </header>
              <MusicReleaseOccurrenceFacts
                row={selected}
                page={page}
                locale={locale}
                realm={realm}
                onNavigate={returnFocus}
              />
            </section>
          ) : null}
          {!page.next ? <p role="status">{m.album_tracks_complete({}, o)}</p> : null}
          <nav className="flex flex-wrap gap-3" aria-label={m.music_release_navigation({}, o)}>
            <button
              type="button"
              disabled={busy || !previous}
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              onClick={request(previous ?? base, 'previous')}
            >
              {m.album_tracks_previous({}, o)}
            </button>
            <button
              type="button"
              disabled={busy}
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              onClick={request(musicReleaseFirstAddress(base, page.stream.key), 'start')}
            >
              {m.work_parts_restart({}, o)}
            </button>
            {next && !failure ? (
              <button
                type="button"
                disabled={busy}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={request(next, 'next')}
              >
                {m.work_parts_more({}, o)}
              </button>
            ) : null}
          </nav>
        </>
      ) : null}
    </div>
  );
}

/** The selected native page is a slice, even when its current frontier is exhausted. */
function MusicReleaseWindowIdentity({
  page,
  locale,
  previousCount,
}: {
  page: Ready;
  locale: string;
  previousCount: number;
}) {
  const o = { locale: locale as never };
  if (!page.stream) return null;
  return (
    <dl className="grid min-w-0 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2 [overflow-wrap:anywhere]">
      <div>
        <dt className="text-sm text-muted-foreground">{m.music_release_edition({}, o)}</dt>
        <dd lang={page.identity.label.lang ?? undefined}>{page.identity.label.text || page.identity.id}</dd>
      </div>
      <div>
        <dt className="text-sm text-muted-foreground">{m.work_parts_relation({}, o)}</dt>
        <dd>
          <span lang={page.stream.label.lang ?? undefined}>{page.stream.label.text || page.stream.property}</span>
          <span className="block text-sm text-muted-foreground">{page.stream.property}</span>
          <span className="block text-sm">
            {page.stream.direction === 'forward'
              ? m.work_parts_order_forward({}, o)
              : m.work_parts_order_inverse({}, o)}
          </span>
        </dd>
      </div>
      {page.count ? (
        <div>
          <dt className="text-sm text-muted-foreground">{m.music_release_supplied_count({}, o)}</dt>
          <dd>
            {m.work_parts_count(
              {
                accuracy: page.count.exact ? m.work_parts_exact({}, o) : m.work_parts_at_least({}, o),
                count: page.count.value,
              },
              o,
            )}
          </dd>
        </div>
      ) : null}
      <div>
        <dt className="text-sm text-muted-foreground">{m.music_release_previous_windows({}, o)}</dt>
        <dd>{previousCount}</dd>
      </div>
    </dl>
  );
}

/** Name the deliberate failed operation when its requested stream differs from the visible accepted window. */
function MusicReleasePendingWindow({
  pending,
  page,
  locale,
}: {
  pending: MusicReleasePending | undefined;
  page: Ready | undefined;
  locale: string;
}) {
  const o = { locale: locale as never };
  if (!pending) return null;
  const requested = page?.streams.find((stream) => stream.key === pending.address.stream);
  return (
    <div
      className="min-w-0 space-y-3 rounded-lg border border-border p-3 [overflow-wrap:anywhere]"
      data-slot="music-release-pending"
    >
      <h3 className="font-semibold">{m.music_release_pending_request({}, o)}</h3>
      <p>
        {pending.intent === 'previous'
          ? m.music_release_retry_previous({}, o)
          : pending.intent === 'next'
            ? m.music_release_retry_next({}, o)
            : m.music_release_retry_start({}, o)}
      </p>
      {requested ? (
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">{m.work_parts_relation({}, o)}</dt>
            <dd lang={requested.label.lang ?? undefined}>{requested.label.text || requested.property}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{m.music_release_direction({}, o)}</dt>
            <dd>
              {requested.direction === 'forward' ? m.music_release_forward({}, o) : m.music_release_inverse({}, o)}
            </dd>
          </div>
        </dl>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.music_release_retry_scope({}, o)}</p>
    </div>
  );
}
