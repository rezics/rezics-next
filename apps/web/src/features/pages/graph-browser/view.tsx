import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/load-subject';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import { ViewHeading } from '../view-heading';
import { graphPublicIntentFits, graphPublicVisitSearch, type GraphPublicVisit } from './public-visit';
import {
  GRAPH_LIMIT,
  type GraphBrowserTransport,
  type GraphEdge,
  type GraphBrowserRouteState,
  type GraphNode,
  type GraphRead,
  type GraphSelection,
  type GraphTruncation,
} from './index';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type { GraphBrowserTransport } from './index';

function option(locale: string) {
  return { locale: locale as never };
}

function selectedKey(selection: GraphSelection | undefined) {
  if (!selection) return '';
  return selection.kind === 'node' ? `node:${selection.id}` : `edge:${selection.statement}`;
}

function GraphList({
  nodes,
  edges,
  selected,
  selectionConfirmed,
  onSelect,
  locale,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string;
  selectionConfirmed: boolean;
  onSelect: (selection: GraphSelection) => void;
  locale: string;
}) {
  const o = option(locale);
  const nodeOf = (id: string) => nodes.find((node) => node.id === id);
  return (
    <table className="w-full min-w-0 border-collapse text-sm">
      <caption className="sr-only">{m.graph_explore_list({}, o)}</caption>
      <thead>
        <tr>
          <th className="border-b py-2 text-start">{m.graph_explore_from({}, o)}</th>
          <th className="border-b py-2 text-start">{m.graph_explore_edge({}, o)}</th>
          <th className="border-b py-2 text-start">{m.graph_explore_to({}, o)}</th>
        </tr>
      </thead>
      <tbody>
        {edges.map((edge) => {
          const key = `edge:${edge.statement}`;
          return (
            <tr key={edge.statement} className={selected === key ? 'bg-muted' : undefined}>
              <td className="py-1">
                <Button
                  type="button"
                  variant="ghost"
                  className={actionClass}
                  data-graph-selection={`node:${edge.from}`}
                  aria-pressed={selectionConfirmed && selected === `node:${edge.from}`}
                  onClick={() => onSelect({ kind: 'node', id: edge.from })}
                >
                  {nodeOf(edge.from)?.label || m.subject_value_unlabelled({}, o)}
                </Button>
              </td>
              <td className="py-1">
                <Button
                  type="button"
                  variant="ghost"
                  className={actionClass}
                  data-graph-selection={key}
                  aria-pressed={selectionConfirmed && selected === key}
                  onClick={() => onSelect({ kind: 'edge', ...edge })}
                >
                  {edge.property}
                </Button>
              </td>
              <td className="py-1">
                <Button
                  type="button"
                  variant="ghost"
                  className={actionClass}
                  data-graph-selection={`node:${edge.to}`}
                  aria-pressed={selectionConfirmed && selected === `node:${edge.to}`}
                  onClick={() => onSelect({ kind: 'node', id: edge.to })}
                >
                  {nodeOf(edge.to)?.label || m.subject_value_unlabelled({}, o)}
                </Button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function GraphDiagram({
  nodes,
  edges,
  selected,
  selectionConfirmed,
  onSelect,
  locale,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string;
  selectionConfirmed: boolean;
  onSelect: (selection: GraphSelection) => void;
  locale: string;
}) {
  const o = option(locale);
  const order = useMemo(() => nodes.map((node) => node.id), [nodes]);
  function move(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = order.indexOf(id);
    const next = event.key === 'ArrowDown' ? (order[index + 1] ?? order[0]) : (order[index - 1] ?? order.at(-1));
    if (next) onSelect({ kind: 'node', id: next });
  }
  const width = 360;
  const height = Math.max(160, nodes.length * 48);
  return (
    <svg
      role="group"
      aria-label={m.graph_explore_diagram({}, o)}
      viewBox={`0 0 ${width} ${height}`}
      className="max-w-full"
    >
      {edges.map((edge, index) => {
        const from = order.indexOf(edge.from);
        const to = order.indexOf(edge.to);
        const y1 = 24 + Math.max(from, 0) * 48;
        const y2 = 24 + Math.max(to, 0) * 48;
        const key = `edge:${edge.statement}`;
        return (
          <g key={edge.statement}>
            <line x1={48} y1={y1} x2={312} y2={y2} className="stroke-border" strokeWidth={selected === key ? 3 : 1} />
            <foreignObject x={140} y={(y1 + y2) / 2 - 16} width={80} height={32}>
              <Button
                type="button"
                size="sm"
                variant={selected === key ? 'default' : 'outline'}
                className={actionClass}
                data-graph-selection={key}
                aria-pressed={selectionConfirmed && selected === key}
                onClick={() => onSelect({ kind: 'edge', ...edge })}
              >
                {index + 1}
              </Button>
            </foreignObject>
          </g>
        );
      })}
      {nodes.map((node, index) => {
        const key = `node:${node.id}`;
        const x = index % 2 === 0 ? 8 : 248;
        const y = 8 + index * 48;
        return (
          <foreignObject key={node.id} x={x} y={y} width={104} height={40}>
            <Button
              type="button"
              size="sm"
              variant={selected === key ? 'default' : 'outline'}
              className={actionClass}
              data-graph-selection={key}
              aria-pressed={selectionConfirmed && selected === key}
              onClick={() => onSelect({ kind: 'node', id: node.id })}
              onKeyDown={(event) => move(event, node.id)}
            >
              {node.label || m.subject_value_unlabelled({}, o)}
            </Button>
          </foreignObject>
        );
      })}
    </svg>
  );
}

type GraphSuccess = Extract<GraphRead, { ok: true }>;
type GraphFailure = Extract<GraphRead, { ok: false }>;
type GraphRoute = GraphBrowserRouteState;
type GraphRequestKind = 'initial' | 'filter' | 'selection' | 'expansion';
type GraphRequestInput = Parameters<GraphBrowserTransport['read']>[0];
type GraphSource = { id: string; locale: string; reader?: string | undefined; transport: GraphBrowserTransport };
type GraphRequestRecord = {
  source: GraphSource;
  route: GraphRoute;
  routeKey: string;
  kind: GraphRequestKind;
  query: GraphRequestInput;
  selection?: GraphSelection | undefined;
};
type GraphPageState = {
  source: GraphSource;
  route: GraphRoute;
  routeKey: string;
  status: 'idle' | 'pending' | 'success' | 'failure';
  kind: GraphRequestKind;
  requestId: number;
  read?: GraphSuccess | undefined;
  readRevision: number;
  failure?: GraphFailure | undefined;
  record?: GraphRequestRecord | undefined;
  awaitingRoute?: boolean | undefined;
  localOnly?: boolean | undefined;
};

function copyRoute(route: GraphRoute): GraphRoute {
  return {
    property: route.property,
    direction: route.direction,
    depth: route.depth,
    node: route.node,
    edge: route.edge,
    from: route.from,
    to: route.to,
    edgeProperty: route.edgeProperty,
  };
}

function routeKey(route: GraphRoute) {
  return JSON.stringify([
    route.property,
    route.direction,
    route.depth,
    route.node,
    route.edge,
    route.from,
    route.to,
    route.edgeProperty,
  ]);
}

function baseRouteKey(route: GraphRoute) {
  return JSON.stringify([route.property, route.direction, route.depth]);
}

function requestedSelection(route: GraphRoute): GraphSelection | undefined {
  if (route.node) return { kind: 'node', id: route.node };
  if (route.edge && route.from && route.to && route.edgeProperty)
    return { kind: 'edge', statement: route.edge, from: route.from, to: route.to, property: route.edgeProperty };
  return undefined;
}

function hasRequestedSelection(route: GraphRoute) {
  return !!route.node || !!route.edge;
}

function queryForRoute(route: GraphRoute, session?: string): GraphRequestInput {
  return {
    property: route.property,
    direction: route.direction,
    depth: route.depth,
    node: route.node,
    edge: route.edge,
    from: route.from,
    to: route.to,
    edgeProperty: route.edgeProperty,
    ...(session ? { session } : {}),
  };
}

function responseMatchesRoute(read: GraphSuccess, route: GraphRoute) {
  if (!hasRequestedSelection(route)) return true;
  const selection = requestedSelection(route);
  if (!selection) return false;
  if (selection.kind === 'node') return read.detail?.subject.subject.id === selection.id;
  return (
    read.detail?.subject.subject.id === selection.from &&
    read.detail.statement?.id === selection.statement &&
    read.detail.statement.property.id === selection.property &&
    read.graph.edges.some(
      (edge) =>
        edge.statement === selection.statement &&
        edge.from === selection.from &&
        edge.to === selection.to &&
        edge.property === selection.property,
    )
  );
}

function canonicalRoute(read: GraphSuccess, route: GraphRoute): GraphRoute {
  return {
    ...route,
    property: read.query.property.join(','),
    direction: read.query.direction,
    depth: read.query.depth,
  };
}

function initialPageState(source: GraphSource, route: GraphRoute, initial: GraphRead | undefined): GraphPageState {
  const key = routeKey(route);
  const record: GraphRequestRecord = {
    source,
    route,
    routeKey: key,
    kind: 'initial',
    query: queryForRoute(route),
    selection: requestedSelection(route),
  };
  if (!initial) return { source, route, routeKey: key, status: 'idle', kind: 'initial', requestId: 0, readRevision: 0 };
  if (!initial.ok) {
    return {
      source,
      route,
      routeKey: key,
      status: 'failure',
      kind: 'initial',
      requestId: 0,
      readRevision: 0,
      failure: initial,
      record,
    };
  }
  if (!responseMatchesRoute(initial, route)) {
    return {
      source,
      route,
      routeKey: key,
      status: 'failure',
      kind: 'initial',
      requestId: 0,
      readRevision: 0,
      failure: { ok: false, reason: 'stale' },
      record,
    };
  }
  return {
    source,
    route: canonicalRoute(initial, route),
    routeKey: key,
    status: 'success',
    kind: 'initial',
    requestId: 0,
    readRevision: 0,
    read: initial,
  };
}

/** Build a same-origin graph return link from only admitted public query state. */
export function graphBrowserReturnHref(
  path: string,
  query: GraphSuccess['query'],
  selection?: GraphSelection | undefined,
  visit?: GraphPublicVisit | undefined,
) {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || /[?#\\]/.test(path)) return undefined;
  const params = new URLSearchParams({
    property: query.property.join(','),
    direction: query.direction,
    depth: String(query.depth),
  });
  if (selection?.kind === 'node') params.set('node', selection.id);
  if (selection?.kind === 'edge') {
    params.set('edge', selection.statement);
    params.set('from', selection.from);
    params.set('to', selection.to);
    params.set('edgeProperty', selection.property);
  }
  for (const [key, value] of Object.entries(graphPublicVisitSearch(visit))) params.set(key, value);
  const href = `${path}?${params.toString()}`;
  return graphPublicIntentFits(href) ? href : undefined;
}

function appendReturnTo(href: string, returnTo: string | undefined) {
  if (!returnTo) return href;
  return `${href}${href.includes('?') ? '&' : '?'}${new URLSearchParams({ returnTo })}`;
}

export function GraphBrowserPage({
  id,
  locale,
  property,
  direction,
  depth,
  node,
  edge,
  from,
  to,
  edgeProperty,
  visit,
  publicReturnHref,
  transport,
  initial,
  reader,
  graphPath,
  onNavigate,
}: {
  id: string;
  locale: string;
  property?: string | undefined;
  direction?: string | undefined;
  depth?: number | undefined;
  node?: string | undefined;
  edge?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  edgeProperty?: string | undefined;
  visit?: GraphPublicVisit | undefined;
  publicReturnHref?: string | undefined;
  transport: GraphBrowserTransport;
  initial?: GraphRead | undefined;
  reader?: string | undefined;
  graphPath?: string | undefined;
  onNavigate?: ((state: GraphBrowserRouteState) => void | Promise<unknown>) | undefined;
}) {
  const o = option(locale);
  const relationId = useId();
  const directionId = useId();
  const depthId = useId();
  const failureRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const relationRef = useRef<HTMLSelectElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const focusIntentRef = useRef<{ kind: 'selection'; key: string } | { kind: 'relation' } | null>(null);
  const source = useMemo<GraphSource>(() => ({ id, locale, reader, transport }), [id, locale, reader, transport]);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const route = useMemo(
    () => copyRoute({ property, direction, depth, node, edge, from, to, edgeProperty }),
    [property, direction, depth, node, edge, from, to, edgeProperty],
  );
  const propsRouteKey = routeKey(route);
  const sequenceRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<{ source: GraphSource; token?: string | undefined }>({
    source,
    token: initial?.ok ? initial.session : undefined,
  });
  const [current, setCurrent] = useState(() => initialPageState(source, route, initial));
  const [addressLimit, setAddressLimit] = useState(false);
  const currentRef = useRef(current);
  function publish(next: GraphPageState) {
    currentRef.current = next;
    setCurrent(next);
  }
  function makeRecord(
    target: GraphRoute,
    kind: GraphRequestKind,
    extra: Partial<GraphRequestInput> = {},
  ): GraphRequestRecord {
    if (sessionRef.current.source !== source) sessionRef.current = { source };
    const token = sessionRef.current.token;
    return {
      source,
      route: copyRoute(target),
      routeKey: routeKey(target),
      kind,
      query: { ...queryForRoute(target, token), ...extra },
      selection: requestedSelection(target),
    };
  }
  function runRecord(record: GraphRequestRecord, awaitingRoute = false, localOnly = false) {
    const previous = currentRef.current;
    if (sessionRef.current.source !== record.source) sessionRef.current = { source: record.source };
    const retainRead =
      (record.kind === 'selection' || record.kind === 'expansion') &&
      previous.source === record.source &&
      previous.read &&
      baseRouteKey(previous.route) === baseRouteKey(record.route)
        ? previous.read
        : undefined;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const requestId = ++sequenceRef.current;
    const pending: GraphPageState = {
      source: record.source,
      route: record.route,
      routeKey: record.routeKey,
      status: 'pending',
      kind: record.kind,
      requestId,
      read: retainRead,
      readRevision: retainRead ? previous.readRevision : 0,
      record,
      awaitingRoute,
      localOnly,
    };
    publish(pending);
    void (async () => {
      try {
        const result = await record.source.transport.read(record.query, controller.signal);
        if (controller.signal.aborted || sequenceRef.current !== requestId || sourceRef.current !== record.source)
          return;
        if (!result.ok) {
          if (result.clearPrivate || result.reason === 'denied') sessionRef.current = { source: record.source };
          publish({
            ...pending,
            status: 'failure',
            failure: result,
            read: result.clearPrivate || result.reason === 'denied' ? undefined : retainRead,
          });
          return;
        }
        if (result.session) sessionRef.current = { source: record.source, token: result.session };
        if (!responseMatchesRoute(result, record.route)) {
          publish({
            ...pending,
            status: 'failure',
            failure: { ok: false, reason: 'stale' },
            read: retainRead,
          });
          return;
        }
        publish({
          ...pending,
          route: canonicalRoute(result, record.route),
          status: 'success',
          read: result,
          readRevision: requestId,
          failure: undefined,
          record: undefined,
          awaitingRoute: false,
          localOnly: pending.localOnly,
        });
      } catch {
        if (controller.signal.aborted || sequenceRef.current !== requestId || sourceRef.current !== record.source)
          return;
        publish({
          ...pending,
          status: 'failure',
          failure: { ok: false, reason: 'unavailable' },
          read: retainRead,
        });
      }
    })();
  }
  useEffect(() => {
    const previous = currentRef.current;
    if (previous.source === source && previous.routeKey === propsRouteKey) {
      if (previous.status === 'idle' || (previous.status === 'pending' && previous.requestId !== sequenceRef.current))
        runRecord(makeRecord(route, 'initial'));
      else if (previous.awaitingRoute) publish({ ...previous, awaitingRoute: false });
      return;
    }
    runRecord(makeRecord(route, 'initial'));
  }, [source, propsRouteKey]);
  useEffect(
    () => () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
      focusIntentRef.current = null;
    },
    [source],
  );

  const stateMatchesRoute =
    current.source === source && (current.routeKey === propsRouteKey || !!current.awaitingRoute || !!current.localOnly);
  const active = stateMatchesRoute ? current : undefined;
  const status = active?.status === 'idle' ? 'pending' : (active?.status ?? 'pending');
  const activeRoute = active?.route ?? route;
  const baseRead = active?.read;
  const keepDetail = active?.status === 'success' || active?.kind === 'expansion';
  const read = baseRead && !keepDetail ? { ...baseRead, detail: null } : baseRead;
  const selection = requestedSelection(activeRoute);
  const selected = selectedKey(selection);
  const selectionConfirmed = active?.status === 'success' && !!selection;
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const origin = subjectHref({ id, label: title.text }, locale);
  const returnTo =
    active?.status === 'success' && read && graphPath
      ? graphBrowserReturnHref(graphPath, read.query, selection, visit)
      : undefined;
  const quotations = read?.detail
    ? catalogueEntries.quotations({
        id: read.detail.subject.subject.id,
        label: pickText(read.detail.subject.subject.labels, locale).text,
        locale,
        returnTo,
      })
    : null;
  const error = active?.status === 'failure' ? active.failure : undefined;
  const failed =
    error?.reason === 'denied'
      ? m.graph_explore_denied({}, o)
      : error?.reason === 'invalid' || error?.reason === 'stale'
        ? m.graph_explore_stale({}, o)
        : m.graph_explore_unavailable({}, o);

  function request(
    target: GraphRoute,
    kind: GraphRequestKind,
    extra: Partial<GraphRequestInput> = {},
    writeHistory = true,
  ) {
    const routeTarget = copyRoute(target);
    const targetKey = routeKey(routeTarget);
    const shouldNavigate = !!writeHistory && !!onNavigate && targetKey !== propsRouteKey;
    if (shouldNavigate && graphPath) {
      const nextAddress = graphBrowserReturnHref(
        graphPath,
        {
          property: (routeTarget.property ?? '').split(',').filter(Boolean),
          direction: routeTarget.direction === 'out' || routeTarget.direction === 'in' ? routeTarget.direction : 'both',
          depth: routeTarget.depth === 2 ? 2 : 1,
        },
        requestedSelection(routeTarget),
        visit,
      );
      if (!nextAddress) {
        setAddressLimit(true);
        focusIntentRef.current = null;
        return;
      }
    }
    setAddressLimit(false);
    focusIntentRef.current =
      kind === 'selection' || kind === 'expansion'
        ? requestedSelection(routeTarget)
          ? { kind: 'selection', key: selectedKey(requestedSelection(routeTarget)) }
          : { kind: 'relation' }
        : { kind: 'relation' };
    runRecord(makeRecord(routeTarget, kind, extra), shouldNavigate, !onNavigate);
    if (shouldNavigate) void onNavigate?.(routeTarget);
  }

  function select(next: GraphSelection) {
    if (!read) return;
    const target: GraphRoute = {
      property: read.query.property.join(','),
      direction: read.query.direction,
      depth: read.query.depth,
      ...(next.kind === 'node'
        ? { node: next.id }
        : { edge: next.statement, from: next.from, to: next.to, edgeProperty: next.property }),
    };
    request(target, 'selection');
  }

  function retry() {
    if (!active?.record) return;
    focusIntentRef.current = active.record.selection
      ? { kind: 'selection', key: selectedKey(active.record.selection) }
      : { kind: 'relation' };
    runRecord(active.record, false, !onNavigate);
  }

  useEffect(() => {
    if (!active) return;
    if (active.status === 'pending' && focusIntentRef.current) statusRef.current?.focus();
    if (active.status === 'failure') {
      failureRef.current?.focus();
      focusIntentRef.current = null;
    }
    if (active.status === 'success' && focusIntentRef.current) {
      const intent = focusIntentRef.current;
      if (intent.kind === 'selection') {
        const target = [...(pageRef.current?.querySelectorAll<HTMLButtonElement>('[data-graph-selection]') ?? [])].find(
          (button) => button.dataset.graphSelection === intent.key,
        );
        (target ?? detailHeadingRef.current ?? relationRef.current)?.focus();
      } else relationRef.current?.focus();
      focusIntentRef.current = null;
    }
  }, [active?.requestId, active?.status, source]);

  return (
    <article
      ref={pageRef}
      className="mx-auto w-full min-w-0 max-w-5xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={status === 'pending'}
    >
      <ViewHeading label={m.graph_explore_title({}, o)} headingClassName="font-sans" />
      <p role="status" className="max-w-prose text-sm text-muted-foreground">
        {m.graph_public_scope({}, o)}
      </p>
      {addressLimit && (
        <p role="status" className="max-w-prose text-sm text-muted-foreground">
          {m.graph_public_address_limit({}, o)}
        </p>
      )}
      <p className="max-w-prose text-muted-foreground">{m.graph_explore_intro({}, o)}</p>
      {status === 'pending' && (
        <p ref={statusRef} role="status" tabIndex={-1}>
          {m.graph_explore_loading({}, o)}
        </p>
      )}
      {error && (
        <div>
          <p ref={failureRef} role="alert" tabIndex={-1}>
            {failed}
          </p>
          <Button type="button" className={actionClass} onClick={retry}>
            {m.graph_explore_retry({}, o)}
          </Button>
        </div>
      )}
      {read && (
        <div className="space-y-6">
          <form
            key={active?.readRevision ?? 0}
            className="flex min-w-0 flex-wrap gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              request(
                {
                  property: String(form.get('property') ?? ''),
                  direction: String(form.get('direction') ?? 'both'),
                  depth: Number(form.get('depth') ?? 1),
                },
                'filter',
              );
            }}
          >
            <Field className="min-w-40 flex-1">
              <FieldLabel htmlFor={relationId}>{m.graph_explore_relation({}, o)}</FieldLabel>
              <NativeSelect
                ref={relationRef}
                id={relationId}
                name="property"
                defaultValue={read.query.property[0] ?? ''}
              >
                {read.relations.map((relation) => (
                  <NativeSelectOption key={relation.id} value={relation.id}>
                    {relation.label.text}
                    {relation.inverse?.text ? ` / ${relation.inverse.text}` : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field className="min-w-32">
              <FieldLabel htmlFor={directionId}>{m.graph_explore_direction({}, o)}</FieldLabel>
              <NativeSelect id={directionId} name="direction" defaultValue={read.query.direction}>
                <NativeSelectOption value="both">{m.graph_explore_both({}, o)}</NativeSelectOption>
                <NativeSelectOption value="out">{m.graph_explore_out({}, o)}</NativeSelectOption>
                <NativeSelectOption value="in">{m.graph_explore_in({}, o)}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field className="min-w-32">
              <FieldLabel htmlFor={depthId}>{m.graph_explore_depth({}, o)}</FieldLabel>
              <NativeSelect id={depthId} name="depth" defaultValue={String(read.query.depth)}>
                <NativeSelectOption value="1">{m.graph_explore_depth1({}, o)}</NativeSelectOption>
                <NativeSelectOption value="2">{m.graph_explore_depth2({}, o)}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Button type="submit" className={actionClass}>
              {m.graph_explore_apply({}, o)}
            </Button>
          </form>
          {!read.relations.length && <p>{m.graph_explore_no_relation({}, o)}</p>}
          {read.graph.nodes.length === 0 && <p>{m.graph_explore_empty({}, o)}</p>}
          {read.graph.truncated.length > 0 && (
            <p role="status">{m.graph_explore_incomplete({ limit: String(GRAPH_LIMIT) }, o)}</p>
          )}
          <div className="grid gap-6 lg:grid-cols-2">
            <GraphList
              nodes={read.graph.nodes}
              edges={read.graph.edges}
              selected={selected}
              selectionConfirmed={selectionConfirmed}
              onSelect={select}
              locale={locale}
            />
            <GraphDiagram
              nodes={read.graph.nodes}
              edges={read.graph.edges}
              selected={selected}
              selectionConfirmed={selectionConfirmed}
              onSelect={select}
              locale={locale}
            />
          </div>
          {read.graph.truncated.map((entry) => (
            <Button
              key={`${entry.node}:${entry.property}:${entry.direction}`}
              type="button"
              variant="outline"
              className={actionClass}
              onClick={() => {
                const selection = requestedSelection(activeRoute);
                request(
                  {
                    property: read.query.property.join(','),
                    direction: read.query.direction,
                    depth: read.query.depth,
                    ...(selection?.kind === 'node'
                      ? { node: selection.id }
                      : selection?.kind === 'edge'
                        ? {
                            edge: selection.statement,
                            from: selection.from,
                            to: selection.to,
                            edgeProperty: selection.property,
                          }
                        : {}),
                  },
                  'expansion',
                  { expansion: entry },
                  false,
                );
              }}
            >
              {m.graph_explore_continue({}, o)}
            </Button>
          ))}
          {read.detail && (
            <section className="space-y-3" aria-live="polite">
              <h2 ref={detailHeadingRef} tabIndex={-1} className="font-sans text-xl font-semibold">
                {m.graph_explore_inspect({}, o)}
              </h2>
              <p>{pickText(read.detail.subject.subject.labels, locale).text || m.subject_value_unlabelled({}, o)}</p>
              {read.detail.statement && (
                <p>
                  {read.detail.labels[read.detail.statement.property.id]?.text ?? read.detail.statement.property.id}
                </p>
              )}
              <div className="flex min-w-0 flex-wrap gap-2">
                <a
                  className={linkClass}
                  href={
                    subjectHref(
                      {
                        id: read.detail.subject.subject.id,
                        label: pickText(read.detail.subject.subject.labels, locale).text,
                      },
                      locale,
                    ).href
                  }
                >
                  {m.graph_explore_open_subject({}, o)}
                </a>
                {quotations &&
                  ('href' in quotations ? (
                    <a className={linkClass} href={quotations.href}>
                      {m.graph_explore_quotations({}, o)}
                    </a>
                  ) : (
                    <div className="space-y-2">
                      <p role="status" className="text-sm text-muted-foreground">
                        {quotations.unsupported === 'origin'
                          ? m.quotation_entry_origin_unsupported({}, o)
                          : m.quotation_entry_address_unsupported({}, o)}
                      </p>
                      {quotations.generalHref && (
                        <a className={linkClass} href={quotations.generalHref}>
                          {m.quotation_entry_general({}, o)}
                        </a>
                      )}
                    </div>
                  ))}
                <a
                  className={linkClass}
                  href={appendReturnTo(
                    catalogueEntries.concepts({
                      id: read.detail.subject.subject.id,
                      label: pickText(read.detail.subject.subject.labels, locale).text,
                      locale,
                    }).href,
                    returnTo,
                  )}
                >
                  {m.graph_explore_concepts({}, o)}
                </a>
                <a
                  className={linkClass}
                  href={appendReturnTo(
                    catalogueEntries.musicContext({
                      id: read.detail.subject.subject.id,
                      label: pickText(read.detail.subject.subject.labels, locale).text,
                      locale,
                    }).href,
                    returnTo,
                  )}
                >
                  {m.graph_explore_music({}, o)}
                </a>
                <a
                  className={linkClass}
                  href={appendReturnTo(
                    catalogueEntries.facts({
                      id: read.detail.subject.subject.id,
                      label: pickText(read.detail.subject.subject.labels, locale).text,
                      locale,
                    }).href,
                    returnTo,
                  )}
                >
                  {m.graph_explore_correct({}, o)}
                </a>
              </div>
            </section>
          )}
          {!publicReturnHref && (
            <a className={linkClass} href={origin.href}>
              {m.graph_explore_return({}, o)}
            </a>
          )}
        </div>
      )}
      {publicReturnHref && (
        <a className={linkClass} href={publicReturnHref}>
          {m.graph_public_return({}, o)}
        </a>
      )}
    </article>
  );
}
