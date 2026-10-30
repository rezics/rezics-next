import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { PageStory } from './page';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import {
  selectMangaStory,
  clearMangaStory,
  mangaExample,
  mangaSeriesId,
  mangaVolumeId,
  type MangaScenario,
} from '../kernel/fake/catalogue-manga-profile';
import definitions from '../kernel/recorded/definitions-release.json';

function MangaStory({
  correction = false,
  volume = false,
  signedOut = false,
}: {
  scenario?: MangaScenario;
  correction?: boolean;
  volume?: boolean;
  signedOut?: boolean;
}) {
  const locale = getLocale();
  const item = mangaExample(volume);
  const href = subjectHref(
    { id: volume ? mangaVolumeId : mangaSeriesId, label: pickText(item.labels, locale).text },
    locale,
  ).href;
  return (
    <PageStory
      visitor={signedOut ? 'Signed Out' : 'Signed In'}
      path={correction ? `${href}/manga` : '/catalogue/manga'}
    />
  );
}
const meta = {
  title: 'Pages/Catalogue/Manga series and volume editor',
  component: MangaStory,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Actual private routes with declared native request examples. Use locale, theme and viewport globals. Native acceptance and Web captures are pending. Terms writes retain the existing adapter’s unavailable state; classification proposals are not yet offered by the shared relation editor.',
      },
    },
  },
  beforeEach: ({ args }) => {
    selectMangaStory(args.scenario ?? 'ready', getLocale());
    // The page uses the ordinary target picker; only its declared BFF response is supplied here.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location.href);
      if (url.pathname === '/api/search/suggestions' && /paper|observatory|紙/iu.test(url.searchParams.get('q') ?? ''))
        return Response.json({
          subjects: [
            {
              id: mangaSeriesId,
              type: 'schema:ComicSeries',
              labels: mangaExample().labels,
              descriptions: {},
              aliases: {},
              summary: null,
              facts: {},
            },
          ],
          types: { 'schema:ComicSeries': definitions.release.types['schema:ComicSeries'].labels },
        });
      return original(input, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
      clearMangaStory();
    };
  },
} satisfies Meta<typeof MangaStory>;
export default meta;
type Story = StoryObj<typeof meta>;
function fieldName(property: string) {
  return pickText(
    definitions.release.properties[property as keyof typeof definitions.release.properties].labels,
    getLocale(),
  ).text;
}
async function addField(canvasElement: HTMLElement, group: string, property: string) {
  const canvas = within(canvasElement);
  const select = await canvas.findByRole('combobox', { name: group });
  await userEvent.selectOptions(select, property);
  await userEvent.click(within(select.closest('section')!).getByRole('button', { name: m.correction_add() }));
  return within(await canvas.findByRole('region', { name: fieldName(property) }));
}
async function fillSeries(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(
    await canvas.findByRole('textbox', { name: m.catalogue_create_label() }),
    'The Paper Observatory',
  );
  const language = await addField(canvasElement, m.manga_publication(), 'schema:inLanguage');
  await userEvent.type(language.getByRole('textbox', { name: m.correction_value() }), 'ja');
}
export const CreateSeries: Story = {
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.manga_title() }));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
      'href',
      expect.stringContaining(mangaSeriesId),
    );
  },
};
export const CreateVolume: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: m.manga_grain() }),
      'schema:PublicationVolume',
    );
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.catalogue_create_label() }),
      'The Paper Observatory, volume 2',
    );
    await userEvent.click(canvas.getByRole('checkbox', { name: m.manga_independent() }));
    const work = await addField(canvasElement, m.manga_membership(), 'wdt:P179');
    await userEvent.type(work.getByRole('combobox', { name: fieldName('wdt:P179') }), 'Paper');
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole('option', { name: /The Paper Observatory|紙の天文台/ }),
    );
    await userEvent.selectOptions(
      work.getByRole('combobox', { name: m.correction_add_qualifier() }),
      'schema:position',
    );
    await userEvent.click(work.getByRole('button', { name: m.relation_add_qualifier() }));
    await userEvent.type(work.getByRole('textbox', { name: m.correction_value() }), '2');
    const pages = await addField(canvasElement, m.manga_publication(), 'schema:numberOfPages');
    await userEvent.type(pages.getByRole('textbox', { name: m.correction_amount() }), '+192');
    await userEvent.selectOptions(pages.getByRole('combobox', { name: m.correction_unit() }), '1');
    await userEvent.click(canvas.getByRole('button', { name: m.manga_title() }));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
      'href',
      expect.stringContaining(mangaVolumeId),
    );
  },
};
export const CorrectSeries: Story = { args: { correction: true } };
export const CorrectVolume: Story = {
  args: { correction: true, volume: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pages = within(await canvas.findByRole('region', { name: fieldName('schema:numberOfPages') }));
    await userEvent.click(pages.getByRole('button', { name: m.facts_edit_field() }));
    const amount = pages.getByRole('textbox', { name: m.correction_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '+196');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(await pages.findByText(m.correction_proposed())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
      'href',
      expect.stringContaining(mangaVolumeId),
    );
    await expect(pages.getByRole('heading', { name: m.candidate_current() })).toBeVisible();
  },
};
export const Uncertain: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fillSeries(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.manga_title() }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
  },
};
export const Denied = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.manga_title() }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue(
      'The Paper Observatory',
    );
  },
} satisfies Story;
export const Invalid: Story = { args: { scenario: 'invalid' }, play: Denied.play };
export const Conflict: Story = { args: { scenario: 'conflict' }, play: Denied.play };
export const StaleCorrection: Story = {
  args: { correction: true, volume: true, scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      pages = within(await canvas.findByRole('region', { name: fieldName('schema:numberOfPages') }));
    await userEvent.click(pages.getByRole('button', { name: m.facts_edit_field() }));
    const amount = pages.getByRole('textbox', { name: m.correction_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '+196');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(await pages.findByRole('alert')).toBeVisible();
    await expect(amount).toHaveValue('+196');
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.manga_title() }));
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    await expect(canvas.getByText(mangaSeriesId)).toBeVisible();
  },
};
export const ReaderConcealed: Story = {
  args: { scenario: 'reader-concealed' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.manga_title() }));
    await expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.manga_title() }));
    await waitFor(() => expect(canvas.getByRole('button', { name: m.catalogue_create_saving() })).toBeDisabled());
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
