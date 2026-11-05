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
  mangaVolumeCitation,
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
  longIdentity?: boolean;
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
    const fixture = selectMangaStory(args.scenario ?? 'ready', getLocale());
    if (args.longIdentity) {
      for (const read of fixture.reads.values()) {
        read.subject.labels = {
          en:
            'The Paper Observatory — a fully identified manga subject with a very long title ' +
            'Observatory'.repeat(24),
          ar: 'المرصد الورقي باسم طويل ومراجع كاملة',
        };
        read.subject.descriptions = {
          en: 'A full illustrative manga description. '.repeat(8),
          fr: 'Description conservée sans nom français.',
        };
        read.subject.aliases = {
          en: ['The full alternative manga title ' + 'Paper'.repeat(24)],
          ja: ['紙の天文台の別名'],
        };
        fixture.release.types[read.subject.type]!.labels = {
          en: 'A long released manga kind label ' + 'Catalogue'.repeat(24),
        };
      }
    }
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
async function enabled(control: HTMLElement) {
  // The real fieldset can stay disabled after its controls appear while session and metadata load.
  await waitFor(async () => {
    await expect(control).toBeEnabled();
    await expect(control).toHaveStyle({ pointerEvents: 'auto' });
  });
  return control;
}
async function addField(canvasElement: HTMLElement, group: string, property: string) {
  const canvas = within(canvasElement);
  const select = await enabled(await canvas.findByRole('combobox', { name: group }));
  await userEvent.selectOptions(select, property);
  await userEvent.click(
    await enabled(within(select.closest('section')!).getByRole('button', { name: m.correction_add() })),
  );
  return within(await canvas.findByRole('region', { name: fieldName(property) }));
}
async function fillSeries(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(
    await enabled(await canvas.findByRole('textbox', { name: m.catalogue_create_label() })),
    getLocale() === 'ja' ? '紙の天文台' : 'The Paper Observatory',
  );
  const language = await addField(canvasElement, m.manga_publication(), 'schema:inLanguage');
  await userEvent.type(await enabled(language.getByRole('textbox', { name: m.correction_value() })), 'ja');
}
async function removeAccidentalBlankLanguage(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const terms = within(await canvas.findByRole('group', { name: m.catalogue_create_terms() }));
  const primaryLabel = terms.getByRole('textbox', { name: m.catalogue_create_label() });
  const primaryDescription = terms.getByRole('textbox', { name: m.catalogue_create_description() });
  const primaryAliases = terms.getByRole('textbox', { name: m.catalogue_create_aliases() });
  const primaryTerm =
    getLocale() === 'ja'
      ? {
          label: '紙の天文台',
          description: '静かな天文学の謎',
          aliases: '紙の空\n夜の地図',
        }
      : {
          label: 'The Paper Observatory',
          description: 'A quiet astronomical mystery',
          aliases: 'Paper sky\nNight atlas',
        };
  const retainedTerm =
    getLocale() === 'ja'
      ? {
          language: 'en',
          label: 'The Paper Observatory',
          description: 'A quiet astronomical mystery',
          aliases: 'Paper sky\nNight atlas',
        }
      : {
          language: 'ja',
          label: '紙の天文台',
          description: '静かな天文学の謎',
          aliases: '紙の空\n夜の地図',
        };
  await userEvent.type(primaryDescription, primaryTerm.description);
  await userEvent.type(primaryAliases, primaryTerm.aliases);
  await expect(terms.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(1);
  await expect(terms.queryByRole('button', { name: m.catalogue_create_remove_language() })).toBeNull();

  const addLanguage = await enabled(terms.getByRole('button', { name: m.catalogue_create_add_language() }));
  await userEvent.click(addLanguage);
  await userEvent.click(addLanguage);
  const removeButtons = terms.getAllByRole('button', { name: m.catalogue_create_remove_language() });
  await expect(removeButtons).toHaveLength(2);
  const blankRowId = removeButtons[0]!.getAttribute('aria-controls')!;
  const retainedRowId = removeButtons[1]!.getAttribute('aria-controls')!;
  const blankRow = canvasElement.ownerDocument.getElementById(blankRowId)!;
  const retainedRow = canvasElement.ownerDocument.getElementById(retainedRowId)!;
  const blankLanguage = within(blankRow).getByRole('textbox', { name: m.catalogue_create_language() });
  const retainedLanguage = within(retainedRow).getByRole('textbox', { name: m.catalogue_create_language() });
  const retainedLabel = within(retainedRow).getByRole('textbox', { name: m.catalogue_create_label() });
  const retainedDescription = within(retainedRow).getByRole('textbox', { name: m.catalogue_create_description() });
  const retainedAliases = within(retainedRow).getByRole('textbox', { name: m.catalogue_create_aliases() });
  await expect(blankLanguage).toHaveValue('');
  await userEvent.type(retainedLanguage, retainedTerm.language);
  await userEvent.type(retainedLabel, retainedTerm.label);
  await userEvent.type(retainedDescription, retainedTerm.description);
  await userEvent.type(retainedAliases, retainedTerm.aliases);

  await expect(removeButtons[0]!).toHaveAttribute('type', 'button');
  await expect(removeButtons[0]!).toHaveAttribute('aria-controls', blankRowId);
  await userEvent.click(await enabled(removeButtons[0]!));
  await expect(blankRow).not.toBeInTheDocument();
  await expect(retainedRow).toBeInTheDocument();
  await expect(retainedLanguage).toHaveFocus();
  await expect(terms.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(2);
  await expect(terms.getAllByRole('button', { name: m.catalogue_create_remove_language() })).toHaveLength(1);
  await expect(primaryLabel).toHaveValue(primaryTerm.label);
  await expect(primaryDescription).toHaveValue(primaryTerm.description);
  await expect(primaryAliases).toHaveValue(primaryTerm.aliases);
  await expect(retainedLanguage).toHaveValue(retainedTerm.language);
  await expect(retainedLabel).toHaveValue(retainedTerm.label);
  await expect(retainedDescription).toHaveValue(retainedTerm.description);
  await expect(retainedAliases).toHaveValue(retainedTerm.aliases);
  const inLanguage = within(await canvas.findByRole('region', { name: fieldName('schema:inLanguage') }));
  await expect(inLanguage.getByRole('textbox', { name: m.correction_value() })).toHaveValue('ja');
}
export const CreateSeries: Story = {
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await removeAccidentalBlankLanguage(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
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
      await enabled(await canvas.findByRole('combobox', { name: m.manga_grain() })),
      'schema:PublicationVolume',
    );
    await userEvent.type(
      await enabled(canvas.getByRole('textbox', { name: m.catalogue_create_label() })),
      'The Paper Observatory, volume 2',
    );
    await userEvent.click(await enabled(canvas.getByRole('checkbox', { name: m.manga_independent() })));
    const work = await addField(canvasElement, m.manga_membership(), 'wdt:P179');
    await userEvent.type(await enabled(work.getByRole('combobox', { name: fieldName('wdt:P179') })), 'Paper');
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole('option', { name: /The Paper Observatory|紙の天文台/ }),
    );
    await userEvent.selectOptions(
      await enabled(work.getByRole('combobox', { name: m.correction_add_qualifier() })),
      'schema:position',
    );
    await userEvent.click(await enabled(work.getByRole('button', { name: m.relation_add_qualifier() })));
    await userEvent.type(await enabled(work.getByRole('textbox', { name: m.correction_value() })), '2');
    const pages = await addField(canvasElement, m.manga_publication(), 'schema:numberOfPages');
    await userEvent.type(await enabled(pages.getByRole('textbox', { name: m.correction_amount() })), '+192');
    await userEvent.selectOptions(await enabled(pages.getByRole('combobox', { name: m.correction_unit() })), '1');
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
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
    await userEvent.click(await enabled(pages.getByRole('button', { name: m.facts_edit_field() })));
    const amount = await enabled(await pages.findByRole('textbox', { name: m.correction_amount() }));
    await expect(amount).toHaveValue('+192');
    await expect(pages.getByRole('combobox', { name: m.correction_unit() })).toHaveValue('1');
    await expect(pages.getByRole('textbox', { name: m.correction_value() })).toHaveValue(mangaVolumeCitation);
    await userEvent.clear(amount);
    await userEvent.type(amount, '+196');
    await expect(amount).toHaveValue('+196');
    await expect(pages.getByRole('combobox', { name: m.correction_unit() })).toHaveValue('1');
    await expect(pages.getByRole('textbox', { name: m.correction_value() })).toHaveValue(mangaVolumeCitation);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.facts_submit() })));
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
    const terms = within(await canvas.findByRole('group', { name: m.catalogue_create_terms() }));
    const originalLabel = terms.getByRole('textbox', { name: m.catalogue_create_label() });
    await userEvent.click(await enabled(terms.getByRole('button', { name: m.catalogue_create_add_language() })));
    const language = terms.getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!;
    const translation = terms.getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!;
    const translationLanguage = getLocale() === 'ja' ? 'en' : 'ja';
    const translationLabel = translationLanguage === 'ja' ? '紙の天文台' : 'The Paper Observatory';
    await userEvent.type(language, translationLanguage);
    await userEvent.type(translation, translationLabel);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(originalLabel).toBeDisabled();
    await expect(translation).toBeDisabled();
    const remove = terms.getByRole('button', { name: m.catalogue_create_remove_language() });
    await expect(remove).toBeDisabled();
    await expect(terms.getByRole('button', { name: m.catalogue_create_add_language() })).toBeDisabled();
    await expect(language).toBeDisabled();
    await expect(translation).toBeDisabled();
    remove.click();
    await expect(terms.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(2);
    await expect(translation).toHaveValue(translationLabel);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.correction_retry() })));
    await expect(await canvas.findByText(m.manga_created())).toBeVisible();
  },
};
export const Denied = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
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
    await userEvent.click(await enabled(pages.getByRole('button', { name: m.facts_edit_field() })));
    const amount = await enabled(await pages.findByRole('textbox', { name: m.correction_amount() }));
    await expect(amount).toHaveValue('+192');
    await expect(pages.getByRole('combobox', { name: m.correction_unit() })).toHaveValue('1');
    await expect(pages.getByRole('textbox', { name: m.correction_value() })).toHaveValue(mangaVolumeCitation);
    await userEvent.clear(amount);
    await userEvent.type(amount, '+196');
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.facts_submit() })));
    const alert = await pages.findByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveTextContent(m.correction_stale());
    await expect(amount).toHaveValue('+196');
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    await expect(canvas.getByText(mangaSeriesId)).toBeVisible();
  },
};
export const ReaderConcealed: Story = {
  args: { scenario: 'reader-concealed' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    await fillSeries(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(await enabled(canvas.getByRole('button', { name: m.manga_title() })));
    await waitFor(() => expect(canvas.getByRole('button', { name: m.catalogue_create_saving() })).toBeDisabled());
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };

// UNRUN: real route composition, extended only through the existing declared response fixture.
export const CorrectionLongIdentity: Story = {
  args: { correction: true, volume: true, longIdentity: true },
  play: ({ canvasElement }) => inspectCorrectionIdentity(canvasElement),
};
export const CorrectionSignedOut: Story = { args: { correction: true, signedOut: true } };
export const CorrectionLoading: Story = { args: { correction: true, scenario: 'loading' } };
export const CorrectionUnavailable: Story = { args: { correction: true, scenario: 'unavailable' } };
async function correctionFailure(canvasElement: HTMLElement, message: string) {
  const canvas = within(canvasElement);
  const field = within(await canvas.findByRole('region', { name: fieldName('schema:numberOfPages') }));
  await userEvent.click(await enabled(field.getByRole('button', { name: m.facts_edit_field() })));
  const amount = await enabled(field.getByRole('textbox', { name: m.correction_amount() }));
  await userEvent.clear(amount);
  await userEvent.type(amount, '+196');
  await userEvent.click(await enabled(canvas.getByRole('button', { name: m.facts_submit() })));
  await expect(await field.findByText(message)).toBeVisible();
  await expect(amount).toHaveValue('+196');
}
export const CorrectionDenied: Story = {
  args: { correction: true, volume: true, scenario: 'denied' },
  play: ({ canvasElement }) => correctionFailure(canvasElement, m.correction_denied()),
};
export const CorrectionUncertain: Story = {
  args: { correction: true, volume: true, scenario: 'uncertain' },
  play: ({ canvasElement }) => correctionFailure(canvasElement, m.facts_uncertain()),
};

// UNRUN browser oracles for the ordinary phone390/desktop1280 and locale/theme globals.
async function inspectCorrectionIdentity(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const scope = await canvas.findByText(m.specialist_identity_scope());
  const identity = scope.parentElement!;
  const heading = identity.querySelector('h2')!;
  const reference = canvas.getByText(m.specialist_identity_reference(), { selector: 'summary' });
  const details = reference.closest('details')!;
  await expect(heading).toBeVisible();
  await expect(heading.compareDocumentPosition(reference) & 4).toBeTruthy();
  await expect(details).not.toHaveAttribute('open');
  reference.focus();
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  await expect(reference).toHaveFocus();
  for (let attempt = 0; attempt < 3; attempt++) {
    await userEvent.keyboard('{Enter}');
    await expect(details).toHaveAttribute('open', '');
    await expect(Array.from(details.querySelectorAll('code'), (code) => code.textContent)).toEqual([
      mangaVolumeId,
      'schema:PublicationVolume',
    ]);
    for (const element of [identity, heading, reference, ...details.querySelectorAll<HTMLElement>('dd')]) {
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    }
    await userEvent.keyboard('{Enter}');
    await expect(details).not.toHaveAttribute('open');
  }
  const names = canvas.getByText(m.specialist_identity_names(), { selector: 'summary' });
  await userEvent.click(names);
  for (const text of names.closest('details')!.querySelectorAll<HTMLElement>('dd')) {
    await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    await expect(text.className).not.toMatch(/truncate|line-clamp/);
  }
}
