import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import { ViewHeading } from '../view-heading';
import {
  GRAPH_LIMIT,
  type GraphEdge,
  type GraphNode,
  type GraphRead,
  type GraphSelection,
  type GraphTruncation,
} from './index';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type GraphBrowserTransport = {
  read: (query: {
    property?: string | readonly string[] | undefined;
    direction?: string | undefined;
    depth?: number | undefined;
    node?: string | undefined;
    edge?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    edgeProperty?: string | undefined;
    expansion?: GraphTruncation | undefined;
    session?: string | undefined;
  }) => Promise<GraphRead>;
};

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
  onSelect,
  locale,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string;
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
                  aria-pressed={selected === `node:${edge.from}`}
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
                  aria-pressed={selected === key}
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
                  aria-pressed={selected === `node:${edge.to}`}
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
  onSelect,
  locale,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string;
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
                aria-pressed={selected === key}
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
              aria-pressed={selected === key}
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

export function GraphBrowserPage({
  id,
  locale,
  property,
  direction,
  depth,
  node,
  edge,
  transport,
  initial,
}: {
  id: string;
  locale: string;
  property?: string | undefined;
  direction?: string | undefined;
  depth?: number | undefined;
  node?: string | undefined;
  edge?: string | undefined;
  transport: GraphBrowserTransport;
  initial?: GraphRead | undefined;
  reader?: string | undefined;
}) {
  const o = option(locale);
  const relationId = useId();
  const directionId = useId();
  const depthId = useId();
  const failureRef = useRef<HTMLParagraphElement>(null);
  const [session, setSession] = useState<string>();
  const [page, setPage] = useState<Extract<GraphRead, { ok: true }>>();
  const query = useQuery({
    queryKey: ['graph-explore', id, locale, property, direction, depth, node, edge],
    queryFn: () => transport.read({ property, direction, depth, node, edge, session }),
    initialData: initial,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const read = page ?? (query.data?.ok ? query.data : undefined);
  const error =
    !read && query.data && !query.data.ok
      ? query.data
      : !read && query.isError
        ? { ok: false as const, reason: 'unavailable' as const }
        : undefined;
  useEffect(() => {
    if (read?.session) setSession(read.session);
  }, [read?.session]);
  useEffect(() => {
    if (error) failureRef.current?.focus();
  }, [error]);
  const selection = read?.detail
    ? read.detail.statement
      ? {
          kind: 'edge' as const,
          statement: read.detail.statement.id,
          from: read.detail.subject.subject.id,
          to: '',
          property: read.detail.statement.property.id,
        }
      : { kind: 'node' as const, id: read.detail.subject.subject.id }
    : node
      ? { kind: 'node' as const, id: node }
      : undefined;
  const selected = selectedKey(selection);
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const origin = subjectHref({ id, label: title.text }, locale);
  const graphHref = catalogueEntries.graph({ id, label: title.text, locale }).href;
  async function load(next: Parameters<GraphBrowserTransport['read']>[0]) {
    const value = await transport.read({ ...next, session });
    if (!value.ok) return;
    setPage(value);
    if (value.session) setSession(value.session);
  }
  function select(next: GraphSelection) {
    void load(
      next.kind === 'node'
        ? { property: read?.query.property, direction: read?.query.direction, depth: read?.query.depth, node: next.id }
        : {
            property: read?.query.property,
            direction: read?.query.direction,
            depth: read?.query.depth,
            edge: next.statement,
            from: next.from,
            to: next.to,
            edgeProperty: next.property,
          },
    );
  }
  const failed =
    error?.reason === 'denied'
      ? m.graph_explore_denied({}, o)
      : error?.reason === 'invalid' || error?.reason === 'stale'
        ? m.graph_explore_stale({}, o)
        : m.graph_explore_unavailable({}, o);
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-5xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={query.isPending}
    >
      <ViewHeading label={m.graph_explore_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.graph_explore_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.graph_explore_loading({}, o)}</p>}
      {error && (
        <p ref={failureRef} role="alert" tabIndex={-1}>
          {failed}
        </p>
      )}
      {read && (
        <div className="space-y-6">
          <form
            className="flex min-w-0 flex-wrap gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void load({
                property: String(form.get('property') ?? ''),
                direction: String(form.get('direction') ?? 'both'),
                depth: Number(form.get('depth') ?? 1),
              });
            }}
          >
            <Field className="min-w-40 flex-1">
              <FieldLabel htmlFor={relationId}>{m.graph_explore_relation({}, o)}</FieldLabel>
              <NativeSelect id={relationId} name="property" defaultValue={read.query.property[0] ?? ''}>
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
              onSelect={select}
              locale={locale}
            />
            <GraphDiagram
              nodes={read.graph.nodes}
              edges={read.graph.edges}
              selected={selected}
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
              onClick={() =>
                void load({
                  property: read.query.property,
                  direction: read.query.direction,
                  depth: read.query.depth,
                  expansion: entry,
                })
              }
            >
              {m.graph_explore_continue({}, o)}
            </Button>
          ))}
          {read.detail && (
            <section className="space-y-3" aria-live="polite">
              <h2 className="font-sans text-xl font-semibold">{m.graph_explore_inspect({}, o)}</h2>
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
                <a
                  className={linkClass}
                  href={`${catalogueEntries.quotations({ id: read.detail.subject.subject.id, label: pickText(read.detail.subject.subject.labels, locale).text, locale }).href}?${new URLSearchParams({ returnTo: graphHref })}`}
                >
                  {m.graph_explore_quotations({}, o)}
                </a>
                <a
                  className={linkClass}
                  href={`${catalogueEntries.concepts({ id: read.detail.subject.subject.id, label: pickText(read.detail.subject.subject.labels, locale).text, locale }).href}?${new URLSearchParams({ returnTo: graphHref })}`}
                >
                  {m.graph_explore_concepts({}, o)}
                </a>
                <a
                  className={linkClass}
                  href={`${catalogueEntries.musicContext({ id: read.detail.subject.subject.id, label: pickText(read.detail.subject.subject.labels, locale).text, locale }).href}?${new URLSearchParams({ returnTo: graphHref })}`}
                >
                  {m.graph_explore_music({}, o)}
                </a>
                <a
                  className={linkClass}
                  href={`${catalogueEntries.facts({ id: read.detail.subject.subject.id, label: pickText(read.detail.subject.subject.labels, locale).text, locale }).href}?${new URLSearchParams({ returnTo: graphHref })}`}
                >
                  {m.graph_explore_correct({}, o)}
                </a>
              </div>
            </section>
          )}
          <a className={linkClass} href={origin.href}>
            {m.graph_explore_return({}, o)}
          </a>
        </div>
      )}
    </article>
  );
}
