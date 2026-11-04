import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { CandidateValue } from '../../pages/data';
import { subjectHref } from '../../../subject/subject-href';
import { correctionProposalAvailability } from '../statement-editor';
import { ValueExplanationEntry } from '../value-explanation-entry';
import type { CandidateViewerActions, NativeOperationAvailability, ViewerActionComponent } from '../../../subject/candidates';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { linkClass, linkColor, type LinkProps } from '../../pages/shared';
import { MusicReleaseFacts } from './facts';
import {
  musicReleaseHistoryLimit,
  type MusicReleaseAddress,
  type MusicReleaseRead,
  type MusicReleaseTransport,
} from './model';
import {
  musicReleaseLinkHref,
  musicReleaseReturnHref,
  musicReleaseRoute,
  musicReleaseTargetHref,
  type MusicReleaseFocus,
  type MusicReleaseReturn,
} from './navigation';

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
  /** An explicit local address for mounted examples; production uses the current Subject return query. */
  address?: MusicReleaseAddress;
};

function correctionAdvice(source: object | string, contextId: string): NativeOperationAvailability {
  if (!source || typeof source !== 'object') return 'unavailable';
  const page = source as {
    actions?: { status?: string; viewerActions?: { action: string; operations: string[] }[] };
    viewer?: { context?: string; actions?: { statementPropose?: string } };
  };
  if (page.actions?.status === 'denied') return 'denied';
  if (
    page.actions?.status !== 'ready' ||
    !Array.isArray(page.actions.viewerActions) ||
    page.viewer?.context !== contextId
  )
    return 'unavailable';
  const advice = page.viewer?.actions?.statementPropose;
  const context: ViewerActionComponent =
    advice === 'allowed'
      ? { state: 'available', actions: [{ action: 'statement:propose', operations: ['subject.propose'] }] }
      : advice === 'denied'
        ? { state: 'available', actions: [] }
        : advice === 'unavailable'
          ? { state: 'unavailable', reason: 'unavailable' }
          : { state: 'not-requested' };
  const subject: ViewerActionComponent = { state: 'available', actions: page.actions.viewerActions };
  const actions: CandidateViewerActions = { subject, context };
  return correctionProposalAvailability(actions);
}

/** Observe existing viewer/disclosure caches; a retired source never revives after an away/back transition. */
export function MusicReleaseReader(props: Props) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const base: MusicReleaseAddress = { id: props.id, context: props.context };
  const route =
    props.address !== undefined
      ? { address: props.address }
      : typeof window === 'undefined'
        ? { address: base }
        : musicReleaseRoute(window.location.search, base);
  const reading = useSubjectCommunityReading({
    source: props.source,
    reader: props.reader,
    descriptor: JSON.stringify([props.id, props.context, props.locale, props.realm, route.address, route.focus]),
  });
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [reading.key, reading.available]);
  const o = { locale: props.locale as never };
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
      {reading.available ? (
        <MusicReleaseWindow
          key={reading.key}
          {...props}
          startingAddress={route.address}
          initial={route.address.expectedRevision === undefined ? props.initial : undefined}
          returnFocus={route.focus}
          correction={correctionAdvice(props.source, props.context)}
          current={reading.isCurrent}
          focusHeading={() => heading.current?.focus()}
        />
      ) : (
        <p role="status">{m.music_release_unavailable({}, o)}</p>
      )}
    </section>
  );
}

/** Keep one accepted window and one exact pending address. Failed continuation never refills or changes stream. */
export function MusicReleaseWindow({
  id,
  context,
  locale,
  realm,
  transport,
  initial,
  startingAddress,
  returnFocus: returnLocator,
  correction,
  current,
  focusHeading,
}: Omit<Props, 'source' | 'reader'> & {
  startingAddress: MusicReleaseAddress;
  returnFocus?: MusicReleaseFocus | undefined;
  correction: NativeOperationAvailability;
  current: () => boolean;
  focusHeading: () => void;
}) {
  const o = { locale: locale as never };
  const [page, setPage] = useState<Ready | undefined>(initial?.ok ? initial : undefined);
  const [failure, setFailure] = useState<Failure | undefined>(initial && !initial.ok ? initial : undefined);
  const [busy, setBusy] = useState(!initial);
  const [history, setHistory] = useState<MusicReleaseAddress[]>([]);
  const mounted = useRef(false);
  const restoredFocus = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef<MusicReleaseAddress>(startingAddress);
  const pendingIntent = useRef<'next' | 'previous' | 'restart' | 'stream'>('restart');
  const origin = useRef<HTMLAnchorElement | null>(null);
  const trackReturnFocus = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) origin.current = event.currentTarget;
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
    intent: 'next' | 'previous' | 'restart' | 'stream',
    trigger?: HTMLButtonElement,
    keyboard = false,
  ) => {
    if (!mounted.current || !current() || inFlight.current) return;
    const previousAddress = page?.address;
    inFlight.current = true;
    const turn = ++sequence.current;
    pending.current = address;
    pendingIntent.current = intent;
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
    if (result.ok) {
      setPage(result);
      if (intent === 'next' || intent === 'stream') {
        if (previousAddress && JSON.stringify(previousAddress) !== JSON.stringify(result.address))
          setHistory((items) => [...items.slice(-(musicReleaseHistoryLimit - 1)), previousAddress]);
      } else if (intent === 'previous') {
        setHistory((items) =>
          JSON.stringify(items.at(-1)) === JSON.stringify(address) ? items.slice(0, -1) : items,
        );
      } else {
        setHistory([]);
      }
      if (
        keyboard &&
        trigger &&
        (trigger === document.activeElement || (!trigger.isConnected && document.activeElement === document.body))
      )
        focusHeading();
    } else {
      setFailure(result);
      if (result.reason !== 'unavailable') {
        setPage(undefined);
        setHistory([]);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!initial) void read(startingAddress, 'restart');
    return () => {
      mounted.current = false;
      inFlight.current = false;
      sequence.current++;
      origin.current = null;
    };
    // The parent remounts this window for every source, address, viewer or locale observation.
  }, []);
  const request = (address: MusicReleaseAddress, intent: 'next' | 'previous' | 'restart' | 'stream') =>
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!busy) void read(address, intent, event.currentTarget, event.detail === 0);
  };
  const base = { id, context };
  const currentReturn: MusicReleaseReturn | undefined = page
    ? {
        address: page.address,
        locale,
        ...(realm ? { realm } : {}),
        label: page.identity.label.text,
        revision: page.address.expectedRevision ?? page.public.subject.revision,
        digest: page.address.expectedDigest ?? page.digest,
      }
    : undefined;
  useEffect(() => {
    if (restoredFocus.current || !page || !returnLocator) return;
    restoredFocus.current = true;
    const row = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-slot="music-release-row"]') ?? []).find(
      (candidate) =>
        candidate.dataset.holder === returnLocator.holder &&
        candidate.dataset.statementId === returnLocator.statementId,
    );
    if (row) row.focus();
    else focusHeading();
  }, [page, returnLocator, focusHeading]);
  return (
    <div ref={root} className="min-w-0 space-y-4" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{m.music_release_scope({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.music_release_return({}, o)}</p>
      {busy ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {failure ? (
        <div role="alert" className="space-y-2">
          <p>
            {failure.reason === 'withheld'
              ? m.music_release_withheld({}, o)
              : failure.reason === 'changed'
                ? m.music_release_changed({}, o)
                : page
                ? m.music_release_next_unavailable({}, o)
                : m.music_release_unavailable({}, o)}
          </p>
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy}
            onClick={request(
              failure.reason === 'changed' || failure.reason === 'invalid'
                ? base
                : pending.current,
              failure.reason === 'changed' || failure.reason === 'invalid' ? 'restart' : pendingIntent.current,
            )}
          >
            {failure.reason === 'changed' || failure.reason === 'invalid'
              ? m.work_parts_restart({}, o)
              : m.album_tracks_retry({}, o)}
          </button>
        </div>
      ) : null}
      {page && currentReturn ? (
        <MusicReleaseFacts
          page={page}
          locale={locale}
          current={currentReturn}
          correction={correction}
          onNavigate={trackReturnFocus}
        />
      ) : null}
      {page && page.admitted && !page.stream ? <p role="status">{m.music_release_unconfigured({}, o)}</p> : null}
      {page && page.stream ? (
        <>
          <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.work_parts_relation({}, o)}>
            {page.streams.map((stream) => (
              <button
                key={stream.key}
                type="button"
                data-stream-key={stream.key}
                aria-pressed={stream.key === page.stream?.key}
                disabled={busy}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={request(
                  {
                    ...base,
                    stream: stream.key,
                    expectedRevision: page.public.subject.revision,
                    expectedDigest: page.digest,
                  },
                  'stream',
                )}
              >
                <span lang={stream.label.lang ?? undefined}>
                  {stream.label.text || m.work_parts_unresolved({}, o)}
                </span>
              </button>
            ))}
          </nav>
          <p className="text-sm text-muted-foreground">{m.work_parts_slice({}, o)}</p>
          {!page.caughtUp ? <p role="status">{m.work_parts_pending({}, o)}</p> : null}
          {page.count ? (
            <p>
              {m.work_parts_count(
                {
                  accuracy: page.count.exact ? m.work_parts_exact({}, o) : m.work_parts_at_least({}, o),
                  count: page.count.value,
                },
                o,
              )}
            </p>
          ) : null}
          {!page.rows.length ? <p role="status">{m.work_parts_empty({}, o)}</p> : null}
          <ul className="min-w-0 divide-y divide-border">
            {page.rows.map((row, rowIndex) => {
              const summary = row.summary;
              const type = summary ? page.types[summary.type] : undefined;
              const disclosed = !!summary;
              const focusKey = returnLocator?.holder === row.holder && returnLocator.statementId === row.statementId;
              const label = summary?.label?.value;
              const rowReturn =
                currentReturn && disclosed
                  ? { ...currentReturn, focus: { holder: row.holder, statementId: row.statementId } }
                  : currentReturn;
              const linkTo = (href: string, props: LinkProps) => (
                <a
                  href={rowReturn ? musicReleaseLinkHref(href, rowReturn) : href}
                  lang={props.lang}
                  className={props.className ?? `${linkClass} ${linkColor}`}
                  target="_blank"
                  rel="noopener"
                  onClick={trackReturnFocus}
                >
                  {props.children}
                </a>
              );
              const href =
                summary && rowReturn
                  ? musicReleaseTargetHref({ id: summary.id, label: label ?? '' }, rowReturn)
                  : undefined;
              const evidenceValue = (snak: NonNullable<typeof row.statement>['qualifiers'][number]) => {
                if (snak.property.data_type === 'wikibase-item' && snak.value.type === 'value') {
                  const target = typeof snak.value.content === 'string' ? snak.value.content : '';
                  const labels = row.related[target]?.labels ?? {};
                  if (!Object.values(labels).some(Boolean)) return <span>{m.work_parts_unresolved({}, o)}</span>;
                }
                return <CandidateValue snak={snak} related={row.related} locale={locale} link={linkTo} />;
              };
              const valueLabel = (property: string) =>
                page.labels[property]?.text || m.work_parts_unresolved({}, o);
              return (
                <li
                  key={disclosed ? `${row.holder}:${row.statementId}` : `withheld:${rowIndex}`}
                  data-slot="music-release-row"
                  {...(disclosed
                    ? { 'data-holder': row.holder, 'data-statement-id': row.statementId }
                    : {})}
                  tabIndex={focusKey ? -1 : undefined}
                  className="min-w-0"
                >
                  {!summary ? (
                    <p role="status" className="py-4">
                      {m.music_release_withheld({}, o)}
                    </p>
                  ) : (
                    <ContentItemFrame as="div" className="min-w-0 py-4 [overflow-wrap:anywhere]">
                      <details className="min-w-0 rounded-lg border border-border p-3">
                        <summary className={`${action} cursor-pointer`}>{m.album_tracks_inspect({}, o)}</summary>
                        <div className="min-w-0 space-y-3 pt-3">
                          <h3 className="font-semibold" lang={summary.label?.language}>
                            {label || m.work_parts_unresolved({}, o)}
                          </h3>
                          <p className="text-sm">
                            <span>{m.album_tracks_kind({}, o)}: </span>
                            <span lang={type?.lang ?? undefined}>
                              {type?.text || m.work_parts_unresolved({}, o)}
                            </span>
                          </p>
                          {href ? (
                            <a className={link} href={href} target="_blank" rel="noopener" onClick={trackReturnFocus}>
                              {m.album_tracks_open({}, o)}
                            </a>
                          ) : null}
                          {row.statement ? (
                            <>
                              <dl className="space-y-2">
                                {row.statement.qualifiers.map((snak, index) => (
                                  <div key={index}>
                                    <dt
                                      className="text-sm text-muted-foreground"
                                      lang={page.labels[snak.property.id]?.lang ?? undefined}
                                    >
                                      {valueLabel(snak.property.id)}
                                    </dt>
                                    <dd>{evidenceValue(snak)}</dd>
                                  </div>
                                ))}
                              </dl>
                              <details className="min-w-0 rounded-lg border border-border p-3">
                                <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
                                {row.statement.references.length ? (
                                  row.statement.references.map((reference, index) => (
                                    <dl key={index} className="mt-3 space-y-2">
                                      {reference.parts.map((snak, part) => (
                                        <div key={part}>
                                          <dt lang={page.labels[snak.property.id]?.lang ?? undefined}>
                                            {valueLabel(snak.property.id)}
                                          </dt>
                                          <dd>{evidenceValue(snak)}</dd>
                                        </div>
                                      ))}
                                    </dl>
                                  ))
                                ) : (
                                  <p>{m.music_reader_source_unavailable({}, o)}</p>
                                )}
                              </details>
                              <ValueExplanationEntry
                                id={row.holder}
                                title={row.holder === id ? page.identity.label.text : label || ''}
                                statement={row.statementId}
                                property={row.statement.property.id}
                                context={context}
                                locale={locale}
                                returnTo={musicReleaseReturnHref(rowReturn!)}
                              />
                            </>
                          ) : (
                            <p>{m.work_parts_assertion_unavailable({}, o)}</p>
                          )}
                          <details className="min-w-0 rounded-lg border border-border p-3">
                            <summary className={`${action} cursor-pointer`}>{m.catalogue_technical_details({}, o)}</summary>
                            <dl className="mt-3 space-y-2 text-sm [overflow-wrap:anywhere]">
                              <div>
                                <dt>{m.work_parts_holder({}, o)}</dt>
                                <dd>{row.holder}</dd>
                              </div>
                              <div>
                                <dt>{m.album_tracks_membership({}, o)}</dt>
                                <dd>{row.statementId}</dd>
                              </div>
                              <div>
                                <dt>{m.album_tracks_target({}, o)}</dt>
                                <dd>{summary.id}</dd>
                              </div>
                              <div>
                                <dt>{m.work_parts_relation({}, o)}</dt>
                                <dd>{valueLabel(page.stream.property)}</dd>
                              </div>
                            </dl>
                          </details>
                          {correction === 'allowed' && row.holder === id ? (
                            <a
                              className={link}
                              href={musicReleaseLinkHref(
                                `${subjectHref({ id: row.holder, label: page.identity.label.text }, locale).href}/relation-edit`,
                                rowReturn!,
                              )}
                              target="_blank"
                              rel="noopener"
                              onClick={trackReturnFocus}
                            >
                              {m.album_tracks_correction({}, o)}
                            </a>
                          ) : null}
                        </div>
                      </details>
                    </ContentItemFrame>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-3">
            {page.next ? (
              <button
                type="button"
                disabled={busy}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={request(
                  {
                    ...base,
                    stream: page.stream.key,
                    cursor: page.next,
                    expectedRevision: page.public.subject.revision,
                    expectedDigest: page.digest,
                  },
                  'next',
                )}
              >
                {m.work_parts_more({}, o)}
              </button>
            ) : (
              <p role="status">{m.album_tracks_complete({}, o)}</p>
            )}
            <button
              type="button"
              disabled={busy}
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              onClick={request({ ...base, stream: page.stream.key }, 'restart')}
            >
              {m.work_parts_restart({}, o)}
            </button>
            {history.length ? (
              <button
                type="button"
                disabled={busy}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={request(history[history.length - 1]!, 'previous')}
              >
                {m.album_tracks_previous({}, o)}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
