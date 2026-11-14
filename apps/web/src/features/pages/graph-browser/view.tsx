import * as SharedSelect from '@rezics/ui/shadcn/select';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/load-subject';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import { CandidateValue } from '../scalar-value';
import { ViewHeading } from '../view-heading';
import { graphPublicIntentFits, graphPublicVisitSearch, type GraphPublicVisit } from './public-visit';
import {
  GRAPH_LIMIT,
  type GraphBrowserTransport,
  type GraphEdge,
  type GraphBrowserRouteState,
  type GraphNode,
  type GraphRead,
  type GraphRelation,
  type GraphSelection,
  type GraphTruncation,
} from './index';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const selectClass =
  'h-auto data-[size=default]:h-auto data-[size=sm]:h-auto min-h-11 w-full min-w-0 max-w-full whitespace-normal *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:whitespace-normal [overflow-wrap:anywhere]';
const selectItemClass =
  'min-h-11 min-w-0 whitespace-normal [&_[data-slot=select-item-text]]:whitespace-normal [&>span]:min-w-0 [&>span]:shrink [&>span]:whitespace-normal [overflow-wrap:anywhere]';

export type { GraphBrowserTransport } from './index';

function option(locale: string) {
  return { locale: locale as never };
}

function selectedKey(selection: GraphSelection | undefined) {
  if (!selection) return '';
  return selection.kind === 'node' ? `node:${selection.id}` : `edge:${selection.statement}`;
}

type ProjectedNode = GraphNode & { position: number };
type ProjectedEdge = {
  edge: GraphEdge;
  position: number;
  from: ProjectedNode | undefined;
  to: ProjectedNode | undefined;
  relation: GraphRelation | undefined;
};
type GraphProjection = {
  nodes: ProjectedNode[];
  nodeById: Map<string, ProjectedNode>;
  relationById: Map<string, GraphRelation>;
  edges: ProjectedEdge[];
  edgeByStatement: Map<string, ProjectedEdge>;
};

/** One current response supplies every label and endpoint; projection never hydrates a node. */
export function projectGraph(read: Extract<GraphRead, { ok: true }>): GraphProjection {
  const nodes = read.graph.nodes.map((node, position) => ({ ...node, position }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relationById = new Map(read.relations.map((relation) => [relation.id, relation]));
  const edges = read.graph.edges.map((edge, position) => ({
    edge,
    position,
    from: nodeById.get(edge.from),
    to: nodeById.get(edge.to),
    relation: relationById.get(edge.property),
  }));
  return {
    nodes,
    nodeById,
    relationById,
    edges,
    edgeByStatement: new Map(edges.map((row) => [row.edge.statement, row])),
  };
}

function nodeLabel(node: GraphNode | undefined, locale: string) {
  return node?.label || m.subject_value_unlabelled({}, option(locale));
}

function relationLabel(relation: GraphRelation | undefined, locale: string) {
  return relation?.label.text || m.graph_explore_relation_unavailable({}, option(locale));
}

type ExplorationProps = {
  projection: GraphProjection;
  selected: string;
  selectionConfirmed: boolean;
  onSelect: (selection: GraphSelection) => void;
  locale: string;
};

function NodeControl({
  node,
  id,
  selected,
  selectionConfirmed,
  onSelect,
  locale,
  onKeyDown,
}: Omit<ExplorationProps, 'projection'> & {
  node: GraphNode | undefined;
  id: string;
  onKeyDown?: ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined;
}) {
  const key = `node:${id}`;
  const confirmed = selectionConfirmed && selected === key;
  return (
    <Button
      type="button"
      variant={confirmed ? 'default' : 'outline'}
      className={`${actionClass} w-full justify-start`}
      data-graph-selection={key}
      aria-pressed={confirmed}
      onClick={() => onSelect({ kind: 'node', id })}
      onKeyDown={onKeyDown}
    >
      <span className="min-w-0" dir="auto">
        {nodeLabel(node, locale)}
      </span>
    </Button>
  );
}

function EdgeControl({
  row,
  selected,
  selectionConfirmed,
  onSelect,
  locale,
}: Omit<ExplorationProps, 'projection'> & {
  row: ProjectedEdge;
}) {
  const key = `edge:${row.edge.statement}`;
  const confirmed = selectionConfirmed && selected === key;
  return (
    <Button
      type="button"
      variant={confirmed ? 'default' : 'outline'}
      className={`${actionClass} w-full justify-start gap-2`}
      data-graph-selection={key}
      aria-pressed={confirmed}
      onClick={() => onSelect({ kind: 'edge', ...row.edge })}
    >
      <span className="shrink-0 font-mono text-xs" aria-hidden="true">
        {row.position + 1}
      </span>
      <span className="min-w-0" lang={row.relation?.label.lang ?? undefined} dir="auto">
        <span className="sr-only">
          {m.graph_explore_statement_number({ number: String(row.position + 1) }, option(locale))}:{' '}
        </span>
        {relationLabel(row.relation, locale)}
      </span>
    </Button>
  );
}

function GraphList(props: ExplorationProps) {
  const { projection, selected, selectionConfirmed, locale } = props;
  const o = option(locale);
  return (
    <div className="min-w-0 space-y-5">
      <section aria-label={m.graph_explore_nodes({}, o)} className="space-y-2">
        <h3 className="text-sm font-medium">{m.graph_explore_nodes({}, o)}</h3>
        <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
          {projection.nodes.map((node) => (
            <li key={node.id} className="min-w-0">
              <NodeControl {...props} node={node} id={node.id} />
            </li>
          ))}
        </ul>
      </section>
      <table className="w-full min-w-0 table-fixed border-collapse text-sm">
        <caption className="pb-2 text-start font-medium">{m.graph_explore_list({}, o)}</caption>
        <thead>
          <tr>
            <th scope="col" className="border-b p-2 text-start">
              {m.graph_explore_from({}, o)}
            </th>
            <th scope="col" className="border-b p-2 text-start">
              {m.graph_explore_relation({}, o)}
            </th>
            <th scope="col" className="border-b p-2 text-start">
              {m.graph_explore_to({}, o)}
            </th>
          </tr>
        </thead>
        <tbody>
          {projection.edges.map((row) => (
            <tr
              key={row.edge.statement}
              className={selectionConfirmed && selected === `edge:${row.edge.statement}` ? 'bg-muted' : undefined}
            >
              <td className="border-b px-1 py-2 align-top">
                <NodeControl {...props} node={row.from} id={row.edge.from} />
              </td>
              <td className="border-b px-1 py-2 align-top">
                <EdgeControl {...props} row={row} />
              </td>
              <td className="border-b px-1 py-2 align-top">
                <NodeControl {...props} node={row.to} id={row.edge.to} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type DiagramPath = { statement: string; from: string; to: string };

/** HTML owns all box sizes. SVG draws only connections between measured controls. */
function GraphDiagram(props: ExplorationProps & { visible: boolean }) {
  const { projection, selected, selectionConfirmed, onSelect, locale, visible } = props;
  const o = option(locale);
  const marker = useId().replace(/:/g, '');
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const edgeRefs = useRef(new Map<string, HTMLDivElement>());
  const [paths, setPaths] = useState<DiagramPath[]>([]);
  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current!;
    function measure() {
      const origin = canvas.getBoundingClientRect();
      const nodes = new Map([...nodeRefs.current].map(([id, element]) => [id, element.getBoundingClientRect()]));
      const edges = new Map(
        [...edgeRefs.current].map(([id, element]) => [id, element.querySelector('button')!.getBoundingClientRect()]),
      );
      setPaths(
        projection.edges.flatMap(({ edge }) => {
          const from = nodes.get(edge.from);
          const to = nodes.get(edge.to);
          const control = edges.get(edge.statement);
          // Concealed or omitted endpoints have no invented connection geometry.
          if (!from || !to || !control) return [];
          const x1 = from.right - origin.left;
          const y1 = from.top + from.height / 2 - origin.top;
          const x2 = to.right - origin.left;
          const y2 = to.top + to.height / 2 - origin.top;
          const x = control.left - origin.left;
          const y = control.top + control.height / 2 - origin.top;
          const middle = (x1 + x) / 2;
          return [
            {
              statement: edge.statement,
              from: `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y - 5}, ${x} ${y - 5}`,
              to: `M ${x} ${y + 5} C ${middle} ${y + 5}, ${middle} ${y2}, ${x2} ${y2}`,
            },
          ];
        }),
      );
    }
    measure();
    const observer = new canvas.ownerDocument.defaultView!.ResizeObserver(measure);
    observer.observe(canvas);
    for (const element of nodeRefs.current.values()) observer.observe(element);
    for (const element of edgeRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [projection, visible]);

  function move(event: KeyboardEvent<HTMLButtonElement>, node: ProjectedNode) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next = projection.nodes[(node.position + offset + projection.nodes.length) % projection.nodes.length]!;
    nodeRefs.current.get(next.id)?.querySelector('button')?.focus();
    onSelect({ kind: 'node', id: next.id });
  }
  return (
    <section aria-label={m.graph_explore_diagram({}, o)} className="min-w-0 space-y-3">
      <p className="text-sm text-muted-foreground">{m.graph_explore_diagram_help({}, o)}</p>
      <div
        ref={canvasRef}
        className="relative grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-10"
      >
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
          <defs>
            <marker
              id={marker}
              markerWidth="6"
              markerHeight="6"
              refX="6"
              refY="3"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 6 3 L 0 6 Z" fill="currentColor" />
            </marker>
          </defs>
          {paths.map((path) => (
            <g
              key={path.statement}
              className={
                selectionConfirmed && selected === `edge:${path.statement}` ? 'text-primary' : 'text-muted-foreground'
              }
            >
              <path
                d={path.from}
                fill="none"
                stroke="currentColor"
                strokeWidth={selectionConfirmed && selected === `edge:${path.statement}` ? 2.5 : 1}
              />
              <path
                d={path.to}
                fill="none"
                stroke="currentColor"
                strokeWidth={selectionConfirmed && selected === `edge:${path.statement}` ? 2.5 : 1}
                markerEnd={`url(#${marker})`}
              />
            </g>
          ))}
        </svg>
        <div className="relative min-w-0 space-y-4">
          <h3 className="text-sm font-medium">{m.graph_explore_nodes({}, o)}</h3>
          {projection.nodes.map((node) => (
            <div
              key={node.id}
              ref={(element) => {
                if (element) nodeRefs.current.set(node.id, element);
                else nodeRefs.current.delete(node.id);
              }}
              className="min-w-0 bg-background"
            >
              <NodeControl {...props} node={node} id={node.id} onKeyDown={(event) => move(event, node)} />
            </div>
          ))}
        </div>
        <div className="relative min-w-0 space-y-4">
          <h3 className="text-sm font-medium">{m.graph_explore_statements({}, o)}</h3>
          {projection.edges.map((row) => (
            <div
              key={row.edge.statement}
              ref={(element) => {
                if (element) edgeRefs.current.set(row.edge.statement, element);
                else edgeRefs.current.delete(row.edge.statement);
              }}
              className="min-w-0 space-y-1 bg-background"
            >
              <EdgeControl {...props} row={row} />
              <p className="text-xs text-muted-foreground">
                <span>{nodeLabel(row.from, locale)}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> {m.graph_explore_to({}, o)} </span>
                <span>{nodeLabel(row.to, locale)}</span>
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
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

function GraphMeaning({
  read,
  projection,
  selection,
  locale,
}: {
  read: GraphSuccess;
  projection: GraphProjection;
  selection: GraphSelection | undefined;
  locale: string;
}) {
  const o = option(locale);
  const detail = read.detail!;
  const subject = detail.subject.subject;
  const label = pickText(subject.labels, locale);
  const description = pickText(subject.descriptions ?? {}, locale);
  const statement = detail.statement;
  const row = selection?.kind === 'edge' ? projection.edgeByStatement.get(selection.statement) : undefined;
  const relation = statement ? projection.relationById.get(statement.property.id) : undefined;
  const propertyLabel = (property: string) =>
    projection.relationById.get(property)?.label.text ||
    detail.labels[property]?.text ||
    m.graph_explore_relation_unavailable({}, o);
  function part(snak: NonNullable<typeof statement>['qualifiers'][number], index: number) {
    return (
      <div key={index} className="min-w-0 space-y-1">
        <dt className="text-sm text-muted-foreground">{propertyLabel(snak.property.id)}</dt>
        <dd className="min-w-0">
          <CandidateValue snak={snak} related={detail.subject.related} locale={locale} subject={subject.id} />
        </dd>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-4" data-graph-detail={selection ? selectedKey(selection) : undefined}>
      <h3 className="font-sans text-lg font-semibold" lang={label.lang ?? undefined}>
        {label.text || m.subject_value_unlabelled({}, o)}
      </h3>
      {description.text && (
        <p lang={description.lang ?? undefined} className="text-sm">
          {description.text}
        </p>
      )}
      {statement && (
        <div className="min-w-0 space-y-4">
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-muted-foreground">{m.graph_explore_from({}, o)}</dt>
              <dd>{nodeLabel(row?.from, locale)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{m.graph_explore_relation({}, o)}</dt>
              <dd className="font-medium">{propertyLabel(statement.property.id)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{m.graph_explore_to({}, o)}</dt>
              <dd>{nodeLabel(row?.to, locale)}</dd>
            </div>
            {relation?.inverse?.text && (
              <div>
                <dt className="text-sm text-muted-foreground">{m.graph_explore_inverse({}, o)}</dt>
                <dd lang={relation.inverse.lang ?? undefined}>{relation.inverse.text}</dd>
              </div>
            )}
            <div>
              <dt className="text-sm text-muted-foreground">{m.candidate_rank({}, o)}</dt>
              <dd>
                {statement.rank === 'preferred'
                  ? m.candidate_rank_preferred({}, o)
                  : statement.rank === 'normal'
                    ? m.candidate_rank_normal({}, o)
                    : m.changes_rank_deprecated({}, o)}
              </dd>
            </div>
          </dl>
          {statement.qualifiers.length > 0 && (
            <section className="space-y-2" aria-label={m.value_qualifiers({}, o)}>
              <h4 className="font-medium">{m.value_qualifiers({}, o)}</h4>
              <dl className="space-y-3">{statement.qualifiers.map(part)}</dl>
            </section>
          )}
          <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
            <h4 className="font-medium">{m.sources_citations({}, o)}</h4>
            {statement.references.length ? (
              <ol className="list-decimal space-y-3 ps-5">
                {statement.references.map((reference, index) => (
                  <li key={index} className="min-w-0">
                    {reference.parts.length ? (
                      <dl className="space-y-2">{reference.parts.map(part)}</dl>
                    ) : (
                      m.value_reference_unavailable({}, o)
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">{m.catalogue_file_reader_no_references({}, o)}</p>
            )}
            <p className="text-sm text-muted-foreground">{m.value_citation_scope({}, o)}</p>
          </section>
        </div>
      )}
      <details className="min-w-0 border-t pt-2">
        <summary className={`${linkClass} cursor-pointer`}>{m.catalogue_technical_details({}, o)}</summary>
        <dl className="mt-2 space-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">{m.specialist_identity_subject_id({}, o)}</dt>
            <dd>
              <code>{subject.id}</code>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.specialist_identity_type({}, o)}</dt>
            <dd>
              <code>{subject.type}</code>
            </dd>
          </div>
          {selection?.kind === 'edge' && statement && (
            <>
              <div>
                <dt className="text-muted-foreground">{m.catalogue_statement_id({}, o)}</dt>
                <dd>
                  <code>{statement.id}</code>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.graph_explore_relation({}, o)}</dt>
                <dd>
                  <code>{statement.property.id}</code>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.graph_explore_from({}, o)}</dt>
                <dd>
                  <code>{selection.from}</code>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.graph_explore_to({}, o)}</dt>
                <dd>
                  <code>{selection.to}</code>
                </dd>
              </div>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

function GraphBranches({
  branches,
  projection,
  unavailable,
  onContinue,
  locale,
}: {
  branches: GraphTruncation[];
  projection: GraphProjection;
  unavailable: boolean;
  onContinue: (branch: GraphTruncation) => void;
  locale: string;
}) {
  const o = option(locale);
  return (
    <section className="min-w-0 space-y-3" aria-label={m.graph_explore_expansions({}, o)}>
      <h2 className="font-sans text-lg font-semibold">{m.graph_explore_expansions({}, o)}</h2>
      <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
        {branches.map((branch) => (
          <li
            key={`${branch.node}:${branch.property}:${branch.direction}`}
            className="min-w-0 space-y-2 rounded-lg border p-3"
          >
            <p className="text-sm">
              {nodeLabel(projection.nodeById.get(branch.node), locale)} ·{' '}
              {relationLabel(projection.relationById.get(branch.property), locale)} ·{' '}
              {branch.direction === 'in' ? m.graph_explore_in({}, o) : m.graph_explore_out({}, o)}
            </p>
            <details>
              <summary className={`${linkClass} cursor-pointer text-sm`}>
                {m.catalogue_technical_details({}, o)}
              </summary>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt>{m.specialist_identity_subject_id({}, o)}</dt>
                  <dd>
                    <code>{branch.node}</code>
                  </dd>
                </div>
                <div>
                  <dt>{m.graph_explore_relation({}, o)}</dt>
                  <dd>
                    <code>{branch.property}</code>
                  </dd>
                </div>
              </dl>
            </details>
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              disabled={unavailable}
              onClick={() => onContinue(branch)}
            >
              {m.graph_explore_continue({}, o)}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GraphLinks({
  detail,
  projection,
  selection,
  locale,
  returnTo,
  quotations,
}: {
  detail: NonNullable<GraphSuccess['detail']>;
  projection: GraphProjection;
  selection: GraphSelection | undefined;
  locale: string;
  returnTo: string | undefined;
  quotations: ReturnType<typeof catalogueEntries.quotations> | null;
}) {
  const o = option(locale);
  const address = {
    id: detail.subject.subject.id,
    label: pickText(detail.subject.subject.labels, locale).text,
    locale,
  };
  const readers = [
    { label: m.graph_explore_concepts({}, o), href: catalogueEntries.concepts(address).href },
    { label: m.graph_explore_music({}, o), href: catalogueEntries.musicContext(address).href },
  ];
  return (
    <nav aria-label={m.graph_explore_inspect({}, o)} className="flex min-w-0 flex-col items-start gap-2 border-t pt-3">
      <a className={linkClass} href={appendReturnTo(subjectHref(address, locale).href, returnTo)}>
        {m.graph_explore_open_subject({}, o)}
      </a>
      {selection?.kind === 'edge' && (
        <a
          className={linkClass}
          href={appendReturnTo(
            subjectHref(
              {
                id: selection.to,
                label: nodeLabel(projection.nodeById.get(selection.to), locale),
              },
              locale,
            ).href,
            returnTo,
          )}
        >
          {m.graph_explore_to({}, o)}: {nodeLabel(projection.nodeById.get(selection.to), locale)}
        </a>
      )}
      {quotations &&
        ('href' in quotations ? (
          <a className={linkClass} href={quotations.href}>
            {m.graph_explore_quotations({}, o)}
          </a>
        ) : (
          <div className="min-w-0 space-y-2">
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
      {readers.map((entry) => (
        <a key={entry.href} className={linkClass} href={appendReturnTo(entry.href, returnTo)}>
          {entry.label}
        </a>
      ))}
      <a
        className={linkClass}
        href={appendReturnTo(
          catalogueEntries.facts(address).href,
          returnTo,
          detail.statement ? { property: detail.statement.property.id, statement: detail.statement.id } : undefined,
        )}
      >
        {m.graph_explore_correct({}, o)}
      </a>
    </nav>
  );
}

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

function routeForSelection(query: GraphSuccess['query'], selection?: GraphSelection): GraphRoute {
  return {
    property: query.property.join(','),
    direction: query.direction,
    depth: query.depth,
    ...(selection?.kind === 'node'
      ? { node: selection.id }
      : selection?.kind === 'edge'
        ? { edge: selection.statement, from: selection.from, to: selection.to, edgeProperty: selection.property }
        : {}),
  };
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

function appendReturnTo(
  href: string,
  returnTo: string | undefined,
  selection?: { property: string; statement: string },
) {
  const query = new URLSearchParams({ ...(returnTo ? { returnTo } : {}), ...selection });
  if (!query.size) return href;
  return `${href}${href.includes('?') ? '&' : '?'}${query}`;
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
  const workspaceId = useId();
  const inspectorId = useId();
  const [viewMode, setViewMode] = useState<'list' | 'diagram'>('list');
  const failureRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const relationRef = useRef<HTMLButtonElement>(null);
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
  const read = useMemo(
    () => (baseRead && !keepDetail ? { ...baseRead, detail: null } : baseRead),
    [baseRead, keepDetail],
  );
  const projection = useMemo(() => (read ? projectGraph(read) : undefined), [read]);
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
    request(routeForSelection(read.query, next), 'selection');
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
          (button) => button.dataset.graphSelection === intent.key && !button.closest('[hidden]'),
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
        <div className="space-y-3 rounded-lg border p-4">
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
            className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
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
            <Field className="min-w-0">
              <FieldLabel htmlFor={relationId}>{m.graph_explore_relation({}, o)}</FieldLabel>
              <SharedSelect.Select
                name="property"
                defaultValue={read.query.property[0] ?? read.relations[0]?.id ?? null}
                items={read.relations.map((relation) => ({
                  value: relation.id,
                  label: `${relationLabel(relation, locale)}${relation.inverse?.text ? ` / ${relation.inverse.text}` : ''}`,
                }))}
              >
                <SharedSelect.SelectTrigger id={relationId} ref={relationRef} className={selectClass}>
                  <SharedSelect.SelectValue />
                </SharedSelect.SelectTrigger>
                <SharedSelect.SelectContent>
                  <SharedSelect.SelectGroup>
                    {read.relations.map((relation) => (
                      <SharedSelect.SelectItem className={selectItemClass} key={relation.id} value={relation.id}>
                        {relationLabel(relation, locale)}
                        {relation.inverse?.text ? ` / ${relation.inverse.text}` : ''}
                      </SharedSelect.SelectItem>
                    ))}
                  </SharedSelect.SelectGroup>
                </SharedSelect.SelectContent>
              </SharedSelect.Select>
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor={directionId}>{m.graph_explore_direction({}, o)}</FieldLabel>
              <SharedSelect.Select
                name="direction"
                defaultValue={read.query.direction}
                items={[
                  { value: 'both', label: m.graph_explore_both({}, o) },
                  { value: 'out', label: m.graph_explore_out({}, o) },
                  { value: 'in', label: m.graph_explore_in({}, o) },
                ]}
              >
                <SharedSelect.SelectTrigger id={directionId} className={selectClass}>
                  <SharedSelect.SelectValue />
                </SharedSelect.SelectTrigger>
                <SharedSelect.SelectContent>
                  <SharedSelect.SelectGroup>
                    <SharedSelect.SelectItem className={selectItemClass} value="both">
                      {m.graph_explore_both({}, o)}
                    </SharedSelect.SelectItem>
                    <SharedSelect.SelectItem className={selectItemClass} value="out">
                      {m.graph_explore_out({}, o)}
                    </SharedSelect.SelectItem>
                    <SharedSelect.SelectItem className={selectItemClass} value="in">
                      {m.graph_explore_in({}, o)}
                    </SharedSelect.SelectItem>
                  </SharedSelect.SelectGroup>
                </SharedSelect.SelectContent>
              </SharedSelect.Select>
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor={depthId}>{m.graph_explore_depth({}, o)}</FieldLabel>
              <SharedSelect.Select
                name="depth"
                defaultValue={String(read.query.depth)}
                items={[
                  { value: '1', label: m.graph_explore_depth1({}, o) },
                  { value: '2', label: m.graph_explore_depth2({}, o) },
                ]}
              >
                <SharedSelect.SelectTrigger id={depthId} className={selectClass}>
                  <SharedSelect.SelectValue />
                </SharedSelect.SelectTrigger>
                <SharedSelect.SelectContent>
                  <SharedSelect.SelectGroup>
                    <SharedSelect.SelectItem className={selectItemClass} value="1">
                      {m.graph_explore_depth1({}, o)}
                    </SharedSelect.SelectItem>
                    <SharedSelect.SelectItem className={selectItemClass} value="2">
                      {m.graph_explore_depth2({}, o)}
                    </SharedSelect.SelectItem>
                  </SharedSelect.SelectGroup>
                </SharedSelect.SelectContent>
              </SharedSelect.Select>
            </Field>
            <Button type="submit" className={actionClass}>
              {m.graph_explore_apply({}, o)}
            </Button>
          </form>
          {!read.relations.length && <p>{m.graph_explore_no_relation({}, o)}</p>}
          {read.graph.edges.length === 0 && (
            <p role="status">
              {read.graph.truncated.length ? m.graph_explore_sparse({}, o) : m.graph_explore_empty({}, o)}
            </p>
          )}
          {read.graph.truncated.length > 0 && (
            <p role="status">{m.graph_explore_incomplete({ limit: String(GRAPH_LIMIT) }, o)}</p>
          )}
          <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label={m.graph_explore_view({}, o)}>
            <Button
              type="button"
              variant={viewMode === 'list' ? 'default' : 'outline'}
              className={actionClass}
              aria-pressed={viewMode === 'list'}
              aria-controls={workspaceId}
              onClick={() => setViewMode('list')}
            >
              {m.graph_explore_list({}, o)}
            </Button>
            <Button
              type="button"
              variant={viewMode === 'diagram' ? 'default' : 'outline'}
              className={actionClass}
              aria-pressed={viewMode === 'diagram'}
              aria-controls={workspaceId}
              onClick={() => setViewMode('diagram')}
            >
              {m.graph_explore_diagram({}, o)}
            </Button>
          </div>
          <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,3fr)]">
            <div id={workspaceId} className="min-w-0 space-y-4 rounded-lg border p-3 sm:p-4">
              <Button
                type="button"
                variant="link"
                className={actionClass}
                aria-controls={inspectorId}
                onClick={() => detailHeadingRef.current?.focus()}
              >
                {m.graph_explore_inspect({}, o)}
              </Button>
              <div hidden={viewMode !== 'list'}>
                <GraphList
                  projection={projection!}
                  selected={selected}
                  selectionConfirmed={selectionConfirmed}
                  onSelect={select}
                  locale={locale}
                />
              </div>
              <div hidden={viewMode !== 'diagram'}>
                <GraphDiagram
                  projection={projection!}
                  selected={selected}
                  selectionConfirmed={selectionConfirmed}
                  onSelect={select}
                  locale={locale}
                  visible={viewMode === 'diagram'}
                />
              </div>
            </div>
            <section
              className="min-w-0 self-start space-y-4 rounded-lg border bg-muted/20 p-4 lg:sticky lg:top-4"
              aria-labelledby={inspectorId}
              aria-live="polite"
            >
              <h2 id={inspectorId} ref={detailHeadingRef} tabIndex={-1} className="font-sans text-xl font-semibold">
                {m.graph_explore_inspect({}, o)}
              </h2>
              {read.detail ? (
                <>
                  <GraphMeaning read={read} projection={projection!} selection={selection} locale={locale} />
                  <GraphLinks
                    detail={read.detail}
                    projection={projection!}
                    selection={selection}
                    locale={locale}
                    returnTo={returnTo}
                    quotations={quotations}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {status === 'pending'
                    ? m.graph_explore_loading({}, o)
                    : selection
                      ? m.graph_explore_unconfirmed({}, o)
                      : m.graph_explore_select({}, o)}
                </p>
              )}
            </section>
          </div>
          {read.graph.truncated.length > 0 && (
            <GraphBranches
              branches={read.graph.truncated}
              projection={projection!}
              locale={locale}
              unavailable={status === 'pending' || status === 'failure'}
              onContinue={(entry) =>
                request(routeForSelection(read.query, selection), 'expansion', { expansion: entry }, false)
              }
            />
          )}
        </div>
      )}
      {!publicReturnHref && (
        <a className={linkClass} href={origin.href}>
          {m.graph_explore_return({}, o)}
        </a>
      )}
      {publicReturnHref && (
        <a className={linkClass} href={publicReturnHref}>
          {m.graph_public_return({}, o)}
        </a>
      )}
    </article>
  );
}
