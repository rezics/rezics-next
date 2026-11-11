import { chooseSelectValue } from './select-option';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import { AlbumProfile } from '../features/catalogue/album-profile-view';
import {
  albumFixture,
  albumId,
  artistId,
  roleId,
  seriesId,
  partId,
  type AlbumScenario,
} from '../kernel/fake/catalogue-album-profile';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';
import {
  createObserver,
  recoverLanguageRow,
  retryLanguageRecovery,
  type ObserveCreate,
} from './catalogue-language-row-recovery';

function AlbumStory({
  scenario = 'ready',
  correction = false,
  signedOut = false,
  longIdentity = false,
  onCreate,
}: {
  scenario?: AlbumScenario;
  correction?: boolean;
  signedOut?: boolean;
  longIdentity?: boolean;
  onCreate?: ObserveCreate;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = albumFixture(scenario, locale);
    if (longIdentity) {
      value.publicRead.subject.labels = {
        en: 'Harbour sessions — the complete album work with an exceptionally long title ' + 'Harbour'.repeat(24),
        ar: 'جلسات الميناء باسم طويل ومراجع كاملة',
      };
      value.publicRead.subject.descriptions = {
        en: 'A complete illustrative album description. '.repeat(8),
        fr: 'Description conservée sans nom français.',
      };
      value.publicRead.subject.aliases = {
        en: ['The full alternative album name ' + 'Sessions'.repeat(24)],
        ja: ['港の演奏の別名'],
      };
      value.release.types['schema:MusicAlbum']!.labels = {
        en: 'A long released album kind label ' + 'Catalogue'.repeat(24),
      };
    }
    return value;
  }, [scenario, locale, longIdentity]);
  const transport = useMemo(
    () => ({
      ...fixture.transport,
      ...(correction ? { load: fixture.loadCorrection } : {}),
      create: async (command: Parameters<typeof fixture.transport.create>[0]) => {
        const result = await fixture.transport.create(command);
        onCreate?.(structuredClone(fixture.calls));
        return result;
      },
    }),
    [fixture, correction, onCreate],
  );
  return (
    <PatternStory
      path={correction ? `/subjects/${albumId}/harbour-sessions/album` : '/catalogue/album'}
      visitor={signedOut ? 'Signed Out' : 'Signed In'}
    >
      <AppShell>
        <AlbumProfile
          {...(correction ? { id: albumId } : {})}
          locale={locale}
          session={signedOut ? 'signed-out' : 'signed-in'}
          transport={transport}
          editors={fixture.editors}
          search={async (text) =>
            [artistId, roleId, seriesId, partId].flatMap((id) => {
              const related = fixture.publicRead.related[id]!;
              const title = pickText(related.labels, locale).text;
              return title.toLowerCase().includes(text.toLowerCase())
                ? [
                    {
                      id,
                      title,
                      types: [related.type!],
                      typeLabel: pickText(fixture.release.types[related.type!]?.labels ?? {}, locale).text,
                      cover: null,
                    },
                  ]
                : [];
            })
          }
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Catalogue/Released album catalogue editor',
  id: 'pages-catalogue-released-album-catalogue-editor',
  component: AlbumStory,
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
          'Declared original album examples use the existing generated native request helpers. No provider prose or cover. Native integration and Web visual review remain pending. Locale, viewport and theme use globals; names retain their actual data language.',
      },
    },
  },
} satisfies Meta<typeof AlbumStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const fieldName = (id: string) =>
  pickText(definitions.release.properties[id as keyof typeof definitions.release.properties].labels, getLocale()).text;

async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Harbour sessions');
  await chooseSelectValue(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:datePublished');
  await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
  const date = within(canvas.getByRole('group', { name: fieldName('schema:datePublished') }));
  await chooseSelectValue(date.getByRole('combobox', { name: m.correction_precision() }), '9');
  await userEvent.type(date.getByRole('textbox', { name: m.correction_year() }), '2024');
  await userEvent.type(date.getByRole('textbox', { name: m.relation_citation() }), 'https://artist.example/harbour');
  return canvas;
}
async function confirmAlbum(canvas: ReturnType<typeof within>) {
  if (canvas.queryByRole('button', { name: m.catalogue_create_retry() })) {
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    return;
  }
  if (canvas.queryByRole('button', { name: m.album_create() })) {
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    return;
  }
  await userEvent.click(canvas.getByRole('button', { name: m.album_create_review() }));
  if (canvas.queryByRole('button', { name: m.album_create() }))
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
}
async function create(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await confirmAlbum(canvas);
  return canvas;
}
const failure = (scenario: AlbumScenario, text: () => string): Story => ({
  args: { scenario },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(text())).toBeVisible();
  },
});

export const Ready: Story = {};
export const LanguageRowRecovery: Story = {
  args: { scenario: 'uncertain', onCreate: createObserver() },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: default album creation at 390px measures real term, scalar, credit, qualifier, citation and action targets, wrapped labels and saved-reader links. Existing language recovery and exact payload/key retry oracles remain. Browser, native and visual verification are deferred.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = await fill(canvasElement);
    const document = canvasElement.ownerDocument;
    const form = canvas.getByRole('textbox', { name: m.catalogue_create_label() }).closest('form')!;
    // Inspect native target and rendered text geometry, independently of the caller's classes.
    const phoneControls = async (region: HTMLElement) => {
      const bounds = region.getBoundingClientRect();
      await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
      for (const target of region.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, button[data-slot="button"], a',
      )) {
        const rect = target.getBoundingClientRect();
        const parent = target.parentElement!.getBoundingClientRect();
        await expect(rect.height).toBeGreaterThanOrEqual(44);
        await expect(rect.width).toBeGreaterThanOrEqual(44);
        await expect(rect.left).toBeGreaterThanOrEqual(Math.max(bounds.left, parent.left) - 1);
        await expect(rect.right).toBeLessThanOrEqual(Math.min(bounds.right, parent.right) + 1);
      }
      for (const label of region.querySelectorAll<HTMLElement>('[data-slot="field-label"], button, a')) {
        const box = label.getBoundingClientRect();
        const walker = document.createTreeWalker(label, 4 /* SHOW_TEXT */);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const line of range.getClientRects()) {
            await expect(line.left).toBeGreaterThanOrEqual(box.left - 1);
            await expect(line.right).toBeLessThanOrEqual(box.right + 1);
            await expect(line.top).toBeGreaterThanOrEqual(box.top - 1);
            await expect(line.bottom).toBeLessThanOrEqual(box.bottom + 1);
          }
        }
      }
    };
    await phoneControls(form);
    await chooseSelectValue(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:contributor');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    const artist = within(canvas.getByRole('group', { name: fieldName('schema:contributor') }));
    await userEvent.type(artist.getByRole('combobox', { name: fieldName('schema:contributor') }), 'Harbour');
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole('option', { name: /The Harbour Ensemble/ }),
    );
    await userEvent.type(
      artist.getByRole('textbox', { name: m.relation_citation() }),
      'https://artist.example/harbour',
    );
    await chooseSelectValue(artist.getByRole('combobox', { name: m.relation_qualifier() }), 'wdt:P1932');
    const creditedAs = artist.getByRole('textbox', { name: fieldName('wdt:P1932') });
    await userEvent.type(creditedAs, 'The Harbour Ensemble');
    await chooseSelectValue(artist.getByRole('combobox', { name: m.relation_qualifier() }), 'wdt:P3831');
    await userEvent.type(artist.getByRole('combobox', { name: fieldName('wdt:P3831') }), 'Performer');
    await userEvent.click(await within(document.body).findByRole('option', { name: /Performer/ }));
    await phoneControls(form);
    const removeCredit = artist.getByRole('button', { name: `${m.relation_remove()}: ${fieldName('wdt:P1932')}` });
    // On a phone removal wraps below its input instead of squeezing the value into the remaining width.
    await expect(removeCredit.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      creditedAs.getBoundingClientRect().bottom,
    );
    await userEvent.click(removeCredit);
    await userEvent.click(artist.getByRole('button', { name: `${m.relation_remove()}: ${fieldName('wdt:P3831')}` }));
    await expect(artist.queryByRole('textbox', { name: fieldName('wdt:P1932') })).toBeNull();
    await expect(artist.queryByRole('combobox', { name: fieldName('wdt:P3831') })).toBeNull();
    const observed = args.onCreate as ReturnType<typeof createObserver>;
    const terms = await recoverLanguageRow(
      canvasElement,
      m.album_create_review(),
      observed,
      'Harbour sessions',
      '港の演奏',
    );
    await phoneControls(form);
    await confirmAlbum(within(canvasElement));
    await retryLanguageRecovery(canvasElement, m.album_create(), m.catalogue_create_retry(), observed, {
      type: 'schema:MusicAlbum',
      ...terms,
      statements: {
        'schema:datePublished': [
          {
            property: { id: 'schema:datePublished' },
            value: {
              type: 'value',
              content: {
                time: '+2024-00-00T00:00:00Z',
                precision: 9,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              },
            },
            qualifiers: [],
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://artist.example/harbour' },
                  },
                ],
              },
            ],
            rank: 'normal',
          },
        ],
        'schema:contributor': [
          {
            property: { id: 'schema:contributor' },
            value: { type: 'value', content: artistId },
            qualifiers: [],
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://artist.example/harbour' },
                  },
                ],
              },
            ],
            rank: 'normal',
          },
        ],
      },
    });
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    const reader = canvas.getByRole('link', { name: m.catalogue_create_open() });
    await expect(reader).toHaveAttribute('href', expect.stringContaining(`/${getLocale()}/subjects/${albumId}/`));
    await phoneControls(reader.closest('section')!);
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Concealed: Story = { args: { correction: true, scenario: 'concealed' } };
export const Correction: Story = { args: { correction: true } };
export const Denied = failure('denied', () => m.catalogue_create_denied());
export const Invalid = failure('invalid', () => m.catalogue_create_invalid());
export const Conflict = failure('conflict', () => m.catalogue_create_conflict());
export const StaleMetadata = failure('stale-metadata', () => m.catalogue_create_invalid());
export const ReaderUnavailable = failure('reader-unavailable', () => m.catalogue_create_reader_unavailable());
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await chooseSelectValue(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:contributor');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    const artist = within(canvas.getByRole('group', { name: fieldName('schema:contributor') }));
    await userEvent.type(artist.getByRole('combobox', { name: fieldName('schema:contributor') }), 'Harbour');
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole('option', { name: /The Harbour Ensemble/ }),
    );
    await chooseSelectValue(artist.getByRole('combobox', { name: m.relation_qualifier() }), 'wdt:P3831');
    await userEvent.type(artist.getByRole('combobox', { name: fieldName('wdt:P3831') }), 'Performer');
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('option', { name: /Performer/ }));
    await userEvent.type(
      artist.getByRole('textbox', { name: m.relation_citation() }),
      'https://artist.example/harbour',
    );
    await confirmAlbum(canvas);
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/en/subjects/${albumId}/harbour-sessions`.replace('/en/', `/${getLocale()}/`),
    );
  },
};
export const Retry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
  },
};
export const Proposed: Story = {
  args: { correction: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = within(await canvas.findByRole('region', { name: fieldName('schema:datePublished') }));
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const year = field.getByRole('textbox', { name: m.correction_year() });
    await userEvent.clear(year);
    await userEvent.type(year, '2025');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(await field.findByText(m.correction_proposed())).toBeVisible();
    await expect(field.getByRole('link', { name: m.correction_review() })).toHaveAttribute(
      'href',
      expect.stringContaining('candidate='),
    );
  },
};
export const CreditCorrection: Story = {
  args: { correction: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseSelectValue(await canvas.findByRole('combobox', { name: m.relation_property() }), 'schema:contributor');
    await userEvent.click(canvas.getByRole('button', { name: m.relation_edit_existing() }));
    const position = canvas.getByRole('textbox', { name: fieldName('schema:position') });
    await userEvent.clear(position);
    await userEvent.type(position, '2');
    await userEvent.click(canvas.getByRole('button', { name: m.relation_propose() }));
    const confirmation = within(
      canvas.getByRole('group', { name: m.candidate_confirm_title({ action: m.relation_propose() }) }),
    );
    await userEvent.click(confirmation.getByRole('button', { name: m.relation_propose() }));
    await expect(await canvas.findByText(m.relation_proposed())).toBeVisible();
  },
};

// UNRUN: correction-only states extend the default production page, without claiming native evidence.
export const CorrectionLongIdentity: Story = {
  args: { correction: true, longIdentity: true },
  play: ({ canvasElement }) => inspectCorrectionIdentity(canvasElement),
};
export const CorrectionSignedOut: Story = { args: { correction: true, signedOut: true } };
export const CorrectionLoading: Story = { args: { correction: true, scenario: 'loading' } };
export const CorrectionUnavailable: Story = { args: { correction: true, scenario: 'unavailable' } };
async function correctionFailure(canvasElement: HTMLElement, message: string) {
  const canvas = within(canvasElement);
  const field = within(await canvas.findByRole('region', { name: fieldName('schema:datePublished') }));
  await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
  const year = field.getByRole('textbox', { name: m.correction_year() });
  await userEvent.clear(year);
  await userEvent.type(year, '2025');
  await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
  await expect(await field.findByText(message)).toBeVisible();
  await expect(year).toHaveValue('2025');
}
export const CorrectionDenied: Story = {
  args: { correction: true, scenario: 'denied' },
  play: ({ canvasElement }) => correctionFailure(canvasElement, m.correction_denied()),
};
export const CorrectionUncertain: Story = {
  args: { correction: true, scenario: 'uncertain' },
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
      albumId,
      'schema:MusicAlbum',
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
