import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { FilterDocument } from '@rezics/filter';
import releaseRecording from '../kernel/recorded/definitions-release.json';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { SearchPage } from '../search/search';
import { CONDITION_POINTER, conditionMetadata } from '../search/condition-editor-model';
import { discoverySearchHref, searchLoaderDeps } from '../search/search-params';
import { HeaderSearchFilterProvider } from '../search/header-search/filter-region';
import { PageStory, PatternStory, pageReady } from './page';

const tree: FilterDocument = {
  and: [
    { type: { in: ['schema:Book'] } },
    {
      or: [
        { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } },
        { not: { type: { in: ['schema:Movie'] } } },
      ],
    },
  ],
};
const state = searchLoaderDeps({ q: 'Mira', condition: JSON.stringify(tree), language: ['ja'], cursor: 'old+/=' });
const meta = {
  title: 'Patterns/Discovery/Search Condition Editor',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The existing Search route, shell and Filters surface. Typed presentation fixtures exercise the public caller; native proof and Web visual approval remain pending. Review phone390/desktop1280 in all locales and both themes.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function NestedPage() {
  return <PageStory visitor="Signed Out" path={discoverySearchHref(getLocale(), { ...state, cursor: undefined })} />;
}

async function editAndSubmit(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  const trigger = canvas
    .getAllByRole('button', { name: new RegExp(m.search_filters()) })
    .find((button) => button.getClientRects().length > 0 && !button.hasAttribute('disabled'));
  if (trigger) await userEvent.click(trigger);
  const document = context.canvasElement.ownerDocument;
  const editor = await within(document.body).findByRole('heading', { name: m.condition_heading() });
  const form = editor.closest('form')!;
  const condition = form.querySelector<HTMLElement>(`[data-condition-pointer="${CONDITION_POINTER}/and/1/or/0"]`)!;
  const lower = within(condition).getByRole('textbox', { name: m.refinement_lower() });
  await userEvent.clear(lower);
  await userEvent.type(lower, '2000001');
  const expected = JSON.parse(JSON.stringify(tree));
  expected.and[1].or[0].statement.range.gte = 2000001;
  let submitted: FormData | undefined;
  form.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      submitted = new FormData(form);
    },
    { once: true },
  );
  await userEvent.click(
    within(form)
      .getAllByRole('button', { name: m.search_apply() })
      .find((button) => button.getClientRects().length > 0)!,
  );
  await expect(submitted?.get('q')).toBe('Mira');
  await expect(submitted?.get('cursor')).toBeNull();
  await expect(JSON.parse(String(submitted?.get('condition')))).toEqual(expected);
  await expect(submitted?.getAll('language')).toEqual(['ja']);
}

export const Nested: Story = {
  render: () => <NestedPage />,
  play: editAndSubmit,
};

function Failure({ restart = false, metadata = true }: { restart?: boolean; metadata?: boolean }) {
  return (
    <PatternStory path={discoverySearchHref(getLocale(), state)}>
      <HeaderSearchFilterProvider>
        <div className="p-4">
          <SearchPage
            query={state.query}
            initiallyOpen
            data={{
              queryState: state,
              condition: tree,
              ...(metadata ? { conditionMetadata: conditionMetadata(releaseRecording.release) } : {}),
              discovery: { status: restart ? 'restart' : 'unsupported' },
              ...(restart
                ? {}
                : {
                    problem: {
                      code: 'unsupported_query',
                      errors: [
                        {
                          pointer: `${CONDITION_POINTER}/and/1/or/0/statement/range/unit`,
                          code: 'unsupported',
                        },
                      ],
                    },
                  }),
              hitTypes: {},
              yearProperties: [],
              typeChoices: [],
              groups: [],
              selectedFacets: {},
              selectedFacetLabels: {},
              facetsAvailable: metadata,
              facetRetry: false,
              facetIndexNotReady: false,
              staleCursorRestarted: false,
              sort: 'relevance',
            }}
          />
        </div>
      </HeaderSearchFilterProvider>
    </PatternStory>
  );
}

export const NativePointerRetention: Story = {
  render: () => <Failure />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const input = await page.findByRole('combobox', { name: m.refinement_unit() });
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveValue('1');
    await expect(page.getByRole('combobox', { name: m.condition_language() })).toHaveValue('ja');
  },
};
export const LanguageAndRestart: Story = {
  render: () => <Failure restart />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const language = await page.findByRole('combobox', { name: m.condition_language() });
    await userEvent.selectOptions(language, 'fr');
    const restart = page.getByRole('link', { name: m.discovery_restart_action() });
    const url = new URL(restart.getAttribute('href')!, 'https://example.test');
    await expect(url.searchParams.get('cursor')).toBeNull();
    await expect(url.searchParams.getAll('language')).toEqual(['fr']);
    await expect(JSON.parse(url.searchParams.get('condition')!)).toEqual(tree);
    await expect(url.searchParams.get('q')).toBe('Mira');
  },
};
export const MetadataUnavailable: Story = { render: () => <Failure metadata={false} /> };
