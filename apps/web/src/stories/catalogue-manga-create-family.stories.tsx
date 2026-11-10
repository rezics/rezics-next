import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { PageStory } from './page';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { mangaGroupLabels } from '../features/catalogue/manga-profile-view';
import {
  selectMangaStory,
  clearMangaStory,
  mangaExample,
  mangaSeriesId,
  mangaVolumeId,
  mangaVolumeCitation,
  type MangaScenario,
} from '../kernel/fake/catalogue-manga-profile';

let fixture: ReturnType<typeof selectMangaStory>;
let pendingWrite = false;
let releaseWrite = () => {};

function MangaCreationStory({
  signedOut = false,
  direction = 'ltr',
}: {
  scenario?: MangaScenario;
  signedOut?: boolean;
  direction?: 'ltr' | 'rtl';
  longLabels?: boolean;
  retirement?: boolean;
}) {
  return (
    <div dir={direction}>
      <PageStory visitor={signedOut ? 'Signed Out' : 'Signed In'} path="/catalogue/manga" />
    </div>
  );
}
const meta = {
  title: 'Catalogue/Manga creation family',
  id: 'pages-catalogue-manga-creation-family',
  component: MangaCreationStory,
  args: { direction: 'ltr' },
  argTypes: { direction: { control: 'inline-radio', options: ['ltr', 'rtl'] } },
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
          'Authored UNRUN. Actual connected creation route with the existing generated-client request fixture. Review every example at phone390 and desktop1280, both direction controls, locale and theme globals. Browser geometry, native acceptance, SSR and growth remain unverified. Canonical correction stories and their +192/+196, unit and citation oracles are unchanged.',
      },
    },
  },
  beforeEach: ({ args }) => {
    const locale = getLocale();
    fixture = selectMangaStory(args.scenario ?? 'ready', locale);
    pendingWrite = false;
    releaseWrite = () => {};
    if (args.retirement) {
      const nativeFetch = fixture.fetcher;
      const delivery = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      fixture.fetcher = (async (input, init) => {
        const response = await nativeFetch(input, init);
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (request.method === 'POST' && new URL(request.url).pathname === '/v1/subjects') {
          pendingWrite = true;
          await delivery;
          pendingWrite = false;
        }
        return response;
      }) as typeof fetch;
    }
    if (args.longLabels) {
      for (const id of ['schema:inLanguage', 'schema:abstract', 'wdt:P179', 'schema:position']) {
        fixture.release.properties[id]!.labels[locale] =
          `${pickText(fixture.release.properties[id]!.labels, locale).text} — ${'Full supplied field name 紙の天文台 '.repeat(8)}`;
      }
    }
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
          types: { 'schema:ComicSeries': fixture.release.types['schema:ComicSeries']!.labels },
        });
      return original(input, init);
    }) as typeof fetch;
    return () => {
      releaseWrite();
      globalThis.fetch = original;
      clearMangaStory();
    };
  },
} satisfies Meta<typeof MangaCreationStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const name = (property: string) => pickText(fixture.release.properties[property]!.labels, getLocale()).text;
const groups = () => mangaGroupLabels(getLocale());
const writes = () => fixture.calls.filter((call) => call.method === 'POST');
async function enabled(control: HTMLElement) {
  await waitFor(async () => {
    await expect(control).toBeEnabled();
    await expect(control).toHaveStyle({ pointerEvents: 'auto' });
  });
  return control;
}
async function replace(control: HTMLElement, text: string) {
  await userEvent.clear(await enabled(control));
  if (text) await userEvent.type(control, text);
}
async function add(canvasElement: HTMLElement, group: string, property: string) {
  const canvas = within(canvasElement);
  const select = await enabled(await canvas.findByRole('combobox', { name: group }));
  const label = [...canvasElement.querySelectorAll<HTMLLabelElement>('label')].find(
    (label) => label.htmlFor === select.id,
  )!;
  await expect(label).toHaveTextContent(group);
  await userEvent.click(label);
  await expect(select).toHaveFocus();
  await userEvent.selectOptions(select, property);
  await userEvent.tab();
  const button = within(select.closest('section')!).getByRole('button', { name: m.correction_add() });
  await expect(button).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  return within(await canvas.findByRole('region', { name: name(property) }));
}
async function terms(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const longName = `The Paper Observatory — ${'The complete supplied name 紙の天文台 '.repeat(7)}`;
  const longAlias = `Alternative ${'unbrokenalias'.repeat(18)}`;
  await replace(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), longName);
  await replace(
    canvas.getByRole('textbox', { name: m.catalogue_create_description() }),
    'A quiet astronomical mystery. '.repeat(8),
  );
  await replace(canvas.getByRole('textbox', { name: m.catalogue_create_aliases() }), `${longAlias}\nNight atlas`);
  const addLanguage = await enabled(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
  await userEvent.click(addLanguage);
  await userEvent.click(addLanguage);
  const languages = canvas.getAllByRole('textbox', { name: m.catalogue_create_language() });
  const labels = canvas.getAllByRole('textbox', { name: m.catalogue_create_label() });
  const otherLanguage = getLocale() === 'ja' ? 'en' : 'ja';
  await replace(languages[2]!, otherLanguage);
  await replace(labels[2]!, otherLanguage === 'ja' ? '紙の天文台' : 'The Paper Observatory');
  const removals = canvas.getAllByRole('button', { name: m.catalogue_create_remove_language() });
  const removedId = removals[0]!.getAttribute('aria-controls')!;
  removals[0]!.focus();
  await userEvent.keyboard('{Enter}');
  await expect(canvasElement.ownerDocument.getElementById(removedId)).toBeNull();
  await expect(languages[2]!).toHaveFocus();
  await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[0]!).toHaveValue(longName);
  await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_aliases() })[0]!).toHaveValue(
    `${longAlias}\nNight atlas`,
  );
  return longName;
}
async function inspect(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('group', { name: m.catalogue_create_terms() })).toBeVisible();
  await expect(canvas.getByRole('heading', { name: m.manga_grain(), level: 2 })).toBeVisible();
  await expect(canvas.getByRole('heading', { name: m.catalogue_create_terms(), level: 2 })).toBeVisible();
  await expect(canvasElement.querySelector('[data-slot="list-row-link"], a button, a input, a select')).toBeNull();
  for (const control of canvasElement.querySelectorAll('select')) {
    await expect(control.tagName).toBe('SELECT');
    const label = [...canvasElement.querySelectorAll<HTMLLabelElement>('label')].find(
      (label) => label.htmlFor === control.id,
    );
    await expect(label).toBeDefined();
  }
  for (const element of canvasElement.querySelectorAll<HTMLElement>(
    'form, section, h2, h3, h4, legend, label, button, a',
  )) {
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    if (/^H[234]$/.test(element.tagName)) {
      await expect(element).toHaveAttribute('data-content-item-slot', 'title');
      await expect(element.className).not.toMatch(/truncate|line-clamp/);
    }
  }
  const search = canvas.getByRole('link', { name: m.catalogue_create_search() });
  await expect(search.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  search.focus();
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  await expect(search).toHaveFocus();
}
async function fillSeries(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const label = await terms(canvasElement);
  const language = await add(canvasElement, groups().publication, 'schema:inLanguage');
  await replace(language.getByRole('textbox', { name: m.correction_value() }), 'ja');
  await expect(canvas.getByText(m.manga_grain_help())).toBeVisible();
  return label;
}
// All plays and geometry assertions below are authored UNRUN.
export const CompleteSeries: Story = {
  args: { longLabels: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = await fillSeries(canvasElement);
    const authored = await add(canvasElement, groups().writing, 'schema:abstract');
    await expect(authored.getByText(m.authored_citation_hint())).toBeVisible();
    await replace(authored.getByRole('textbox', { name: m.authored_language() }), 'en');
    await replace(authored.getByRole('textbox', { name: m.authored_licence() }), 'CC-BY-4.0');
    const editor = authored.getByRole('textbox', { name: name('schema:abstract') });
    await userEvent.click(editor);
    await userEvent.type(editor, 'An original astronomical mystery summary.');
    await userEvent.tab();
    await replace(
      authored.getByRole('textbox', { name: m.relation_citation() }),
      'https://example.org/original-summary',
    );
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(writes()).toHaveLength(0);
    const section = editor.closest('section')!;
    const invalid = canvasElement.querySelector<HTMLAnchorElement>(`a[href="#${section.id}"]`)!;
    await userEvent.click(invalid);
    await expect(section).toHaveFocus();
    await expect(authored.getByRole('checkbox', { name: m.authored_original() })).toBeVisible();
    await userEvent.click(authored.getByRole('checkbox', { name: m.authored_original() }));
    await inspect(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
    await expect(writes()).toHaveLength(1);
    await expect(writes()[0]!.body).toMatchObject({ labels: { [getLocale()]: label }, type: 'schema:ComicSeries' });
    await expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
      'href',
      expect.stringContaining(mangaSeriesId),
    );
  },
};
export const CompleteVolume: Story = {
  args: { longLabels: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await terms(canvasElement);
    await userEvent.selectOptions(
      await enabled(canvas.getByRole('combobox', { name: m.manga_grain() })),
      'schema:PublicationVolume',
    );
    const work = await add(canvasElement, groups().membership, 'wdt:P179');
    const target = await enabled(work.getByRole('combobox', { name: name('wdt:P179') }));
    await userEvent.type(target, 'Paper');
    await within(canvasElement.ownerDocument.body).findByRole('option', { name: /The Paper Observatory|紙の天文台/ });
    await userEvent.keyboard('{ArrowDown}{Enter}');
    const qualifier = work.getByRole('combobox', { name: m.correction_add_qualifier() });
    const qualifierLabel = [...canvasElement.querySelectorAll<HTMLLabelElement>('label')].find(
      (label) => label.htmlFor === qualifier.id,
    )!;
    await userEvent.click(qualifierLabel);
    await expect(qualifier).toHaveFocus();
    await userEvent.selectOptions(qualifier, 'schema:position');
    await userEvent.tab();
    await expect(work.getByRole('button', { name: m.relation_add_qualifier() })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await replace(work.getByRole('textbox', { name: m.correction_value() }), '2');
    await expect(work.getByRole('heading', { name: name('schema:position'), level: 4 })).toBeVisible();
    const pages = await add(canvasElement, groups().publication, 'schema:numberOfPages');
    await replace(pages.getByRole('textbox', { name: m.correction_amount() }), '+192');
    await userEvent.selectOptions(pages.getByRole('combobox', { name: m.correction_unit() }), '1');
    await replace(pages.getByRole('textbox', { name: m.relation_citation() }), mangaVolumeCitation);
    const isbn = await add(canvasElement, groups().publication, 'schema:isbn');
    await replace(isbn.getByRole('textbox', { name: m.correction_value() }), '9781234567897');
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(writes()).toHaveLength(0);
    const error = canvasElement.querySelector<HTMLAnchorElement>('a[href="#manga-independent"]')!;
    await userEvent.click(error);
    await expect(canvas.getByRole('checkbox', { name: m.manga_independent() })).toHaveFocus();
    await userEvent.keyboard(' ');
    await inspect(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
    await expect(writes()).toHaveLength(1);
    const statements = (writes()[0]!.body as ReturnType<typeof mangaExample>).statements;
    await expect(statements['wdt:P179']![0]).toMatchObject({
      value: { type: 'value', content: mangaSeriesId },
      qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }],
    });
    await expect(statements['schema:numberOfPages']![0]).toMatchObject({
      value: { type: 'value', content: { amount: '+192', unit: '1' } },
      references: [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: mangaVolumeCitation } }] },
      ],
    });
    await expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
      'href',
      expect.stringContaining(mangaVolumeId),
    );
  },
};
export const SeriesPhone: Story = {
  ...CompleteSeries,
  globals: { locale: 'ja', viewport: { value: 'phone390', isRotated: false } },
};
export const SeriesDesktopRTL: Story = {
  ...CompleteSeries,
  args: { ...CompleteSeries.args, direction: 'rtl' },
  globals: { locale: 'de', viewport: { value: 'desktop1280', isRotated: false } },
};
export const VolumePhoneRTL: Story = {
  ...CompleteVolume,
  args: { ...CompleteVolume.args, direction: 'rtl' },
  globals: { locale: 'fr', viewport: { value: 'phone390', isRotated: false } },
};
export const VolumeDesktop: Story = {
  ...CompleteVolume,
  globals: { locale: 'en', viewport: { value: 'desktop1280', isRotated: false } },
};
export const UncertainReplay: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fillSeries(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByText(m.correction_unavailable())).toBeVisible();
    const original = structuredClone(writes()[0]!);
    await expect(canvas.getByRole('button', { name: m.catalogue_create_add_language() })).toBeDisabled();
    await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[0]!).toBeDisabled();
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.correction_retry() })));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
    await expect(writes()).toHaveLength(2);
    await expect(writes()[1]).toEqual(original);
  },
};
export const StaleFieldRemoval: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fillSeries(canvasElement);
    fixture.release.types['schema:ComicSeries']!.properties = fixture.release.types[
      'schema:ComicSeries'
    ]!.properties.filter((id) => id !== 'schema:inLanguage');
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByText(m.correction_stale())).toBeVisible();
    const heading = canvas.getByRole('heading', { name: name('schema:inLanguage'), level: 3 });
    await userEvent.click(
      await enabled(within(heading.closest('section')!).getByRole('button', { name: m.recipe_remove_field() })),
    );
    await expect(heading).not.toBeInTheDocument();
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
  },
};
async function refusal(canvasElement: HTMLElement, conflict: boolean) {
  const canvas = within(canvasElement);
  await fillSeries(canvasElement);
  await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
  await expect(await canvas.findByRole('alert')).toBeVisible();
  await expect(writes()).toHaveLength(1);
  const original = writes()[0]!;
  if (conflict) {
    await expect(canvas.getByRole('button', { name: m.manga_title() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_review_new() }));
  }
  fixture.setScenario('ready');
  await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
  await expect(await canvas.findByText(m.manga_created())).toBeVisible();
  await expect(writes()).toHaveLength(2);
  await expect(writes()[1]!.key).not.toBe(original.key);
}
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: ({ canvasElement }) => refusal(canvasElement, false),
};
export const ConflictReview: Story = {
  args: { scenario: 'conflict' },
  play: ({ canvasElement }) => refusal(canvasElement, true),
};
export const StaleReview: Story = {
  args: { scenario: 'stale' },
  play: ({ canvasElement }) => refusal(canvasElement, true),
};
async function recoverReader(canvasElement: HTMLElement, concealed: boolean) {
  const canvas = within(canvasElement);
  await fillSeries(canvasElement);
  await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
  await expect(await canvas.findByText(m.manga_created())).toBeVisible();
  await expect(
    canvas.getByText(concealed ? m.catalogue_create_concealed() : m.catalogue_create_reader_unavailable()),
  ).toBeVisible();
  await expect(canvas.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
  const before = fixture.calls.length;
  fixture.setScenario('ready');
  await userEvent.click(await enabled(canvas.getByRole('button', { name: m.correction_retry() })));
  await expect(await canvas.findByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
    'href',
    expect.stringContaining(mangaSeriesId),
  );
  await expect(fixture.calls).toHaveLength(before + 1);
  await expect(writes()).toHaveLength(1);
}
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: ({ canvasElement }) => recoverReader(canvasElement, false),
};
export const ReaderConcealed: Story = {
  args: { scenario: 'reader-concealed' },
  play: ({ canvasElement }) => recoverReader(canvasElement, true),
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByRole('button', { name: m.catalogue_create_saving() })).toBeDisabled();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const SignedOut: Story = { args: { signedOut: true } };

export const RetiredCreation: Story = {
  args: { retirement: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fillSeries(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await waitFor(() => expect(pendingWrite).toBe(true));
    const previousForm = canvasElement.querySelector('form')!;
    await userEvent.click(canvas.getByRole('link', { name: m.catalogue_create_search() }));
    await expect(await canvas.findByRole('heading', { name: m.search_heading() })).toBeVisible();
    await expect(previousForm).not.toBeInTheDocument();
    const before = writes().length;
    releaseWrite();
    await waitFor(() => expect(pendingWrite).toBe(false));
    await waitFor(() => expect(canvas.queryByText(m.manga_created())).toBeNull());
    await expect(writes()).toHaveLength(before);
    await expect(canvas.queryByRole('button', { name: m.correction_retry() })).toBeNull();
  },
};
