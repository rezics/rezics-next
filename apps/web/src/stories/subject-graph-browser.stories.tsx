import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { SubjectRead } from '@rezics/client';
import type { GraphBrowserRouteState, GraphRead } from '../features/pages/graph-browser';
import { GraphBrowserPage, type GraphBrowserTransport } from '../features/pages/graph-browser/view';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const anchor = '00000000-0000-4000-8000-00000000a001';
const neighbour = '00000000-0000-4000-8000-00000000a002';
const second = '00000000-0000-4000-8000-00000000a003';
const statement = '00000000-0000-4000-8000-00000000e001';
const secondStatement = '00000000-0000-4000-8000-00000000e002';
const property = 'wdt:P737';

type StoryState = 'relations' | 'long' | 'edge' | 'sparse' | 'pending' | 'failure' | 'returned';
type StoryQuery = Parameters<GraphBrowserTransport['read']>[0];
type GraphSuccess = Extract<GraphRead, { ok: true }>;

const longLabels = {
  en: 'The atlas of remembered journeys, revised and expanded with correspondence from the northern islands',
  de: 'Der Atlas der erinnerten Reisen mit überarbeiteten Aufzeichnungen und Briefen von den nördlichen Inseln',
  es: 'El atlas de los viajes recordados, revisado y ampliado con correspondencia de las islas del norte',
  fr: 'L’atlas des voyages remémorés, révisé et augmenté de la correspondance des îles du Nord',
  ja: '北の島々から届いた手紙と旅の記憶を集めた地図帳・増補改訂版「海を越えて受け継がれる物語」',
  ko: '북쪽 섬에서 도착한 편지와 여행의 기억을 모은 지도책 증보 개정판: 바다를 건너 이어지는 이야기',
  'zh-Hans': '记忆中的旅程地图集：收录北方群岛来信与跨越海洋的故事之增订修订版',
  'zh-Hant': '記憶中的旅程地圖集：收錄北方群島來信與跨越海洋的故事之增訂修訂版',
};

function subject(id: string, label: string): SubjectRead {
  return {
    subject: {
      id,
      type: 'schema:Book',
      revision: 1,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: label },
      descriptions: { en: 'An illustrative catalogue work used to explore directed influences.' },
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

/** Illustrative contract-shaped responses; these are not recorded native evidence. */
function reading(query: StoryQuery = {}, state: StoryState = 'relations', locale = 'en'): GraphSuccess {
  const long = state === 'long';
  const labelOf = (id: string) =>
    id === anchor ? 'Anchor' : id === neighbour ? (long ? longLabels[locale as keyof typeof longLabels] : 'Neighbour') : 'Second neighbour';
  const selectedEdge = query.edge
    ? { from: query.from!, property: query.edgeProperty!, to: query.to!, statement: query.edge }
    : undefined;
  const detailId = query.node ?? selectedEdge?.from;
  const detailStatement: NonNullable<GraphSuccess['detail']>['statement'] = selectedEdge ? {
    id: selectedEdge.statement,
    property: { id: selectedEdge.property, data_type: 'wikibase-item' },
    value: { type: 'value' as const, content: selectedEdge.to },
    rank: 'normal' as const,
    qualifiers: [{
      property: { id: 'schema:description', data_type: 'string' },
      value: { type: 'value' as const, content: 'Influence through correspondence, rather than a direct adaptation.' },
    }],
    references: [{ parts: [{
      property: { id: 'schema:url', data_type: 'url' },
      value: { type: 'value' as const, content: 'https://example.org/illustrative-correspondence' },
    }] }],
  } : undefined;
  const detailSubject = detailId ? subject(detailId, labelOf(detailId)) : undefined;
  if (detailSubject && detailStatement) detailSubject.subject.statements[property] = [detailStatement];
  const sparse = state === 'sparse' && !query.expansion;
  return {
    ok: true,
    public: subject(anchor, 'Anchor'),
    relations: [
      {
        id: property,
        label: { text: long ? 'Influenced by / 着想と表現に影響を与えた作品・人物との関係 / durch Briefwechsel beeinflusst' : 'Influenced by', lang: 'en' },
        inverse: { text: 'Influenced', lang: 'en' },
        group: 'related',
      },
      { id: 'wdt:P101', label: { text: 'Field of work', lang: 'en' }, inverse: null, group: 'related' },
    ],
    query: {
      property: typeof query.property === 'string' ? query.property.split(',') : [property],
      direction: query.direction === 'in' || query.direction === 'out' ? query.direction : 'both',
      depth: query.depth === 1 ? 1 : 2,
    },
    graph: {
      nodes: (sparse ? [anchor] : [anchor, neighbour, second]).map((id) => ({
        id, type: 'schema:Book', label: labelOf(id), summary: { id, type: 'schema:Book', label: null },
      })),
      edges: sparse ? [] : [
        { from: anchor, property, to: neighbour, statement },
        { from: neighbour, property, to: second, statement: secondStatement },
        { from: second, property, to: anchor, statement: '00000000-0000-4000-8000-00000000e003' },
      ],
      truncated: query.expansion ? [] : [{ node: anchor, property, direction: 'out', cursor: 'illustrative-native-page-cursor' }],
    },
    detail: detailSubject ? {
      subject: detailSubject,
      ...(detailStatement ? { statement: detailStatement } : {}),
      labels: {
        [property]: { text: 'Influenced by', lang: 'en' },
        'schema:description': { text: 'Relationship context', lang: 'en' },
        'schema:url': { text: 'Source', lang: 'en' },
      },
    } : null,
    cost: { nativeCalls: 4, valuesProcessed: 8, bytesRetained: 256, paths: [] },
    session: 'illustrative-session-token',
  };
}

function initialRouteFor(state: StoryState): GraphBrowserRouteState {
  const filter = { property, direction: 'both', depth: 2 };
  if (state === 'edge') return { ...filter, edge: statement, from: anchor, to: neighbour, edgeProperty: property };
  if (state === 'returned' || state === 'pending' || state === 'failure') return { ...filter, node: neighbour };
  return filter;
}

function GraphBrowserStory({ state }: { state: StoryState }) {
  const locale = getLocale();
  return <GraphBrowserFixture key={`${state}:${locale}`} state={state} locale={locale} />;
}

function GraphBrowserFixture({ state, locale }: { state: StoryState; locale: string }) {
  const [route, setRoute] = useState(() => initialRouteFor(state));
  const transport = useMemo<GraphBrowserTransport>(() => ({
    read: async (query) => {
      if (state === 'pending') return new Promise<GraphRead>(() => {});
      return reading(query, state, locale);
    },
  }), [state, locale]);
  const initial = useMemo(() => {
    if (state === 'pending' || state === 'returned') return undefined;
    if (state === 'failure') return { ok: false as const, reason: 'unavailable' as const };
    return reading(initialRouteFor(state), state, locale);
  }, [state, locale]);
  const path = `/subjects/${anchor}/anchor/graph`;
  return (
    <PatternStory path={path}>
      <AppShell>
        <p className="mx-auto mb-4 max-w-5xl text-sm text-muted-foreground">
          Illustrative contract-shaped fixtures. Choose list or diagram and viewport manually. Links use the native route shapes; these identities are illustrative.
        </p>
        <GraphBrowserPage
          id={anchor}
          locale={locale}
          {...route}
          graphPath={`/${locale}${path}`}
          publicReturnHref={`/${locale}/subjects/${anchor}/anchor#subject-heading`}
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
        component: 'Illustrative contract-shaped fixtures rendered by the default GraphBrowserPage. Opening performs no scripted interaction. Manually choose a viewport, locale, list or diagram, exact statement, continuation or retry. Source assertions and fixtures establish caller rendering only; native and visual acceptance remain separate.',
      },
    },
  },
  args: { state: 'relations' },
  globals: { locale: 'en' },
} satisfies Meta<typeof GraphBrowserStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MeaningfulRelations: Story = { args: { state: 'relations' } };
export const LongMultilingualLabels: Story = { args: { state: 'long' } };

export const ExactEdgeInspection: Story = {
  args: { state: 'edge' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.graph_explore_inspect() })).toBeVisible();
    await expect(canvas.getByText('Influence through correspondence, rather than a direct adaptation.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.graph_explore_correct() })).toBeVisible();
  },
};

export const SparseExpansion: Story = { args: { state: 'sparse' } };

export const PendingSelection: Story = {
  args: { state: 'pending' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.graph_explore_loading())).toBeVisible();
  },
};

export const FailureRecovery: Story = {
  args: { state: 'failure' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.graph_explore_unavailable());
    await expect(canvas.getByRole('button', { name: m.graph_explore_retry() })).toBeVisible();
  },
};

export const ReturnedSelection: Story = {
  args: { state: 'returned' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.graph_explore_inspect() })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Neighbour' })).toBeVisible();
  },
};
