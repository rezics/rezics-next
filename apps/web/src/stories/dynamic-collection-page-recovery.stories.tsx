import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DynamicCollectionPage } from '../library/dynamic-collection-page';
import type { DynamicCollectionPage as Page } from '../library/dynamic-collection';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Library/Dynamic Collection recovery',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'UNRUN illustrative outcomes using the actual Dynamic Collection page and shared members/filter feedback. No native, authorization, retry, browser or visual acceptance is claimed. Review the same states with phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const id = 'dynamic /%二?&';
const cursor = ' requested/+==?f.=old&cursor=other#二% ';
const next = ' native-next/+==?f.=next&cursor=other#三% ';
const filter: NonNullable<Page['filter']> = { statement: { property: 'schema:keywords', in: ['concept-b'] } };
const search = {
  type: ['schema:Book', 'schema:Book'],
  'f.schema:keywords': ['concept-b', 'concept-a', 'concept-b'],
  'r.schema:wordCount': ['0,0010', ' 2,3 '],
  'l.schema:keywords': ['  Original + & ? / 二  ', 'Repeated', 'Repeated'],
};
function page(change: Partial<Page> = {}): Page {
  return {
    id,
    title: m.library_dynamic_everything(),
    builtinKind: 'everything',
    description: null,
    curator: null,
    members: [],
    next: null,
    preparing: false,
    unavailable: false,
    retryAfterMs: 1000,
    ...change,
  };
}
const member = (id: string, label: string): Page['members'][number] => ({
  subject: { id, label, type: 'schema:Book', types: ['schema:Book'], cover: null },
});
function render(change: Partial<Page> = {}, acceptedSearch?: Record<string, string | string[]>) {
  return (
    <PatternStory path={`/collections/${encodeURIComponent(id)}`}>
      <main className="mx-auto w-full min-w-0 max-w-4xl p-4">
        <DynamicCollectionPage page={page(change)} {...(acceptedSearch ? { search: acceptedSearch } : {})} />
      </main>
    </PatternStory>
  );
}
function noGlobalEmpty(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  for (const label of [
    m.library_dynamic_empty_everything(),
    m.library_dynamic_empty_liked(),
    m.library_collection_empty(),
    m.collection_filter_no_match(),
  ])
    expect(view.queryByText(label, { exact: true })).toBeNull();
}
function localEmpty(hasNext: boolean) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const view = within(canvasElement);
    expect(await view.findByText(m.library_dynamic_page_reader_empty())).toBeVisible();
    noGlobalEmpty(canvasElement);
    const nav = view.getByRole('navigation', { name: m.library_collection_members() });
    expect(within(nav).getByRole('link', { name: m.library_dynamic_page_reader_first_page() })).toBeVisible();
    expect(within(nav).queryAllByRole('link')).toHaveLength(hasNext ? 2 : 1);
  };
}

export const FirstEverythingEmpty: Story = {
  name: 'Everything, first page empty',
  render: () => render(),
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByText(m.library_dynamic_empty_everything())).toBeVisible();
    expect(within(canvasElement).queryByRole('navigation', { name: m.library_collection_members() })).toBeNull();
  },
};
export const FirstLikedEmpty: Story = {
  name: 'Liked, first page empty',
  render: () => render({ builtinKind: 'liked', title: m.library_dynamic_liked() }),
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByText(m.library_dynamic_empty_liked())).toBeVisible();
  },
};
export const FirstStateEmpty: Story = {
  name: 'State, first page empty',
  render: () => render({ builtinKind: 'state', title: m.library_other() }),
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByText(m.library_collection_empty())).toBeVisible();
  },
};
export const FirstFilteredEmpty: Story = {
  name: 'Filtered set, first page empty',
  render: () => render({ filter, filterType: 'schema:Book' }, search),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    expect(await view.findByText(m.collection_filter_no_match())).toBeVisible();
    expect(view.getByRole('link', { name: m.collection_filter_clear() })).toBeVisible();
    expect(view.queryByText(m.library_dynamic_empty_everything())).toBeNull();
  },
};
export const LaterEmpty: Story = {
  name: 'Later page empty, first page recovery',
  render: () => render({ cursor }),
  play: localEmpty(false),
};
export const LaterFilteredEmptyWithNext: Story = {
  name: 'Later filtered page empty, continuation available',
  render: () => render({ cursor, next, filter }, search),
  play: localEmpty(true),
};
export const SparseFirstPage: Story = {
  name: 'First filtered page empty, continuation available',
  render: () => render({ next, filter }, search),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    expect(await view.findByText(m.library_dynamic_page_reader_empty())).toBeVisible();
    noGlobalEmpty(canvasElement);
    const nav = within(view.getByRole('navigation', { name: m.library_collection_members() }));
    expect(nav.getAllByRole('link')).toHaveLength(1);
    expect(nav.getByRole('link', { name: m.library_collection_more() })).toBeVisible();
  },
};
export const LaterMembers: Story = {
  name: 'Later members, first page recovery',
  render: () =>
    render({
      cursor,
      next,
      members: [member('second', 'Second'), { subject: null }, member('first', 'First'), member('second', 'Second')],
    }),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    expect(await view.findAllByRole('link', { name: 'Second' })).toHaveLength(2);
    expect(view.getByText(m.library_subject_unavailable())).toBeVisible();
    expect(view.getByRole('link', { name: m.library_dynamic_page_reader_first_page() })).toBeVisible();
    expect(view.queryByText(m.library_dynamic_page_reader_empty())).toBeNull();
  },
};
export const RepeatedFiltersAndKeyboardRecovery: Story = {
  name: 'Repeated filters, named keyboard recovery',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () =>
    render({ cursor, next, filter, title: Array(12).fill(m.library_dynamic_everything()).join(' · ') }, search),
  play: async (context) => {
    await localEmpty(true)(context);
    const view = within(context.canvasElement);
    const nav = view.getByRole('navigation', { name: m.library_collection_members() });
    const first = within(nav).getByRole('link', { name: m.library_dynamic_page_reader_first_page() });
    const more = within(nav).getByRole('link', { name: m.library_collection_more() });
    const expected = Object.entries(search).flatMap(([key, values]) => values.map((value) => [key, value]));
    for (const anchor of [first, more]) {
      const url = new URL(anchor.getAttribute('href')!, window.location.origin);
      expect(url.pathname).toBe(`/${getLocale()}/collections/${encodeURIComponent(id)}`);
      expect([...url.searchParams]).toEqual(anchor === first ? expected : [...expected, ['cursor', next]]);
    }
    first.focus();
    expect(first).toHaveFocus();
    await userEvent.tab();
    expect(more).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(first).toHaveFocus();
    expect(context.canvasElement.scrollWidth).toBeLessThanOrEqual(context.canvasElement.clientWidth);
  },
};

function notReady(change: Partial<Page>, message: () => string) {
  return {
    render: () => render({ cursor, next, filter, members: [member('retained', 'Retained member')], ...change }, search),
    play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const view = within(canvasElement);
      expect(await view.findByText(message(), { exact: false })).toBeVisible();
      noGlobalEmpty(canvasElement);
      expect(view.queryByText(m.library_dynamic_page_reader_empty())).toBeNull();
      expect(view.queryByText('Retained member')).toBeNull();
      expect(view.queryByRole('navigation', { name: m.library_collection_members() })).toBeNull();
    },
  } satisfies Story;
}
export const Unavailable: Story = {
  name: 'Unavailable saved results, explicit same-page recovery',
  render: () => {
    const supplied = page({ builtinKind: undefined, unavailable: true, filter, cursor });
    return (
      <PatternStory path={`/collections/${encodeURIComponent(id)}`}>
        <main className="mx-auto w-full min-w-0 max-w-4xl p-4">
          <DynamicCollectionPage
            page={supplied}
            search={search}
            readMembers={async () => ({
              members: [],
              next: null,
              preparing: false,
              unavailable: false,
              retryAfterMs: 1000,
            })}
          />
        </main>
      </PatternStory>
    );
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    expect(await view.findByText(m.library_dynamic_unavailable())).toBeVisible();
    const retry = view.getByRole('button', { name: m.library_dynamic_retry_unavailable() });
    retry.focus();
    expect(retry).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await view.findByText(m.library_dynamic_retry_ready())).toBeVisible();
    expect(view.getByText(m.library_dynamic_page_reader_empty())).toBeVisible();
    expect(view.queryByText(m.library_dynamic_unavailable())).toBeNull();
    noGlobalEmpty(canvasElement);
  },
};
export const Preparing: Story = notReady({ preparing: true }, m.library_dynamic_preparing);
export const FilterUnsupported: Story = notReady({ filterStatus: 'unsupported' }, m.collection_filter_unsupported);
export const FilterFailed: Story = notReady({ filterStatus: 'failed' }, m.collection_filter_failed);
export const FilterPreparing: Story = notReady(
  { preparing: true, filterStatus: 'preparing' },
  m.collection_filter_preparing,
);
export const IgnoredFilter: Story = {
  name: 'Ignored filter needs correction before results',
  render: () => render({ cursor, next, filterIgnored: ['f.unavailable'] }),
  play: async (context) => {
    const view = within(context.canvasElement);
    expect(await view.findByText(m.collection_filter_address_rejected())).toBeVisible();
    expect(view.getByRole('link', { name: m.collection_filter_clear() })).toBeVisible();
    expect(view.queryByText(m.library_dynamic_page_reader_empty())).toBeNull();
    expect(view.getByText(m.collection_filter_ignored({ filter: 'f.unavailable' }))).toBeVisible();
  },
};
