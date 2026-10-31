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
  onCreate,
}: {
  scenario?: AlbumScenario;
  correction?: boolean;
  signedOut?: boolean;
  onCreate?: ObserveCreate;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => albumFixture(scenario, locale), [scenario, locale]);
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
  title: 'Pages/Catalogue/Released album catalogue editor',
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
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:datePublished');
  await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
  const date = within(canvas.getByRole('group', { name: fieldName('schema:datePublished') }));
  await userEvent.selectOptions(date.getByRole('combobox', { name: m.correction_precision() }), '9');
  await userEvent.type(date.getByRole('textbox', { name: m.correction_year() }), '2024');
  await userEvent.type(date.getByRole('textbox', { name: m.relation_citation() }), 'https://artist.example/harbour');
  return canvas;
}
async function create(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
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
  play: async ({ canvasElement, args }) => {
    const canvas = await fill(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:contributor');
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
    const observed = args.onCreate as ReturnType<typeof createObserver>;
    const terms = await recoverLanguageRow(canvasElement, m.album_create(), observed, 'Harbour sessions', '港の演奏');
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
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:contributor');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    const artist = within(canvas.getByRole('group', { name: fieldName('schema:contributor') }));
    await userEvent.type(artist.getByRole('combobox', { name: fieldName('schema:contributor') }), 'Harbour');
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole('option', { name: /The Harbour Ensemble/ }),
    );
    await userEvent.selectOptions(artist.getByRole('combobox', { name: m.relation_qualifier() }), 'wdt:P3831');
    await userEvent.type(artist.getByRole('combobox', { name: fieldName('wdt:P3831') }), 'Performer');
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('option', { name: /Performer/ }));
    await userEvent.type(
      artist.getByRole('textbox', { name: m.relation_citation() }),
      'https://artist.example/harbour',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
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
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: m.relation_property() }),
      'schema:contributor',
    );
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
