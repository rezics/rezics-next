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
import { subjectBody, type SubjectPageData } from './subject';
import {
  connectionGroups,
  type ConnectionAddress,
  type ConnectionGraph,
  type ConnectionGroup,
  type ConnectionSection,
  type ConnectionStream,
} from './subject-connections';
import {
  createConnectionWindow,
  type ConnectionPageState,
  type ConnectionRead,
  type ConnectionWindowResume,
} from './subject-connections-window';
import { loadSubjectConnections } from './subject-connections-query';
import {
  connectionReturnHref,
  connectionReturnGroup,
  connectionReturnWindow,
  subjectVisitReturn,
  withSubjectVisitReturn,
  type ConnectionReturnWindow,
} from './subject-visit-navigation';
import { directedWorkRelations } from './showcase-work/model';
import { WorkRelation } from './showcase-work/relation';
import { useSubjectCommunityReading } from './subject-community-lifetime';
import { characterWorkStream } from '../catalogue/character-work-visit/model';
import { CharacterWorkRows } from '../catalogue/character-work-visit/view';
import { CharacterIdentityVisit } from '../catalogue/character-identity-visit/view';
import { identityProperty } from '../catalogue/character-relationships/reading';

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
  const returnVisit = useRef<string | undefined>(undefined);
  const incarnation = useRef<{
    serial: number;
    page: SubjectPageData;
    reader: string;
    read: ConnectionRead;
    window: ReturnType<typeof createConnectionWindow>;
    resume?: ConnectionReturnWindow;
    retiredReturn: boolean;
  } | null>(null);
  const reader = JSON.stringify([
    page.subject,
    page.profile,
    subjectBody(page),
    value?.subject,
    viewer.state,
    viewer.subject,
    viewer.csrfToken,
    value?.locale,
    value?.realm,
    value?.context,
    value?.reader,
  ]);
  const readingSource = useMemo(() => ({ page, reader }), [page, reader]);
  const lifetime = useSubjectCommunityReading({
    source: readingSource,
    descriptor: reader,
    reader: viewer.state === 'signed-in' ? (viewer.subject ?? null) : null,
  });
  if (!value || !page.subject) return null;
  const character = subjectBody(page)?.subject.type === 'wd:Q95074';
  const ready =
    lifetime.available && (viewer.state === 'signed-out' || (viewer.state === 'signed-in' && !!viewer.subject));
  const current = incarnation.current;
  if (!current || current.page !== page || current.reader !== reader || current.read !== read || !lifetime.available) {
    current?.window.retire(true);
    const visitHref =
      typeof window !== 'undefined' && window.location.pathname.includes(`/subjects/${page.subject}/`)
        ? `${window.location.pathname}${window.location.search}${window.location.hash}`
        : undefined;
    const requested = visitHref ? connectionReturnWindow(new URL(visitHref, 'https://rezics.invalid').hash) : undefined;
    const retiredReturn = !!requested && returnVisit.current === visitHref;
    const resume = retiredReturn ? undefined : requested;
    returnVisit.current = visitHref;
    const address: ConnectionAddress = {
      id: page.subject,
      locale: value.locale,
      realm: value.realm,
      context: value.context?.id,
      ...(resume
        ? {
            selection: {
              [connectionReturnGroup(resume)]: {
                stream: resume.stream,
                ...(resume.cursor ? { cursor: resume.cursor } : {}),
                ...(resume.reading ? { reading: resume.reading } : {}),
              },
            },
          }
        : {}),
      ...(viewer.state === 'signed-in' && viewer.subject ? { viewer: viewer.subject } : {}),
    };
    const windowResume: ConnectionWindowResume | undefined =
      resume?.history && resume.index !== undefined
        ? {
            group: connectionReturnGroup(resume),
            stream: resume.stream,
            history: resume.history,
            index: resume.index,
          }
        : undefined;
    incarnation.current = {
      serial: ++sequence.current,
      page,
      reader,
      read,
      retiredReturn,
      window: createConnectionWindow(address, read, windowResume),
      ...(resume ? { resume } : {}),
    };
  }
  return (
    <ConnectionsReading
      key={incarnation.current!.serial}
      window={incarnation.current!.window}
      character={character}
      ready={ready}
      unavailable={viewer.state === 'unavailable' || !lifetime.available}
      returnTo={subjectVisitReturn(returnTo, value.locale)}
      resume={incarnation.current!.resume}
      retiredReturn={incarnation.current!.retiredReturn}
    />
  );
}

function connectionReturn(
  current: ConnectionSection,
  page: ConnectionPageState | undefined,
  focus?: string,
  holder?: string,
  control?: 'browse' | 'evidence',
): ConnectionReturnWindow | undefined {
  if (!current.reading) return;
  const cursor = current.section.ok && 'cursor' in current.section.read ? current.section.read.cursor : undefined;
  const history =
    page?.stream === current.stream.key &&
    page.index >= 0 &&
    page.index < page.history.length &&
    page.history.length > 0 &&
    page.history.every((entry) => entry.page !== undefined && Number.isSafeInteger(entry.page)) &&
    page.history[page.index]?.reading === current.reading &&
    page.history[page.index]?.cursor === cursor
      ? page.history.map((entry) => ({
          ...(entry.cursor ? { cursor: entry.cursor } : {}),
          reading: entry.reading,
          page: entry.page!,
        }))
      : undefined;
  return {
    stream: current.stream.key,
    reading: current.reading,
    ...(cursor ? { cursor } : {}),
    ...(focus && holder ? { focus, holder, ...(control ? { control } : {}) } : {}),
    ...(history && page ? { history, index: page.index } : {}),
  };
}

function ConnectionsReading({
  window,
  character,
  ready,
  unavailable,
  returnTo,
  resume,
  retiredReturn,
}: {
  window: ReturnType<typeof createConnectionWindow>;
  character: boolean;
  ready: boolean;
  unavailable: boolean;
  returnTo?: string | undefined;
  resume?: ConnectionReturnWindow | undefined;
  retiredReturn: boolean;
}) {
  const value = useContext(OverviewContext)!;
  const snapshot = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  const o = { locale: value.locale as never };
  const status = useRef<HTMLParagraphElement>(null);
  const focusIntent = useRef<HTMLButtonElement | null>(null);
  const [completion, setCompletion] = useState('');
  const [returnMissing, setReturnMissing] = useState(false);
  const [restartRequired, setRestartRequired] = useState(retiredReturn);
  const region = useRef<HTMLElement>(null);
  const restore = useRef(resume?.focus ? resume : undefined);
  useEffect(() => {
    if (!restore.current) return;
    const cancel = () => {
      restore.current = undefined;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, []);
  useLayoutEffect(() => {
    const target = restore.current;
    if (!target || snapshot.pending.size || !snapshot.visit) return;
    restore.current = undefined;
    const section = snapshot.visit.sections[connectionReturnGroup(target)];
    if (section?.section.ok && section.reading === target.reading) {
      const row = [
        ...(region.current?.querySelectorAll<HTMLElement>('[data-work-statement], [data-connection-statement]') ?? []),
      ].find(
        (element) =>
          (element.dataset.workStatement ?? element.dataset.connectionStatement) === target.focus &&
          (element.dataset.workHolder ?? element.dataset.connectionHolder) === target.holder,
      );
      if (row) row.querySelector<HTMLElement>('a, summary')?.focus();
      else {
        setReturnMissing(true);
        setCompletion(m.character_work_return_missing({}, { locale: value.locale as never }));
        status.current?.focus();
      }
    } else
      region.current
        ?.querySelector<HTMLElement>(`[data-connections-recovery="${connectionReturnGroup(target)}"]`)
        ?.focus();
  }, [snapshot]);
  useEffect(() => {
    window.activate();
    if (ready && !restartRequired) void window.load();
    return () => window.retire();
  }, [window, ready, restartRequired]);
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
  const currentHref = withSubjectVisitReturn(
    connectionReturnHref(value.subject!, value.subjectLabel ?? value.unlabelled, value.locale, value.realm),
    returnTo ?? '',
    value.locale,
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
      ref={region}
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
        {character ? m.character_work_title({}, o) : m.subject_connections_title({}, o)}
      </h2>
      {unavailable ? (
        <p role="alert">
          {m.subject_section_failed({}, o)}{' '}
          <a href={currentHref.split('#', 1)[0]} className={`${actionClass} inline-flex underline`}>
            {m.subject_section_retry({}, o)}
          </a>
        </p>
      ) : !ready || (!visit && snapshot.pending.size > 0) ? (
        <p role="status">{m.subject_relation_loading({}, o)}</p>
      ) : null}
      {restartRequired && (
        <div role="status" className="space-y-3">
          <p>{m.subject_relation_changed({}, o)}</p>
          <Button variant="outline" className={actionClass} onClick={() => setRestartRequired(false)}>
            {m.subject_relation_restart({}, o)}
          </Button>
        </div>
      )}
      {snapshot.failure !== undefined && (
        <div role="alert" className="space-y-3">
          <p>{failure(snapshot.failure)}</p>
          {snapshot.failure === 409 ? (
            <a href={currentHref.split('#', 1)[0]} className={`${actionClass} inline-flex text-primary underline`}>
              {m.subject_relation_restart({}, o)}
            </a>
          ) : (
            <Button variant="outline" className={actionClass} onClick={(event) => act(event, window.restart)}>
              {m.subject_relation_restart({}, o)}
            </Button>
          )}
        </div>
      )}
      {returnMissing && resume && (
        <Button
          variant="outline"
          className={actionClass}
          onClick={(event) => {
            setReturnMissing(false);
            act(event, () => window.load(connectionReturnGroup(resume), { stream: resume.stream }));
          }}
        >
          {m.subject_relation_restart({}, o)}
        </Button>
      )}
      {visit &&
        connectionGroups.map((group) => {
          const choices = visit.streams.filter((stream) => stream.group === group);
          const current = visit.sections[group];
          const characterChoices = character
            ? choices.filter((stream) => characterWorkStream(stream, value.subject!))
            : [];
          const characterKind = character && current ? characterWorkStream(current.stream, value.subject!) : undefined;
          const title = characterChoices.length
            ? group === 'characters'
              ? m.character_work_appearances({}, o)
              : m.character_work_performances({}, o)
            : titles[group];
          const busy = snapshot.pending.has(group);
          const section = current?.section;
          const characterCurrent = current?.section.ok ? { ...current, section: current.section } : undefined;
          const listed = section?.ok
            ? current?.stream.direction === 'in'
              ? holderItems(section.body, 12, value.locale, value.reader.spoilerLevel)
              : statementItems(section, current!.stream.property, 12, value)
            : undefined;
          const next = section?.ok && typeof section.body.next === 'string' ? section.body.next : undefined;
          const works =
            group === 'relations' && current && section?.ok
              ? (directedWorkRelations(
                  value.subject!,
                  current.stream.property,
                  current.stream.direction,
                  section.body,
                ) ?? [])
              : [];
          if (!choices.length) {
            if (character && group === 'relations')
              return (
                <section key={group} aria-labelledby={`connections-${group}`} className="min-w-0 space-y-4">
                  <h3 id={`connections-${group}`} className="text-xl font-semibold">
                    {m.character_identity_visit_heading({}, o)}
                  </h3>
                  <p role="status">{m.character_identity_visit_unavailable({}, o)}</p>
                </section>
              );
            return group === 'relations' || (character && group === 'characters') ? (
              <p key={group} role="status">
                {character && group === 'characters'
                  ? m.people_biography_unsupported({}, o)
                  : m.work_relations_unsupported({}, o)}
              </p>
            ) : null;
          }
          return (
            <section
              key={group}
              aria-labelledby={`connections-${group}`}
              className="min-w-0 space-y-4"
              aria-busy={busy}
            >
              <h3 id={`connections-${group}`} className="text-xl font-semibold">
                {character && group === 'relations' ? m.character_identity_visit_heading({}, o) : title}
              </h3>
              <label
                className={characterChoices.length === 1 && choices.length === 1 ? 'hidden' : 'block min-w-0 space-y-2'}
              >
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
              {snapshot.pages?.[group] ? (
                snapshot.pages[group]!.page !== undefined ? (
                  <p role="status">{m.subject_connections_page_status({ page: snapshot.pages[group]!.page! }, o)}</p>
                ) : (
                  <p role="status">{m.subject_connections_current_page({}, o)}</p>
                )
              ) : current && !busy ? (
                <p role="status">{m.subject_connections_current_page({}, o)}</p>
              ) : null}
              {busy ? (
                <p role="status">{m.subject_relation_loading({}, o)}</p>
              ) : listed ? (
                <>
                  {!characterKind && !(character && group === 'relations') && listed.count && (
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {formatCount(listed.count, value.locale)}
                    </p>
                  )}
                  {character && group === 'relations' ? (
                    <div className="min-w-0" key={`${group}:${current?.stream.key}`}>
                      <CharacterIdentityVisit
                        current={characterCurrent!}
                        items={listed.items}
                        value={rowValue}
                        more={Boolean(next)}
                        identityAvailable={choices.some((stream) => stream.property === identityProperty)}
                      />
                    </div>
                  ) : listed.items.length ? (
                    <div className="min-w-0 space-y-4" key={`${group}:${current?.stream.key}`}>
                      {characterKind && current && section?.ok && (
                        <CharacterWorkRows
                          current={current}
                          value={rowValue}
                          kind={characterKind}
                          returnWindow={connectionReturn(current, snapshot.pages?.[group])}
                        />
                      )}
                      {works.map((work) => {
                        const item = listed.items.find(
                          (item) => item.statement === work.statement.id && item.id === work.id,
                        );
                        if (!item || !current) return null;
                        const returnToFor = (control: 'browse' | 'evidence') =>
                          withSubjectVisitReturn(
                            connectionReturnHref(
                              value.subject!,
                              value.subjectLabel ?? value.unlabelled,
                              value.locale,
                              value.realm,
                              connectionReturn(
                                current,
                                snapshot.pages?.[group],
                                work.statement.id,
                                work.holder,
                                control,
                              ),
                            ),
                            returnTo ?? '',
                            value.locale,
                          );
                        const returnHref = returnToFor('browse');
                        const target = restore.current;
                        const restoreFocus =
                          target &&
                          !snapshot.pending.size &&
                          current.section.ok &&
                          current.reading === target.reading &&
                          current.stream.key === target.stream &&
                          target.focus === work.statement.id &&
                          target.holder === work.holder
                            ? {
                                control: target.control ?? ('browse' as const),
                                current: () => ready && restore.current === target,
                                complete: () => {
                                  restore.current = undefined;
                                },
                              }
                            : undefined;
                        const WorkLink: typeof PlainLink = (props) => (
                          <Link {...props} href={withSubjectVisitReturn(props.href, returnHref, value.locale)} />
                        );
                        return (
                          <div
                            key={JSON.stringify([work, value.context, value.reader])}
                            data-work-statement={work.statement.id}
                            data-work-holder={work.holder}
                          >
                            <WorkRelation
                              relation={work}
                              item={item}
                              value={{ ...rowValue, link: WorkLink }}
                              label={current.stream.label}
                              returnToFor={returnToFor}
                              restoreFocus={restoreFocus}
                            />
                          </div>
                        );
                      })}
                      {!characterKind && (
                        <CoverList
                          items={listed.items.filter(
                            (item) =>
                              !works.some((work) => item.statement === work.statement.id && item.id === work.id),
                          )}
                          value={rowValue}
                          label={titles[group]}
                        />
                      )}
                    </div>
                  ) : (
                    <p role="status">
                      {section?.ok &&
                      Array.isArray(section.body[current?.stream.direction === 'in' ? 'links' : 'relations']) &&
                      (section.body[current?.stream.direction === 'in' ? 'links' : 'relations'] as unknown[]).length > 0
                        ? m.subject_relation_unavailable({}, o)
                        : m.subject_relation_empty_page({}, o)}
                    </p>
                  )}
                  {characterKind && <p className="text-sm text-muted-foreground">{m.character_work_window({}, o)}</p>}
                  {snapshot.pages?.[group] && snapshot.pages[group]!.index > 0 && (
                    <Button
                      variant="outline"
                      className={actionClass}
                      disabled={busy}
                      onClick={(event) => act(event, () => window.previous(group))}
                    >
                      {m.subject_connections_previous({}, o)}
                    </Button>
                  )}
                  {snapshot.pages?.[group]?.index === 0 &&
                    (snapshot.pages[group]!.page === undefined
                      ? Boolean(snapshot.pages[group]!.history[0]?.cursor)
                      : snapshot.pages[group]!.page! > 1) && (
                      <div className="space-y-2">
                        <p role="status">{m.subject_connections_history_boundary({}, o)}</p>
                        <Button
                          variant="outline"
                          className={actionClass}
                          disabled={busy}
                          onClick={(event) => act(event, () => window.restartGroup(group))}
                        >
                          {m.subject_relation_restart({}, o)}
                        </Button>
                      </div>
                    )}
                  {next && current && (
                    <Button
                      variant="outline"
                      className={actionClass}
                      disabled={busy}
                      onClick={(event) => act(event, () => window.next(group))}
                    >
                      {m.subject_connections_next({}, o)}
                    </Button>
                  )}
                </>
              ) : (
                <div role="alert" tabIndex={-1} data-connections-recovery={group} className="space-y-3">
                  <p>{failure(section && !section.ok ? (section.status ?? 503) : 503)}</p>
                  <Button
                    variant="outline"
                    className={actionClass}
                    onClick={(event) =>
                      act(event, () =>
                        section && !section.ok && section.status === 409
                          ? window.load(group, { stream: current?.stream.key ?? choices[0]!.key })
                          : window.retry(group),
                      )
                    }
                  >
                    {section && !section.ok && section.status === 409
                      ? m.subject_relation_restart({}, o)
                      : m.subject_section_retry({}, o)}
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
