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

// Authored UNRUN. These composed, actual-page examples supplement the unchanged canonical stories.
// Browser geometry, native acceptance, publication and private SSR remain separate obligations.
const longName = 'Harbour sessions — 港の演奏 — جلسات الميناء ' + 'CompleteAlbumName'.repeat(10);
const longDescription = 'The complete supplied description 説明 محفوظة كاملة. '.repeat(4);
const longAlias = 'Alternative album name 別名 اسم آخر ' + 'UnabridgedAlias'.repeat(12);
const citation = 'https://artist.example/releases/' + 'original-source-'.repeat(16) + '?language=ja#credits';
type Fixture = ReturnType<typeof albumFixture>;
const mounted = new WeakMap<HTMLElement, Fixture>();

function AlbumCreateFamily({
  scenario = 'ready',
  longMetadata = false,
  signedOut = false,
  pair = false,
  rtl = false,
  metadataFailure = false,
  missingDefinition = false,
}: {
  scenario?: AlbumScenario;
  longMetadata?: boolean;
  signedOut?: boolean;
  pair?: boolean;
  rtl?: boolean;
  metadataFailure?: boolean;
  missingDefinition?: boolean;
}) {
  const locale = getLocale();
  const fixtures = useMemo(
    () =>
      [0, 1].map(() => {
        const fixture = albumFixture(scenario, locale);
        if (longMetadata) {
          for (const id of ['schema:contributor', 'wdt:P1932', 'schema:datePublished', 'schema:genre']) {
            const property = fixture.release.properties[id]!;
            property.labels = {
              [locale]: `${pickText(property.labels, locale).text} — ${'Full released name 名称 الاسم '.repeat(8)}`,
            };
            property.descriptions = { [locale]: longDescription };
          }
        }
        return fixture;
      }),
    [scenario, locale, longMetadata],
  );
  const transports = useMemo(
    () =>
      fixtures.map((fixture) => ({
        ...fixture.transport,
        load: async () => {
          if (fixture.calls.some((call) => call.method === 'POST')) {
            if (metadataFailure) return { ok: false as const, reason: 'unavailable' as const };
            if (missingDefinition) delete fixture.release.properties['schema:datePublished'];
          }
          return fixture.transport.load();
        },
      })),
    [fixtures, metadataFailure, missingDefinition],
  );
  return (
    <PatternStory path="/catalogue/album" visitor={signedOut ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <div dir={rtl ? 'rtl' : undefined} className="min-w-0">
          {fixtures.slice(0, pair ? 2 : 1).map((fixture, index) => (
            <div
              key={index}
              ref={(node) => {
                if (node) mounted.set(node, fixture);
              }}
              data-album-create-example={index}
            >
              <AlbumProfile
                locale={locale}
                session={signedOut ? 'signed-out' : 'signed-in'}
                transport={transports[index]!}
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
            </div>
          ))}
        </div>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Album creation family',
  component: AlbumCreateFamily,
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
          'UNRUN: whole Album creation using the existing generated-client fixture. Run these same journeys at phone390 and desktop1280, locale/theme globals and RTL. No new native or geometry proof is claimed.',
      },
    },
  },
} satisfies Meta<typeof AlbumCreateFamily>;
export default meta;
type Story = StoryObj<typeof meta>;
const fixtureFor = (element: HTMLElement) =>
  mounted.get(element.querySelector<HTMLElement>('[data-album-create-example]')!)!;
const name = (fixture: Fixture, id: string) => pickText(fixture.release.properties[id]?.labels ?? {}, getLocale()).text;
const writes = (fixture: Fixture) => fixture.calls.filter((call) => call.method === 'POST');

async function add(element: HTMLElement, id: string) {
  const canvas = within(element);
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), id);
  await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
  return within([...element.querySelectorAll<HTMLElement>('fieldset[id^="album-row-"]')].at(-1)!);
}
async function fill(element: HTMLElement, complete = false) {
  const canvas = within(element);
  const fixture = fixtureFor(element);
  const language = await canvas.findByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), longName);
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_description() }), longDescription);
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_aliases() }), `${longAlias}\n港の別名`);
  const date = await add(element, 'schema:datePublished');
  await userEvent.selectOptions(date.getByRole('combobox', { name: m.correction_precision() }), '9');
  await userEvent.type(date.getByRole('textbox', { name: m.correction_year() }), '2024');
  await userEvent.type(date.getByRole('textbox', { name: m.relation_citation() }), citation);
  if (complete) {
    const external = await add(element, 'schema:sameAs');
    await userEvent.type(external.getByRole('textbox', { name: m.correction_url() }), citation);
    await expect(external.getByText(citation, { selector: 'p' })).toBeVisible();
    const credit = await add(element, 'schema:contributor');
    await userEvent.type(credit.getByRole('combobox', { name: name(fixture, 'schema:contributor') }), 'Harbour');
    await userEvent.click(
      await within(element.ownerDocument.body).findByRole('option', { name: /The Harbour Ensemble/ }),
    );
    await userEvent.selectOptions(credit.getByRole('combobox', { name: m.relation_qualifier() }), 'wdt:P1932');
    await userEvent.click(credit.getByRole('button', { name: m.relation_add_qualifier() }));
    await userEvent.type(credit.getByRole('textbox', { name: name(fixture, 'wdt:P1932') }), longAlias);
    await userEvent.selectOptions(credit.getByRole('combobox', { name: m.relation_qualifier() }), 'wdt:P3831');
    await userEvent.click(credit.getByRole('button', { name: m.relation_add_qualifier() }));
    await userEvent.type(credit.getByRole('combobox', { name: name(fixture, 'wdt:P3831') }), 'Performer');
    const popup = within(element.ownerDocument.body);
    await popup.findByRole('option', { name: /Performer/ });
    await expect(popup.queryByRole('option', { name: /The Harbour Ensemble/ })).toBeNull();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await userEvent.type(credit.getByRole('textbox', { name: m.relation_citation() }), citation);
    const relation = await add(element, 'wdt:P179');
    await userEvent.type(relation.getByRole('combobox', { name: name(fixture, 'wdt:P179') }), 'Harbour');
    await userEvent.click(await popup.findByRole('option', { name: /Harbour concerts/ }));
    const classification = await add(element, 'schema:genre');
    await userEvent.type(classification.getByRole('combobox', { name: name(fixture, 'schema:genre') }), 'Performer');
    await userEvent.click(await popup.findByRole('option', { name: /Performer/ }));
  }
  return canvas;
}

// Real browser line boxes and focus oracles; DOM-only mounted regression does not establish these facts.
async function geometry(canvasElement: HTMLElement) {
  const owner = canvasElement.querySelector<HTMLElement>('[data-album-create-example]')!;
  const element = owner.querySelector<HTMLElement>('form') ?? owner.querySelector('code')!.closest('section')!;
  const document = element.ownerDocument;
  await expect([390, 1280]).toContain(document.documentElement.clientWidth);
  for (const panel of element.querySelectorAll<HTMLElement>(
    'form, fieldset, h2, h3, [data-content-item-slot="preview"], code',
  )) {
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    await expect(panel.className).not.toMatch(/truncate|line-clamp/);
  }
  for (const control of element.querySelectorAll<HTMLElement>('input, textarea, select, button, form a, section a')) {
    const box = control.getBoundingClientRect();
    await expect(box.width).toBeGreaterThanOrEqual(44);
    if (document.documentElement.clientWidth === 390) await expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(box.left).toBeGreaterThanOrEqual(-1);
    await expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  }
  for (const text of element.querySelectorAll<HTMLElement>('label, h2, h3, code, button, a, p[dir="ltr"]')) {
    const box = text.getBoundingClientRect();
    const walker = document.createTreeWalker(text, 4);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) {
        await expect(line.left).toBeGreaterThanOrEqual(box.left - 1);
        await expect(line.right).toBeLessThanOrEqual(box.right + 1);
        await expect(line.bottom).toBeLessThanOrEqual(box.bottom + 1);
      }
    }
  }
  const target = element.querySelector<HTMLElement>('input, a')!;
  target.focus();
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  await expect(target).toHaveFocus();
  const style = document.defaultView!.getComputedStyle(target);
  await expect(
    (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none',
  ).toBe(true);
}

export const TermsCreditsAndFacts: Story = {
  args: { longMetadata: true },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    await fill(canvasElement, true);
    const fixture = fixtureFor(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: m.catalogue_create_terms() })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 3, name: name(fixture, 'schema:contributor') })).toBeVisible();
    const field = canvas.getByRole('combobox', { name: m.character_add_fact() });
    await expect(within(field).queryByRole('option', { name: name(fixture, 'schema:datePublished') })).toBeNull();
    await expect(within(field).getByRole('option', { name: name(fixture, 'schema:contributor') })).toBeInTheDocument();
    await geometry(canvasElement);
    await expect(writes(fixture)).toHaveLength(0);
  },
};
export const TermsCreditsAndFactsDesktop: Story = {
  ...TermsCreditsAndFacts,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const TermsCreditsAndFactsRTL: Story = {
  ...TermsCreditsAndFactsDesktop,
  args: { longMetadata: true, rtl: true },
};
export const TermsCreditsAndFactsPhoneRTL: Story = {
  ...TermsCreditsAndFacts,
  args: { longMetadata: true, rtl: true },
};
export const IndependentLanguageRows: Story = {
  args: { pair: true },
  play: async ({ canvasElement }) => {
    const [first, second] = [...canvasElement.querySelectorAll<HTMLElement>('[data-album-create-example]')];
    const a = within(first!);
    const b = within(second!);
    const initial = await a.findByRole('textbox', { name: m.catalogue_create_language() });
    const other = await b.findByRole('textbox', { name: m.catalogue_create_language() });
    await expect(initial.id).not.toBe(other.id);
    const addLanguage = a.getByRole('button', { name: m.catalogue_create_add_language() });
    await userEvent.click(addLanguage);
    await userEvent.click(addLanguage);
    const languages = a.getAllByRole('textbox', { name: m.catalogue_create_language() });
    const retained = languages[2]!;
    await userEvent.type(retained, 'ja');
    const remove = a.getAllByRole('button', { name: m.catalogue_create_remove_language() })[0]!;
    remove.focus();
    await userEvent.keyboard('{Enter}');
    await expect(retained).toHaveFocus();
    await expect(a.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(2);
    await userEvent.click(a.getByRole('button', { name: m.catalogue_create_remove_language() }));
    await expect(addLanguage).toHaveFocus();
    await expect(b.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(1);
    await expect(writes(mounted.get(first!)!)).toHaveLength(0);
    await expect(writes(mounted.get(second!)!)).toHaveLength(0);
  },
};
const failureStory = (scenario: AlbumScenario, message: () => string): Story => ({
  args: { scenario },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    await expect(await canvas.findByText(message())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.catalogue_create_review_new() })).toBeEnabled();
    await expect(writes(fixtureFor(canvasElement))).toHaveLength(1);
  },
});
export const Denied = failureStory('denied', () => m.catalogue_create_denied());
export const Conflict = failureStory('conflict', () => m.catalogue_create_conflict());
export const StaleMetadata: Story = {
  ...failureStory('stale-metadata', () => m.catalogue_create_invalid()),
  play: async ({ canvasElement }) => {
    const filled = await fill(canvasElement);
    await userEvent.click(filled.getByRole('button', { name: m.album_create() }));
    await expect(await filled.findByText(m.catalogue_create_invalid())).toBeVisible();
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.correction_stale())).toBeVisible();
    const anchor = canvasElement.querySelector<HTMLAnchorElement>('a[href^="#album-row-"]')!;
    await expect(canvasElement.ownerDocument.getElementById(anchor.hash.slice(1))).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_review_new() }));
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeEnabled();
  },
};
export const MissingDefinition: Story = {
  ...failureStory('invalid', () => m.catalogue_create_invalid()),
  args: { scenario: 'invalid', missingDefinition: true },
};
export const MetadataFailure: Story = {
  ...failureStory('invalid', () => m.catalogue_create_invalid()),
  args: { scenario: 'invalid', metadataFailure: true },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    await expect(await canvas.findByText(m.album_missing())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_review_new() }));
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.correction_reload() })).toBeEnabled();
  },
};
export const UncertainExactReplay: Story = {
  args: { scenario: 'uncertain' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement, true);
    const fixture = fixtureFor(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    const retained = structuredClone(writes(fixture)[0]);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(writes(fixture)[1]).toEqual(retained);
    await expect(canvas.getByText(albumId, { selector: 'code' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/${getLocale()}/subjects/${albumId}/`),
    );
    await geometry(canvasElement);
  },
};
export const CreatedReaderRecovery: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    const fixture = fixtureFor(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    await expect(canvas.getByText(albumId, { selector: 'code' })).toBeVisible();
    fixture.setScenario('concealed');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
    fixture.setScenario('ready');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/subjects/${albumId}/`),
    );
    await expect(writes(fixture)).toHaveLength(1);
  },
};
export const ReleasedTypeAbsent: Story = { args: { scenario: 'empty' } };
export const DefinitionsUnavailable: Story = { args: { scenario: 'unavailable' } };
export const SignedOut: Story = { args: { signedOut: true } };

export const CreatedExactReferenceRTL: Story = {
  ...UncertainExactReplay,
  args: { scenario: 'uncertain', rtl: true },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const CreatedExactReferenceDesktop: Story = {
  ...UncertainExactReplay,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const CreatedExactReferencePhoneRTL: Story = {
  ...UncertainExactReplay,
  args: { scenario: 'uncertain', rtl: true },
};
export const InitialFieldRemovalAndMultiplicity: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    const fixture = fixtureFor(canvasElement);
    const date = canvas.getByRole('group', { name: name(fixture, 'schema:datePublished') });
    await userEvent.click(within(date).getByRole('button', { name: m.recipe_remove_field() }));
    await expect(date).not.toBeInTheDocument();
    const choices = canvas.getByRole('combobox', { name: m.character_add_fact() });
    await expect(
      within(choices).getByRole('option', { name: name(fixture, 'schema:datePublished') }),
    ).toBeInTheDocument();
    await add(canvasElement, 'schema:contributor');
    await add(canvasElement, 'schema:contributor');
    const credits = canvas.getAllByRole('group', { name: name(fixture, 'schema:contributor') });
    await expect(credits).toHaveLength(2);
    await userEvent.click(within(credits[0]!).getByRole('button', { name: m.recipe_remove_field() }));
    await expect(credits[1]).toBeInTheDocument();
    await expect(writes(fixture)).toHaveLength(0);
  },
};
export const InvalidTermsAnchors: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    await expect(await canvas.findByText(m.catalogue_create_invalid())).toBeVisible();
    const links = canvasElement.querySelectorAll<HTMLAnchorElement>('a[href="#album-terms"]');
    await expect(links.length).toBeGreaterThan(0);
    for (const link of links)
      await expect(canvasElement.ownerDocument.getElementById(link.hash.slice(1))).not.toBeNull();
    await expect(writes(fixtureFor(canvasElement))).toHaveLength(0);
  },
};
export const ReviewNewAttempt: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    const fixture = fixtureFor(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    await expect(await canvas.findByText(m.catalogue_create_denied())).toBeVisible();
    const first = structuredClone(writes(fixture)[0]!);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_review_new() }));
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue(longName);
    await expect(writes(fixture)).toHaveLength(1);
    fixture.setScenario('ready');
    await userEvent.click(canvas.getByRole('button', { name: m.album_create() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(writes(fixture)[1]!.key).not.toBe(first.key);
  },
};
