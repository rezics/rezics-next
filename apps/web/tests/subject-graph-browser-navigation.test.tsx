import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, StrictMode, useState, type ComponentProps, type ReactNode } from 'react';
import type { GraphBrowserRouteState, GraphSelection, GraphRead } from '../src/features/pages/graph-browser';
import type { GraphBrowserTransport } from '../src/features/pages/graph-browser';

const anchor = '00000000-0000-4000-8000-00000000a001';
const first = '00000000-0000-4000-8000-00000000a002';
const second = '00000000-0000-4000-8000-00000000a003';
const edgeFirst = '00000000-0000-4000-8000-00000000e001';
const edgeSecond = '00000000-0000-4000-8000-00000000e002';
const edgeBetween = '00000000-0000-4000-8000-00000000e003';
const property = 'wdt:P737';
const otherProperty = 'wdt:P101';

type ReadInput = Parameters<GraphBrowserTransport['read']>[0];
type GraphSuccess = Extract<GraphRead, { ok: true }>;

function subject(id: string, label: string) {
  return {
    subject: { id, type: 'schema:Book', labels: { en: label }, statements: {} },
    labels: { en: label },
  };
}

function reading(query: ReadInput = {}, options: { session?: string; expanded?: boolean } = {}): GraphSuccess {
  const relation =
    typeof query.property === 'string' ? query.property.split(',') : query.property ? [...query.property] : [property];
  const direction = query.direction === 'in' || query.direction === 'out' ? query.direction : 'both';
  const depth = Number(query.depth) === 1 ? 1 : 2;
  const selected: GraphSelection | undefined = query.node
    ? { kind: 'node', id: query.node }
    : query.edge && query.from && query.to && query.edgeProperty
      ? {
          kind: 'edge',
          statement: query.edge,
          from: query.from,
          to: query.to,
          property: query.edgeProperty,
        }
      : undefined;
  const detailId = selected?.kind === 'node' ? selected.id : selected?.kind === 'edge' ? selected.from : undefined;
  const detailLabel = detailId === first ? 'First selected' : detailId === second ? 'Second selected' : 'Anchor edge';
  const edgeProperty = selected?.kind === 'edge' ? selected.property : (relation[0] ?? property);
  const detail = selected
    ? {
        subject: subject(detailId!, detailLabel),
        ...(selected.kind === 'edge'
          ? {
              statement: {
                id: selected.statement,
                property: { id: edgeProperty },
                value: { type: 'value', content: selected.to },
                rank: 'normal',
                qualifiers: [],
                references: [],
              },
            }
          : {}),
        labels: { [edgeProperty]: { text: 'Influenced by', lang: 'en' } },
      }
    : null;
  return {
    ok: true,
    public: subject(anchor, 'Anchor'),
    relations: [
      { id: property, label: { text: 'Influenced by', lang: 'en' }, inverse: null, group: 'related' },
      { id: otherProperty, label: { text: 'Field of work', lang: 'en' }, inverse: null, group: 'related' },
    ],
    query: { property: relation, direction, depth },
    graph: {
      nodes: [
        { id: anchor, type: 'schema:Book', label: 'Anchor', summary: { id: anchor, type: 'schema:Book', label: null } },
        {
          id: first,
          type: 'schema:Book',
          label: 'First neighbour',
          summary: { id: first, type: 'schema:Book', label: null },
        },
        {
          id: second,
          type: 'schema:Book',
          label: 'Second neighbour',
          summary: { id: second, type: 'schema:Book', label: null },
        },
      ],
      edges: [
        { from: anchor, property: relation[0] ?? property, to: first, statement: edgeFirst },
        { from: anchor, property: relation[0] ?? property, to: second, statement: edgeSecond },
        { from: first, property: relation[0] ?? property, to: second, statement: edgeBetween },
      ],
      truncated: options.expanded
        ? []
        : [{ node: first, property: relation[0] ?? property, direction: 'out', cursor: 'native-cursor-private' }],
    },
    detail: detail as never,
    cost: { nativeCalls: 4, valuesProcessed: 8, bytesRetained: 256, paths: [] },
    session: options.session ?? 'seed-session-private',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mounted() {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.invalid/en/subjects/${anchor}/anchor/graph` });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Document',
    'FormData',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, key),
    });
  }
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { GraphBrowserPage, graphBrowserReturnHref } = await import('../src/features/pages/graph-browser/view');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  type PageProps = ComponentProps<typeof GraphBrowserPage>;
  type VisitProps = Omit<
    PageProps,
    'onNavigate' | 'property' | 'direction' | 'depth' | 'node' | 'edge' | 'from' | 'to' | 'edgeProperty'
  > & {
    initialRoute: GraphBrowserRouteState;
  };
  function RoutedVisit({ initialRoute, ...props }: VisitProps) {
    const [route, setRoute] = useState(initialRoute);
    return h(GraphBrowserPage, { ...props, ...route, onNavigate: setRoute });
  }
  async function show(node: ReactNode) {
    await act(async () => root.render(h(StrictMode, null, node)));
  }
  async function click(button: HTMLButtonElement | null) {
    if (!button) throw new Error('Expected a graph button');
    await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  }
  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  async function close() {
    await act(async () => root.unmount());
    for (const key of keys) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
  return { window, host, show, click, flush, close, GraphBrowserPage, graphBrowserReturnHref, RoutedVisit };
}

test('filter, reversed selections and one native truncated expansion keep only the current request', async () => {
  const ui = await mounted();
  const firstRead = deferred<GraphRead>();
  const secondRead = deferred<GraphRead>();
  const expansionRead = deferred<GraphRead>();
  const calls: ReadInput[] = [];
  const signals: AbortSignal[] = [];
  const transport: GraphBrowserTransport = {
    read: (query, signal) => {
      signals.push(signal);
      calls.push({ ...query });
      if (query.expansion) return expansionRead.promise;
      if (query.property === otherProperty && !query.node && !query.edge) return Promise.resolve(reading(query));
      if (query.node === first) return firstRead.promise;
      if (query.node === second) return secondRead.promise;
      return Promise.resolve(reading(query));
    },
  };
  try {
    await ui.show(
      h(ui.RoutedVisit, {
        id: anchor,
        locale: 'en',
        reader: 'reader-one',
        initialRoute: { property, direction: 'both', depth: 2 },
        initial: reading(),
        graphPath: `/en/subjects/${anchor}/anchor/graph`,
        transport,
      }),
    );
    const relation = ui.host.querySelector<HTMLSelectElement>('select[name="property"]')!;
    relation.value = otherProperty;
    await act(async () => {
      relation.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
      ui.host.querySelector('form')!.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await ui.flush();
    expect(calls[0]?.property).toBe(otherProperty);
    expect(ui.host.querySelector<HTMLSelectElement>('select[name="property"]')?.value).toBe(otherProperty);

    await ui.click(ui.host.querySelector<HTMLButtonElement>(`button[data-graph-selection="node:${first}"]`));
    await ui.click(ui.host.querySelector<HTMLButtonElement>(`button[data-graph-selection="node:${second}"]`));
    expect(calls.slice(-2).map((call) => call.node)).toEqual([first, second]);
    expect(signals.at(-2)?.aborted).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(false);
    await act(async () => {
      secondRead.resolve(
        reading(
          { property: otherProperty, direction: 'both', depth: 2, node: second },
          { session: 'new-current-session' },
        ),
      );
      await secondRead.promise;
    });
    expect(ui.host.textContent).toContain('Second selected');
    await act(async () => {
      firstRead.resolve(
        reading({ property: otherProperty, direction: 'both', depth: 2, node: first }, { session: 'late-old-session' }),
      );
      await firstRead.promise;
    });
    expect(ui.host.textContent).toContain('Second selected');
    expect(ui.host.textContent).not.toContain('First selected');

    const continueButton = [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Continue'),
    );
    await ui.click(continueButton ?? null);
    const expansion = calls.at(-1)!;
    expect(expansion.expansion?.cursor).toBe('native-cursor-private');
    expect(expansion.node).toBe(second);
    expect(expansion.session).toBe('new-current-session');
    expect(ui.host.textContent).toContain('Second selected');
    await ui.show(null);
    expect(signals.at(-1)?.aborted).toBe(true);
    await act(async () => expansionRead.resolve(reading(expansion, { expanded: true })));
    expect(ui.host.textContent).toBe('');
  } finally {
    await ui.close();
  }
});

test('a failed selection offers an exact explicit retry', async () => {
  const ui = await mounted();
  const calls: ReadInput[] = [];
  const signals: AbortSignal[] = [];
  const transport: GraphBrowserTransport = {
    read: async (query, signal) => {
      signals.push(signal);
      calls.push({ ...query });
      return query.node === first && calls.filter((call) => call.node === first).length === 1
        ? { ok: false, reason: 'unavailable' }
        : reading(query);
    },
  };
  try {
    await ui.show(
      h(ui.RoutedVisit, {
        id: anchor,
        locale: 'en',
        initialRoute: { property, direction: 'in', depth: 1 },
        initial: reading({ property, direction: 'in', depth: 1 }),
        graphPath: `/en/subjects/${anchor}/anchor/graph`,
        transport,
      }),
    );
    await ui.click(ui.host.querySelector<HTMLButtonElement>(`button[data-graph-selection="node:${first}"]`));
    await ui.flush();
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain('graph');
    expect(ui.host.textContent).not.toContain('First selected');
    const retry = [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Retry this exact read'),
    );
    await ui.click(retry ?? null);
    await ui.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[0]?.aborted).toBe(true);
    expect(ui.host.textContent).toContain('First selected');
  } finally {
    await ui.close();
  }
});

test('companion and correction links return only exact public selection state and reread it', async () => {
  const ui = await mounted();
  const calls: ReadInput[] = [];
  const transport: GraphBrowserTransport = {
    read: async (query) => {
      calls.push({ ...query });
      return reading(query);
    },
  };
  const path = `/en/subjects/${anchor}/anchor/graph`;
  try {
    expect(ui.graphBrowserReturnHref('//outside.invalid/graph', reading().query)).toBeUndefined();
    expect(ui.graphBrowserReturnHref('/\\\\outside.invalid/graph', reading().query)).toBeUndefined();
    await ui.show(
      h(ui.RoutedVisit, {
        key: 'first-visit',
        id: anchor,
        locale: 'en',
        initialRoute: { property, direction: 'out', depth: 2, node: first },
        graphPath: path,
        transport,
      }),
    );
    await ui.flush();
    const quotations = [...ui.host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Quotations'),
    )!;
    const nodeReturn = new URL(quotations.href).searchParams.get('returnTo')!;
    const nodeUrl = new URL(nodeReturn, ui.window.location.origin);
    expect(nodeUrl.pathname).toBe(path);
    expect(nodeUrl.searchParams.get('property')).toBe(property);
    expect(nodeUrl.searchParams.get('direction')).toBe('out');
    expect(nodeUrl.searchParams.get('depth')).toBe('2');
    expect(nodeUrl.searchParams.get('node')).toBe(first);
    expect(nodeReturn).not.toContain('seed-session-private');
    expect(nodeReturn).not.toContain('native-cursor-private');
    expect(nodeReturn).not.toContain('First selected');

    await ui.show(
      h(ui.RoutedVisit, {
        key: 'node-return',
        id: anchor,
        locale: 'en',
        initialRoute: Object.fromEntries(nodeUrl.searchParams) as GraphBrowserRouteState,
        graphPath: nodeUrl.pathname,
        transport,
      }),
    );
    await ui.flush();
    expect(calls.at(-1)?.node).toBe(first);
    expect(ui.host.textContent).toContain('First selected');

    await ui.click(ui.host.querySelector<HTMLButtonElement>(`button[data-graph-selection="edge:${edgeFirst}"]`));
    await ui.flush();
    const correction = [...ui.host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Propose a correction'),
    )!;
    const edgeReturn = new URL(new URL(correction.href).searchParams.get('returnTo')!, ui.window.location.origin);
    expect(edgeReturn.searchParams.get('edge')).toBe(edgeFirst);
    expect(edgeReturn.searchParams.get('from')).toBe(anchor);
    expect(edgeReturn.searchParams.get('to')).toBe(first);
    expect(edgeReturn.searchParams.get('edgeProperty')).toBe(property);
    expect(edgeReturn.searchParams.has('session')).toBe(false);
    expect(edgeReturn.searchParams.has('expansion')).toBe(false);

    await ui.show(
      h(ui.RoutedVisit, {
        key: 'edge-return',
        id: anchor,
        locale: 'en',
        initialRoute: Object.fromEntries(edgeReturn.searchParams) as GraphBrowserRouteState,
        graphPath: edgeReturn.pathname,
        transport,
      }),
    );
    await ui.flush();
    expect(calls.at(-1)).toMatchObject({ edge: edgeFirst, from: anchor, to: first, edgeProperty: property });
    expect(ui.host.textContent).toContain('Anchor edge');
  } finally {
    await ui.close();
  }
});

test('quotation navigation offers a fresh visit when the exact graph return exceeds its address budget', async () => {
  const ui = await mounted();
  const path = `/en/subjects/${anchor}/${'a'.repeat(1800)}/graph`;
  const transport: GraphBrowserTransport = { read: async (query) => reading(query) };
  try {
    expect(ui.graphBrowserReturnHref(path, reading().query, { kind: 'node', id: first })).toBeDefined();
    await ui.show(
      h(ui.RoutedVisit, {
        id: anchor,
        locale: 'en',
        initialRoute: { property, direction: 'out', depth: 2, node: first },
        graphPath: path,
        transport,
      }),
    );
    await ui.flush();
    expect(ui.host.textContent).toContain('The quotation address exceeds the supported size limit.');
    const general = [...ui.host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === 'Visit general quotations',
    )!;
    expect(general).toBeDefined();
    expect(new URL(general.href).pathname).toContain(`/subjects/${first}/`);
    expect(new URL(general.href).searchParams.has('returnTo')).toBe(false);
  } finally {
    await ui.close();
  }
});

const replacementCase = test.each(['success', 'denied'] as const);
replacementCase('source replacement rejects retired %s and tokens', async (lateResult) => {
  const ui = await mounted();
  const late = deferred<GraphRead>();
  const firstCalls: ReadInput[] = [];
  const signals: AbortSignal[] = [];
  const firstTransport: GraphBrowserTransport = {
    read: (query, signal) => {
      firstCalls.push({ ...query });
      signals.push(signal);
      return query.node && firstCalls.length === 1
        ? late.promise
        : Promise.resolve(reading(query, { session: 'fresh-return-session' }));
    },
  };
  const replacementCalls: ReadInput[] = [];
  const replacement: GraphBrowserTransport = {
    read: async (query) => {
      replacementCalls.push({ ...query });
      return reading(query, { session: 'replacement-session' });
    },
  };
  const page = (source: {
    id: string;
    locale: string;
    reader: string;
    transport: GraphBrowserTransport;
    initial?: GraphRead;
  }) =>
    h(ui.GraphBrowserPage, {
      id: source.id,
      locale: source.locale,
      reader: source.reader,
      property,
      direction: 'both',
      depth: 1,
      initial: source.initial,
      graphPath: `/en/subjects/${source.id}/anchor/graph`,
      transport: source.transport,
    });
  try {
    await ui.show(
      page({ id: anchor, locale: 'en', reader: 'reader-one', transport: firstTransport, initial: reading() }),
    );
    await ui.click(ui.host.querySelector<HTMLButtonElement>(`button[data-graph-selection="node:${first}"]`));
    await ui.show(page({ id: second, locale: 'en', reader: 'reader-one', transport: replacement }));
    await ui.flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(replacementCalls).toHaveLength(1);
    expect(replacementCalls[0]?.session).toBeUndefined();
    expect(ui.host.textContent).toContain('Anchor');

    await ui.show(page({ id: second, locale: 'ja', reader: 'reader-one', transport: replacement }));
    await ui.flush();
    await ui.show(page({ id: second, locale: 'ja', reader: 'reader-two', transport: replacement }));
    await ui.flush();
    const thirdTransport: GraphBrowserTransport = {
      read: async (query) => {
        replacementCalls.push({ ...query });
        return reading(query, { session: 'third-session' });
      },
    };
    await ui.show(page({ id: second, locale: 'ja', reader: 'reader-two', transport: thirdTransport }));
    await ui.flush();
    await ui.show(page({ id: anchor, locale: 'en', reader: 'reader-one', transport: firstTransport }));
    await ui.flush();
    expect(firstCalls.at(-1)?.session).toBeUndefined();
    await act(async () => {
      late.resolve(
        lateResult === 'denied'
          ? { ok: false, reason: 'denied', clearPrivate: true }
          : reading({ property, direction: 'both', depth: 1, node: first }, { session: 'late-session' }),
      );
      await late.promise;
    });
    expect(ui.host.textContent).not.toContain('First selected');
    await ui.click(ui.host.querySelector<HTMLButtonElement>(`button[data-graph-selection="node:${first}"]`));
    await ui.flush();
    expect(replacementCalls.length).toBeGreaterThanOrEqual(4);
    expect(firstCalls.at(-1)?.session).toBe('fresh-return-session');
    expect(ui.host.textContent).toContain('First selected');
    await ui.show(null);
    expect(signals.at(-1)?.aborted).toBe(true);
  } finally {
    await ui.close();
  }
});

test('current relation labels, missing meanings and long node labels share manually selected views without another read', async () => {
  const ui = await mounted();
  const calls: ReadInput[] = [];
  const initial = reading();
  const longLabel = '旅の記憶と北の島々から届いた手紙 — Erinnerte Reisen und Briefe — رحلات وذكريات '.repeat(5);
  initial.graph.nodes[1]!.label = longLabel;
  initial.relations[0]!.label.text = 'Influence through correspondence / 書簡を通じた影響';
  initial.graph.edges[1]!.property = 'urn:relation:current-name-unavailable';
  initial.graph.nodes = initial.graph.nodes.filter((node) => node.id !== second);
  try {
    await ui.show(h(ui.GraphBrowserPage, {
      id: anchor, locale: 'en', initial,
      transport: { read: async (query) => { calls.push(query); return reading(query); } },
    }));
    const table = ui.host.querySelector('table')!;
    expect(table.textContent).toContain(initial.relations[0]!.label.text);
    expect(table.textContent).toContain('Relation name unavailable');
    expect(table.textContent).not.toContain('urn:relation:current-name-unavailable');
    expect(table.textContent).not.toContain(property);
    expect(table.textContent).toContain(longLabel);
    const diagramSwitch = [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Graph diagram',
    )!;
    await ui.click(diagramSwitch);
    expect(diagramSwitch.getAttribute('aria-pressed')).toBe('true');
    expect(table.closest('[hidden]')).toBeTruthy();
    const diagram = ui.host.querySelector<HTMLElement>('section[aria-label="Graph diagram"]')!;
    expect(diagram.closest('[hidden]')).toBeNull();
    expect(diagram.textContent).toContain(initial.relations[0]!.label.text);
    expect(diagram.textContent).toContain(longLabel);
    expect(diagram.querySelectorAll('[data-graph-selection]')).toHaveLength(initial.graph.nodes.length + initial.graph.edges.length);
    expect(diagram.querySelector('foreignObject')).toBeNull();
    expect(calls).toHaveLength(0);
    const anchorControl = diagram.querySelector<HTMLButtonElement>(`[data-graph-selection="node:${anchor}"]`)!;
    await act(async () => anchorControl.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await ui.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.node).toBe(first);
    expect(ui.window.document.activeElement?.getAttribute('data-graph-selection')).toBe(`node:${first}`);
    expect(ui.window.document.activeElement?.closest('[hidden]')).toBeNull();
  } finally {
    await ui.close();
  }
});

test('the adjacent inspector distinguishes exact statements and exposes supplied qualifiers, citations and independent links', async () => {
  const ui = await mounted();
  const route = { property, direction: 'out', depth: 2, edge: edgeFirst, from: anchor, to: first, edgeProperty: property };
  const path = `/en/subjects/${anchor}/anchor/graph`;
  const withEvidence = (query: ReadInput) => {
    const result = reading(query);
    result.detail!.statement!.qualifiers = [{
      property: { id: 'schema:description', data_type: 'string' },
      value: { type: 'value', content: 'A supplied statement-specific qualifier' },
    }];
    result.detail!.statement!.references = [{ parts: [{
      property: { id: 'schema:url', data_type: 'url' },
      value: { type: 'value', content: 'https://example.org/current-citation' },
    }] }];
    result.detail!.labels['schema:description'] = { text: 'Influence context', lang: 'en' };
    result.detail!.labels['schema:url'] = { text: 'Citation URL', lang: 'en' };
    return result;
  };
  try {
    await ui.show(h(ui.RoutedVisit, {
      id: anchor, locale: 'en', initialRoute: route, graphPath: path,
      initial: withEvidence(route), transport: { read: async (query) => withEvidence(query) },
    }));
    const detail = ui.host.querySelector<HTMLElement>(`[data-graph-detail="edge:${edgeFirst}"]`)!;
    const inspector = detail.closest('section[aria-labelledby]')!;
    expect(inspector.previousElementSibling?.querySelector('table')).toBeTruthy();
    expect(detail.textContent).toContain('Influenced by');
    expect(detail.textContent).toContain('A supplied statement-specific qualifier');
    expect(detail.textContent).toContain(edgeFirst);
    expect(detail.querySelector('a[href="https://example.org/current-citation"]')).toBeTruthy();
    const correction = [...inspector.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.textContent?.includes('Propose a correction'))!;
    expect(correction.closest('button')).toBeNull();
    const address = new URL(correction.href);
    expect(address.searchParams.get('property')).toBe(property);
    expect(address.searchParams.get('statement')).toBe(edgeFirst);
    const returned = new URL(address.searchParams.get('returnTo')!, ui.window.location.origin);
    expect(Object.fromEntries(returned.searchParams)).toEqual({ property, direction: 'out', depth: '2', edge: edgeFirst, from: anchor, to: first, edgeProperty: property });
    await ui.click(ui.host.querySelector<HTMLButtonElement>(`button[data-graph-selection="edge:${edgeBetween}"]`));
    await ui.flush();
    const next = ui.host.querySelector<HTMLElement>(`[data-graph-detail="edge:${edgeBetween}"]`)!;
    expect(next.textContent).toContain(edgeBetween);
    expect(next.textContent).not.toContain(edgeFirst);
    expect(ui.host.querySelector(`button[data-graph-selection="edge:${edgeBetween}"]`)?.getAttribute('aria-pressed')).toBe('true');
  } finally {
    await ui.close();
  }
});

test('a sparse native branch stays explicit and retries its exact cursor before replacing the current graph', async () => {
  const ui = await mounted();
  const initial = reading();
  initial.graph.nodes = [initial.graph.nodes[0]!];
  initial.graph.edges = [];
  const calls: ReadInput[] = [];
  const expanded = reading({}, { expanded: true });
  expanded.graph.nodes = [expanded.graph.nodes[2]!];
  expanded.graph.edges = [];
  const transport: GraphBrowserTransport = {
    read: async (query) => {
      calls.push(query);
      return calls.length === 1 ? { ok: false, reason: 'unavailable' } : expanded;
    },
  };
  try {
    await ui.show(h(ui.GraphBrowserPage, { id: anchor, locale: 'en', initial, transport }));
    expect(ui.host.textContent).toContain('The branches below still have native pages to explore.');
    const continuation = [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Continue this branch'))!;
    await ui.click(continuation);
    await ui.flush();
    expect(ui.host.querySelector('[role="alert"]')).toBeTruthy();
    expect(continuation.disabled).toBe(true);
    const retry = [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Retry this exact read'))!;
    await ui.click(retry);
    await ui.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]!.expansion).toEqual(initial.graph.truncated[0]);
    expect(ui.host.textContent).toContain('Second neighbour');
    expect(ui.host.querySelector('[data-graph-selection="node:' + anchor + '"]')).toBeNull();
    expect(ui.host.textContent).not.toContain('native-cursor-private');
    expect([...ui.host.querySelectorAll('button')].some((button) => button.textContent?.includes('Continue this branch'))).toBe(false);
  } finally {
    await ui.close();
  }
});
