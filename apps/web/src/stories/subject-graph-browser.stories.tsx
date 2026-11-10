import { useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { SubjectRead } from '@rezics/client';
import type { GraphBrowserRouteState } from '../features/pages/graph-browser';
import { GraphBrowserPage, type GraphBrowserTransport } from '../features/pages/graph-browser/view';
import type { GraphRead } from '../features/pages/graph-browser';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const anchor = '00000000-0000-4000-8000-00000000a001';
const neighbour = '00000000-0000-4000-8000-00000000a002';
const second = '00000000-0000-4000-8000-00000000a003';
const statement = '00000000-0000-4000-8000-00000000e001';

type StoryState = 'pending' | 'failure' | 'returned';
type StoryQuery = Parameters<GraphBrowserTransport['read']>[0];

function subject(id: string, label: string): SubjectRead {
  return {
    subject: {
      id,
      type: 'schema:Book',
      revision: 1,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: label },
      descriptions: {},
      aliases: {},
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {},
    summary: null,
  };
}

function reading(query: StoryQuery = {}): Extract<GraphRead, { ok: true }> {
  const detailId = query.node ?? (query.edge ? neighbour : undefined);
  const detail = detailId
    ? {
        subject: subject(detailId, detailId === neighbour ? 'Neighbour' : 'Second neighbour'),
        ...(query.edge
          ? {
              statement: {
                id: statement,
                property: { id: 'wdt:P737' },
                value: { type: 'value', content: second },
                rank: 'normal',
                qualifiers: [],
                references: [],
              },
            }
          : {}),
        labels: {},
      }
    : null;
  return {
    ok: true,
    public: subject(anchor, 'Anchor'),
    relations: [
      { id: 'wdt:P737', label: { text: 'Influenced by', lang: 'en' }, inverse: null, group: 'related' },
      { id: 'wdt:P101', label: { text: 'Field of work', lang: 'en' }, inverse: null, group: 'related' },
    ],
    query: {
      property: typeof query.property === 'string' ? query.property.split(',') : ['wdt:P737'],
      direction: query.direction === 'in' || query.direction === 'out' ? query.direction : 'both',
      depth: query.depth === 1 ? 1 : 2,
    },
    graph: {
      nodes: [
        { id: anchor, type: 'schema:Book', label: 'Anchor', summary: { id: anchor, type: 'schema:Book', label: null } },
        {
          id: neighbour,
          type: 'schema:Book',
          label: 'Neighbour',
          summary: { id: neighbour, type: 'schema:Book', label: null },
        },
        {
          id: second,
          type: 'schema:Book',
          label: 'Second neighbour',
          summary: { id: second, type: 'schema:Book', label: null },
        },
      ],
      edges: [
        { from: anchor, property: 'wdt:P737', to: neighbour, statement },
        { from: neighbour, property: 'wdt:P737', to: second, statement: '00000000-0000-4000-8000-00000000e002' },
      ],
      truncated: [{ node: neighbour, property: 'wdt:P737', direction: 'out', cursor: 'native-page-cursor' }],
    },
    detail: detail as never,
    cost: { nativeCalls: 4, valuesProcessed: 8, bytesRetained: 256, paths: [] },
    session: 'opaque-session-token',
  };
}

function GraphBrowserStory({ state }: { state: StoryState }) {
  const locale = getLocale();
  const failures = useRef(0);
  const initialRoute: GraphBrowserRouteState =
    state === 'returned'
      ? { property: 'wdt:P737', direction: 'both', depth: 2, node: neighbour }
      : { property: 'wdt:P737', direction: 'both', depth: 2 };
  const [route, setRoute] = useState(initialRoute);
  const transport = useMemo<GraphBrowserTransport>(
    () => ({
      read: async (query) => {
        if (state === 'pending' && query.node) return new Promise<GraphRead>(() => {});
        if (state === 'failure' && query.node && failures.current++ === 0) return { ok: false, reason: 'unavailable' };
        return reading(query);
      },
    }),
    [state],
  );
  const initial = state === 'returned' ? undefined : reading();
  return (
    <PatternStory path={`/subjects/${anchor}/anchor/graph`}>
      <AppShell>
        <GraphBrowserPage
          id={anchor}
          locale={locale}
          {...route}
          graphPath={`/en/subjects/${anchor}/anchor/graph`}
          transport={transport}
          initial={initial}
          onNavigate={setRoute}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Graph Browser',
  id: 'pages-subjects-graph-browser',
  component: GraphBrowserStory,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
    docs: {
      description: {
        component:
          'Mounted GraphBrowserPage states for an in-flight selection, exact retry after a refused read, and a route-returned selection. Response fixtures establish caller rendering only.',
      },
    },
  },
  args: { state: 'pending' },
  globals: { locale: 'en' },
} satisfies Meta<typeof GraphBrowserStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PendingSelection: Story = {
  args: { state: 'pending' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: 'Neighbour' })[0]!);
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.graph_explore_loading());
  },
};

export const FailureRecovery: Story = {
  args: { state: 'failure' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: 'Neighbour' })[0]!);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.graph_explore_unavailable());
    await expect(canvas.getByRole('button', { name: m.graph_explore_retry() })).toBeVisible();
  },
};

export const ReturnedSelection: Story = {
  args: { state: 'returned' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.graph_explore_inspect() })).toBeVisible();
    await expect(canvas.getByText('Neighbour')).toBeVisible();
  },
};
