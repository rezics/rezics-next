import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { PatternStory } from '../../stories/page';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { PageData } from './data';
import { TypeList } from './type-list';
import { TypeListPage } from './type-list-page';
import { subjectPageMessages } from './route-support';

const document: CompositionDocument = {
  root: { props: {} },
  content: [
    {
      type: 'TypeList',
      props: {
        id: 'selected-books',
        types: ['schema:Book'],
        sort: 'name',
        limit: 24,
        title: {
          de: 'Lange Bücher',
          en: 'Long books',
          es: 'Libros largos',
          fr: 'Livres longs',
          ja: '長い本',
          ko: '긴 책',
          'zh-Hans': '长篇书籍',
          'zh-Hant': '長篇書籍',
        },
        filter: { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } },
      },
    },
  ],
};
const target = { route: '/selected-books' };
const node = 'selected-books';
const first = {
  id: '018f0000-0000-7000-8000-00a000000001',
  type: 'schema:Book',
  labels: { en: 'The Long Journey' },
  summary: null,
};
const last = { ...first, id: '018f0000-0000-7000-8000-00a000000002', labels: { en: 'Winter Chronicle' } };

function State({ state }: { state: 'preview' | 'continued' | 'unavailable' }) {
  const continuation = state === 'continued' ? { node, cursor: 'native-page-two' } : undefined;
  const plan = planReads(platformRegistry, document, { subject: null, ...(continuation ? { continuation } : {}) });
  const page = {
    subject: null,
    profile: 'sha256:story',
    template: { scope: 'route' as const, key: target.route },
    document,
    reads: {
      [plan.nodes[node]!]:
        state === 'unavailable'
          ? { status: 503, body: { code: 'index_not_ready' } }
          : {
              status: 200,
              body: {
                subjects: [state === 'continued' ? last : first],
                next: state === 'continued' ? null : 'native-page-two',
                as_of: '2026-10-31T00:00:00.000Z',
              },
            },
    },
    ...(continuation ? { continuation } : {}),
  };
  return (
    <PatternStory>
      <main className="mx-auto max-w-5xl p-6">
        {state === 'preview' ? (
          <PageData {...page} locale={getLocale()} listTarget={target} messages={subjectPageMessages()}>
            <TypeList {...document.content[0]!.props} />
          </PageData>
        ) : (
          <TypeListPage page={page} target={target} node={node} locale={getLocale()} />
        )}
      </main>
    </PatternStory>
  );
}

const meta = { title: 'Pages/Discovery/Type list', component: State } satisfies Meta<typeof State>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FilteredPreview: Story = {
  args: { state: 'preview' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findAllByRole('link', { name: 'The Long Journey' });
    const more = await view.findByRole('link', { name: m.library_more() });
    const url = new URL(more.getAttribute('href')!, 'https://rezics.com');
    await expect(url.pathname.endsWith('/search/list')).toBe(true);
    await expect(JSON.parse(url.searchParams.get('page')!)).toEqual(target);
    await expect(url.searchParams.get('list')).toBe(node);
    await expect(url.searchParams.get('cursor')).toBe('native-page-two');
    await view.findByRole('link', { name: m.home_see_all() });
  },
};

export const ContinuedFullList: Story = {
  args: { state: 'continued' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1 });
    await view.findByRole('link', { name: 'Winter Chronicle' });
    await expect(view.queryByRole('link', { name: m.library_more() })).toBeNull();
  },
};

export const Unavailable: Story = {
  args: { state: 'unavailable' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('alert');
    await view.findByRole('link', { name: m.subject_section_retry() });
    await expect(view.queryByText(m.search_no_results())).toBeNull();
  },
};
