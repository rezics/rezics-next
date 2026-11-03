import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { PlainLink } from './shared';
import { CoverList } from './cover-list';
import { SpoilerGate } from './values';
import { OverviewContext, holderItems, statementItems } from './overview';
import { formatCount } from '../count';
import type { SubjectPageData } from './subject';
import {
  connectionGroups,
  type ConnectionAddress,
  type ConnectionGraph,
  type ConnectionGroup,
  type ConnectionStream,
} from './subject-connections';
import { createConnectionWindow, type ConnectionRead } from './subject-connections-window';
import { loadSubjectConnections } from './subject-connections-query';
import { connectionReturnHref, subjectVisitReturn, withSubjectVisitReturn } from './subject-visit-navigation';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const productionRead: ConnectionRead = (data, signal) => loadSubjectConnections({ data, signal });
type Viewer = { state: string; subject?: string | null; csrfToken: string | null };

/** The route supplies its actual reading and current session; private pages never enter QueryClient or hydration. */
export function SubjectConnections({
  page,
  viewer,
  returnTo,
  read = productionRead,
}: {
  page: SubjectPageData;
  viewer: Viewer;
  returnTo?: string | undefined;
  read?: ConnectionRead;
}) {
  const value = useContext(OverviewContext);
  const sequence = useRef(0);
  const incarnation = useRef<{
    serial: number;
    page: SubjectPageData;
    reader: string;
    read: ConnectionRead;
    window: ReturnType<typeof createConnectionWindow>;
  } | null>(null);
  const reader = JSON.stringify([
    viewer.state,
    viewer.subject,
    viewer.csrfToken,
    value?.locale,
    value?.realm,
    value?.context,
    value?.reader,
  ]);
  if (!value || !page.subject) return null;
  const ready = viewer.state === 'signed-out' || (viewer.state === 'signed-in' && !!viewer.subject);
  const current = incarnation.current;
  if (!current || current.page !== page || current.reader !== reader || current.read !== read) {
    current?.window.retire(true);
    const address: ConnectionAddress = {
      id: page.subject,
      locale: value.locale,
      realm: value.realm,
      context: value.context?.id,
      ...(viewer.state === 'signed-in' && viewer.subject ? { viewer: viewer.subject } : {}),
    };
    incarnation.current = {
      serial: ++sequence.current,
      page,
      reader,
      read,
      window: createConnectionWindow(address, read),
    };
  }
  return (
    <ConnectionsReading
      key={incarnation.current!.serial}
      window={incarnation.current!.window}
      ready={ready}
      unavailable={viewer.state === 'unavailable'}
      returnTo={subjectVisitReturn(returnTo, value.locale)}
    />
  );
}

function ConnectionsReading({
  window,
  ready,
  unavailable,
  returnTo,
}: {
  window: ReturnType<typeof createConnectionWindow>;
  ready: boolean;
  unavailable: boolean;
  returnTo?: string | undefined;
}) {
  const value = useContext(OverviewContext)!;
  const snapshot = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  const o = { locale: value.locale as never };
  const status = useRef<HTMLParagraphElement>(null);
  const focusIntent = useRef<HTMLButtonElement | null>(null);
  const [completion, setCompletion] = useState('');
  useEffect(() => {
    window.activate();
    if (ready) void window.load();
    return () => window.retire();
  }, [window, ready]);
  useLayoutEffect(() => {
    const trigger = focusIntent.current;
    if (snapshot.pending.size || !trigger) return;
    focusIntent.current = null;
    // The requesting button vanished at exhaustion; a reader who moved elsewhere keeps focus.
    if (!trigger.isConnected && trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
      status.current?.focus();
  }, [snapshot]);
  function act(event: MouseEvent<HTMLButtonElement>, request: () => Promise<void>) {
    if (event.detail === 0) focusIntent.current = event.currentTarget;
    setCompletion('');
    void request().then(() => {
      const current = window.snapshot();
      if (current.visit) setCompletion(m.subject_connections_updated({}, o));
    });
  }
  const visit = snapshot.visit;
  const currentHref = connectionReturnHref(
    value.subject!,
    value.subjectLabel ?? value.unlabelled,
    value.locale,
    value.realm,
  );
  const Link = value.link;
  const link = useMemo<typeof PlainLink>(
    () => (props) => <Link {...props} href={withSubjectVisitReturn(props.href, currentHref, value.locale)} />,
    [Link, currentHref, value.locale],
  );
  const rowValue = { ...value, link, ...(visit?.context ? { context: visit.context } : {}) };
  const failure = (status: number) =>
    status === 409
      ? m.subject_relation_changed({}, o)
      : [401, 403, 404].includes(status)
        ? m.subject_relation_unavailable({}, o)
        : status === 400 || status === 422
          ? m.subject_relation_invalid({}, o)
          : m.subject_section_failed({}, o);
  const titles: Record<ConnectionGroup, string> = {
    relations: m.subject_relations({}, o),
    characters: m.subject_characters({}, o),
    credits: m.subject_credits({}, o),
  };
  return (
    <section
      id="connections"
      data-slot="subject-connections"
      aria-labelledby="connections-heading"
      className="min-w-0 scroll-mt-32 space-y-6"
    >
      {returnTo && (
        <a href={returnTo} className={`${actionClass} inline-flex text-primary underline underline-offset-4`}>
          {m.subject_connections_return({}, o)}
        </a>
      )}
      <h2 id="connections-heading" className="font-sans text-2xl font-semibold">
        {m.subject_connections_title({}, o)}
      </h2>
      {unavailable ? (
        <p role="alert">
          {m.subject_section_failed({}, o)}{' '}
          <a href={currentHref} className={`${actionClass} inline-flex underline`}>
            {m.subject_section_retry({}, o)}
          </a>
        </p>
      ) : !ready || (!visit && snapshot.pending.size > 0) ? (
        <p role="status">{m.subject_relation_loading({}, o)}</p>
      ) : null}
      {snapshot.failure !== undefined && (
        <div role="alert" className="space-y-3">
          <p>{failure(snapshot.failure)}</p>
          {snapshot.failure === 409 ? (
            <a href={currentHref} className={`${actionClass} inline-flex text-primary underline`}>
              {m.subject_relation_restart({}, o)}
            </a>
          ) : (
            <Button variant="outline" className={actionClass} onClick={(event) => act(event, window.restart)}>
              {m.subject_relation_restart({}, o)}
            </Button>
          )}
        </div>
      )}
      {visit &&
        connectionGroups.map((group) => {
          const choices = visit.streams.filter((stream) => stream.group === group);
          const current = visit.sections[group];
          const busy = snapshot.pending.has(group);
          const section = current?.section;
          const listed = section?.ok
            ? current?.stream.direction === 'in'
              ? holderItems(section.body, 12, value.locale, value.reader.spoilerLevel)
              : statementItems(section, current!.stream.property, 12, value)
            : undefined;
          const next = section?.ok && typeof section.body.next === 'string' ? section.body.next : undefined;
          if (!choices.length) return null;
          return (
            <section
              key={group}
              aria-labelledby={`connections-${group}`}
              className="min-w-0 space-y-4"
              aria-busy={busy}
            >
              <h3 id={`connections-${group}`} className="text-xl font-semibold">
                {titles[group]}
              </h3>
              <label className="block min-w-0 space-y-2">
                <span className="text-sm font-medium">{m.subject_connections_relation({}, o)}</span>
                <NativeSelect
                  className="min-h-11 w-full max-w-full"
                  value={current?.stream.key ?? ''}
                  disabled={busy}
                  onChange={(event) => {
                    setCompletion('');
                    void window.load(group, { stream: event.target.value });
                  }}
                >
                  {!current && <NativeSelectOption value="">{m.subject_relation_loading({}, o)}</NativeSelectOption>}
                  {choices.map((stream) => (
                    <NativeSelectOption key={stream.key} value={stream.key}>
                      {stream.label} ·{' '}
                      {stream.direction === 'in' ? m.subject_connections_in({}, o) : m.subject_connections_out({}, o)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              {busy ? (
                <p role="status">{m.subject_relation_loading({}, o)}</p>
              ) : listed ? (
                <>
                  {listed.count && (
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {formatCount(listed.count, value.locale)}
                    </p>
                  )}
                  {listed.items.length ? (
                    <CoverList
                      key={`${group}:${current?.stream.key}`}
                      items={listed.items}
                      value={rowValue}
                      label={titles[group]}
                    />
                  ) : (
                    <p role="status">{m.subject_relation_empty_page({}, o)}</p>
                  )}
                  {next && current && (
                    <Button
                      variant="outline"
                      className={actionClass}
                      aria-disabled={busy}
                      onClick={(event) =>
                        act(event, () => window.load(group, { stream: current.stream.key, cursor: next }))
                      }
                    >
                      {m.subject_relations_more({}, o)}
                    </Button>
                  )}
                </>
              ) : (
                <div role="alert" className="space-y-3">
                  <p>{failure(section && !section.ok ? (section.status ?? 503) : 503)}</p>
                  <Button
                    variant="outline"
                    className={actionClass}
                    onClick={(event) =>
                      act(event, () => window.load(group, { stream: current?.stream.key ?? choices[0]!.key }))
                    }
                  >
                    {m.subject_section_retry({}, o)}
                  </Button>
                </div>
              )}
            </section>
          );
        })}
      {visit && (
        <NativeNeighbourhood
          streams={visit.streams}
          graph={visit.graph}
          busy={snapshot.pending.has('graph')}
          locale={value.locale}
          unavailable={Boolean(value.realm)}
          returnTo={connectionReturnHref(
            value.subject!,
            value.subjectLabel ?? value.unlabelled,
            value.locale,
            value.realm,
          )}
          run={(properties, depth) => window.load(undefined, undefined, { properties, depth })}
        />
      )}
      <p
        ref={status}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {completion}
      </p>
    </section>
  );
}

function NativeNeighbourhood({
  streams,
  graph,
  busy,
  locale,
  unavailable,
  returnTo,
  run,
}: {
  streams: ConnectionStream[];
  graph: { ok: true; body: ConnectionGraph } | { ok: false; status: number } | undefined;
  busy: boolean;
  locale: string;
  unavailable: boolean;
  returnTo: string;
  run: (properties: string[], depth: 1 | 2) => Promise<void>;
}) {
  const value = useContext(OverviewContext)!;
  const o = { locale: locale as never };
  const id = useId();
  const choices = streams.filter(
    (stream, index) => streams.findIndex((other) => other.property === stream.property) === index,
  );
  const [properties, setProperties] = useState<string[]>(() =>
    choices
      .filter((stream) => stream.group === 'relations')
      .slice(0, 8)
      .map((stream) => stream.property),
  );
  const [depth, setDepth] = useState<1 | 2>(1);
  const nodes = new Map(graph?.ok ? graph.body.nodes.map((node) => [node.id, node]) : []);
  return (
    <details className="min-w-0 space-y-4 rounded-lg border border-border p-4">
      <summary className={`${actionClass} cursor-pointer font-medium`}>{m.subject_connections_explore({}, o)}</summary>
      {unavailable ? (
        <p>{m.subject_connections_global({}, o)}</p>
      ) : (
        <>
          <fieldset disabled={busy} className="min-w-0 space-y-3">
            <legend className="text-sm font-medium">{m.subject_connections_choose({}, o)}</legend>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              {choices.map((stream, index) => (
                <label
                  key={stream.property}
                  htmlFor={`${id}-${index}`}
                  className="flex min-h-11 min-w-0 items-center gap-3 [overflow-wrap:anywhere]"
                >
                  <input
                    id={`${id}-${index}`}
                    type="checkbox"
                    checked={properties.includes(stream.property)}
                    disabled={!properties.includes(stream.property) && properties.length >= 8}
                    onChange={(event) =>
                      setProperties((current) =>
                        event.target.checked
                          ? [...current, stream.property]
                          : current.filter((property) => property !== stream.property),
                      )
                    }
                  />
                  <span lang={stream.language ?? undefined}>{stream.label}</span>
                </label>
              ))}
            </div>
            <label className="block space-y-2">
              <span>{m.subject_connections_depth({}, o)}</span>
              <NativeSelect
                value={depth}
                onChange={(event) => setDepth(event.target.value === '2' ? 2 : 1)}
                className="min-h-11"
              >
                <NativeSelectOption value={1}>1</NativeSelectOption>
                <NativeSelectOption value={2}>2</NativeSelectOption>
              </NativeSelect>
            </label>
          </fieldset>
          <Button
            variant="outline"
            className={actionClass}
            disabled={busy || properties.length === 0}
            onClick={() => void run(properties, depth)}
          >
            {busy ? m.subject_relation_loading({}, o) : m.subject_connections_explore({}, o)}
          </Button>
          {graph && !graph.ok && <p role="alert">{m.subject_section_failed({}, o)}</p>}
          {graph?.ok && (
            <>
              <p>{m.subject_connections_bounded({}, o)}</p>
              <ul className="space-y-3">
                {graph.body.edges.flatMap((edge) => {
                  const from = nodes.get(edge.from),
                    to = nodes.get(edge.to);
                  if (!from?.summary || !to?.summary || from.summary.id !== from.id || to.summary.id !== to.id)
                    return [];
                  const stream =
                    streams.find((stream) => stream.property === edge.property && stream.direction === 'out') ??
                    streams.find((stream) => stream.property === edge.property);
                  return (
                    <li
                      key={`${edge.from}:${edge.statement}:${edge.to}`}
                      className="min-w-0 space-y-1 [overflow-wrap:anywhere]"
                    >
                      <SpoilerGate label={value.spoilerShow} hideLabel={value.labels.spoilerHide}>
                        <a
                          className={`${actionClass} inline-flex text-primary underline underline-offset-4`}
                          href={withSubjectVisitReturn(
                            connectionReturnHref(from.id, from.label, locale),
                            returnTo,
                            locale,
                          )}
                        >
                          {from.label || value.unlabelled}
                        </a>
                        <span className="px-2 text-sm text-muted-foreground">{stream?.forwardLabel}</span>
                        <a
                          className={`${actionClass} inline-flex text-primary underline underline-offset-4`}
                          href={withSubjectVisitReturn(connectionReturnHref(to.id, to.label, locale), returnTo, locale)}
                        >
                          {to.label || value.unlabelled}
                        </a>
                      </SpoilerGate>
                    </li>
                  );
                })}
              </ul>
              {graph.body.edges.length === 0 && <p role="status">{m.subject_relation_empty_page({}, o)}</p>}
              {graph.body.truncated.length > 0 && <p role="status">{m.subject_connections_truncated({}, o)}</p>}
            </>
          )}
        </>
      )}
    </details>
  );
}
