import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo, useState } from 'react';
import { pickText } from '@rezics/composition';
import { GameProfile } from '../features/catalogue/game-profile-view';
import {
  gameId,
  gameCreatorId,
  gamePlatformId,
  gameWorkId,
  gameProfileFixture,
  type GameScenario,
} from '../kernel/fake/catalogue-game-profile';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';

function GameStory({
  scenario = 'ready',
  correction = false,
  type = 'schema:VideoGame',
  signedOut = false,
  longIdentity = false,
}: {
  scenario?: GameScenario;
  correction?: boolean;
  type?: string;
  signedOut?: boolean;
  longIdentity?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = gameProfileFixture(scenario, locale, correction, type);
    if (longIdentity) {
      value.publicRead.subject.labels = {
        en:
          'The Lantern Game — an extensively documented original work with a very long unbroken title ' +
          'Lantern'.repeat(24),
        ar: 'لعبة الفانوس ذات الاسم الطويل والمراجع الكاملة',
      };
      value.publicRead.subject.descriptions = {
        en: 'A constructed long description for wrapping and complete term disclosure. '.repeat(5),
        fr: 'Description sans nom français, conservée intégralement.',
      };
      value.publicRead.subject.aliases = {
        en: ['The complete alternative title ' + 'Lantern'.repeat(20)],
        ja: ['灯りのゲームの別名'],
      };
      value.release.types[type]!.labels = {
        en: 'An unusually long released game kind label ' + 'Catalogue'.repeat(24),
      };
    }
    return value;
  }, [scenario, locale, correction, type, longIdentity]);
  const [href, setHref] = useState('');
  return (
    <PatternStory
      path={correction ? `/subjects/${gameId}/the-lantern-game/game` : '/catalogue/game'}
      visitor={signedOut ? 'Signed Out' : 'Signed In'}
    >
      <AppShell>
        <GameProfile
          {...(correction ? { id: gameId } : {})}
          locale={locale}
          session={signedOut ? 'signed-out' : 'signed-in'}
          transport={fixture.transport}
          onNavigate={setHref}
          search={async () => [
            { id: gameCreatorId, title: 'Example writer', types: ['schema:Person'], typeLabel: '', cover: null },
            { id: gamePlatformId, title: 'Example platform', types: ['skos:Concept'], typeLabel: '', cover: null },
            { id: gameWorkId, title: 'The Lantern Work', types: ['schema:VideoGame'], typeLabel: '', cover: null },
          ]}
        />
        {href && <a href={href}>{m.candidate_view_public()}</a>}
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Game and visual-novel work editor',
  component: GameStory,
  tags: ['autodocs'],
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
          'Actual emitted game/VN work, add-on and software-release metadata. Declared request fixtures exercise the integrated form and native proposal envelopes; native acceptance and Web visual review remain pending. Locale, viewport and theme use globals. Terms uses the existing adapter; its pending native producer remains unavailable.',
      },
    },
  },
} satisfies Meta<typeof GameStory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(
    await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
    'schema:VideoGame',
  );
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'The Lantern Game');
  return canvas;
}
export const Ready: Story = {};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const Correction: Story = { args: { correction: true } };
export const VisualNovel: Story = { args: { correction: true, type: 'wd:Q689445' } };
export const SoftwareRelease: Story = { args: { correction: true, type: 'wd:Q20631656' } };
export const AddOn: Story = { args: { correction: true, type: 'wd:Q209163' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Concealed: Story = { args: { correction: true, scenario: 'concealed' } };
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: m.character_add_fact() }),
      'schema:gamePlatform',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    const label = pickText(definitions.release.properties['schema:gamePlatform'].labels, getLocale()).text;
    const row = within(canvas.getByRole('heading', { name: label }).closest('section')!);
    await userEvent.type(row.getByRole('combobox', { name: label }), 'Example platform');
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole('option', { name: /Example platform/ }),
    );
    await userEvent.selectOptions(
      row.getByRole('combobox', { name: m.correction_add_qualifier() }),
      'schema:inLanguage',
    );
    await userEvent.click(row.getByRole('button', { name: m.correction_add() }));
    await userEvent.type(row.getByRole('textbox', { name: m.correction_value() }), 'ja');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(canvasElement.querySelector('[data-game-create-review]')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/en/subjects/${gameId}/the-lantern-game`.replace('/en/', `/${getLocale()}/`),
    );
  },
};
export const Retry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(canvasElement.querySelector('[data-game-create-review]')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('The Lantern Game');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
  },
};
async function refused(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  await expect(canvasElement.querySelector('[data-game-create-review]')).not.toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  await expect(await canvas.findByRole('alert')).toBeVisible();
  await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('The Lantern Game');
}
export const Denied: Story = { args: { scenario: 'denied' }, play: ({ canvasElement }) => refused(canvasElement) };
export const Invalid: Story = { args: { scenario: 'invalid' }, play: ({ canvasElement }) => refused(canvasElement) };
export const Conflict: Story = { args: { scenario: 'conflict' }, play: ({ canvasElement }) => refused(canvasElement) };
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(canvasElement.querySelector('[data-game-create-review]')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
  },
};
export const Proposed: Story = {
  args: { correction: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = m.game_profile_classification();
    const [summary] = await canvas.findAllByText(name, { selector: 'summary' });
    const article = canvas.getByRole('article');
    const view = canvasElement.ownerDocument.defaultView;
    if (!view) throw new Error('Game profile story requires a browser window.');
    const viewportWidth = view.innerWidth;
    const coarsePointer = view.matchMedia('(pointer: coarse)').matches;
    const largeTouchTargets = viewportWidth <= 639 && coarsePointer;
    const bounds = article.getBoundingClientRect();
    const contained = async (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      await expect(element).toBeVisible();
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right);
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      await expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);
    };
    const target = async (element: HTMLElement) => {
      await contained(element);
      if (largeTouchTargets) {
        await expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await expect(element.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      } else {
        await expect(element.getBoundingClientRect().height).toBeLessThan(44);
      }
    };
    const navigation = article.querySelector('nav');
    if (!navigation) throw new Error('Game profile navigation is missing.');
    await contained(navigation);
    const publicProfile = within(navigation).getByRole('link', { name: m.candidate_view_public() });
    const reload = within(navigation).getByRole('button', { name: m.correction_reload() });
    await target(publicProfile);
    await target(reload);
    const factsSummary = article.querySelector<HTMLElement>('details > summary');
    if (!factsSummary) throw new Error('Game profile facts disclosure is missing.');
    await target(factsSummary);
    await target(summary!);

    reload.focus();
    await userEvent.tab();
    await expect(factsSummary).toHaveFocus();
    await userEvent.tab();
    await expect(summary!).toHaveFocus();
    await expect(view.getComputedStyle(summary!).outlineWidth).not.toBe('0px');
    await userEvent.keyboard('{Enter}');
    await expect(summary!.closest('details')).toHaveAttribute('open', '');

    const region = within(summary!.closest('details')!);
    const platformLabel = pickText(definitions.release.properties['schema:gamePlatform'].labels, getLocale()).text;
    const platform = within(region.getByRole('heading', { name: platformLabel }).closest('section')!);
    await target(platform.getByRole('button', { name: m.facts_edit_field() }));
    await target(region.getAllByRole('button', { name: m.facts_add_value() })[0]!);
    await target(region.getByRole('button', { name: m.facts_submit() }));
    await userEvent.click(platform.getByRole('button', { name: m.facts_edit_field() }));
    const value = platform.getByRole('textbox', { name: m.correction_value() });
    await userEvent.clear(value);
    await userEvent.type(value, 'fr');
    await userEvent.click(region.getByRole('button', { name: m.facts_submit() }));
    await expect(await platform.findByText(m.correction_proposed())).toBeVisible();
    const review = platform.getByRole('button', { name: m.correction_review() });
    await target(review);
    await userEvent.click(review);
    await userEvent.click(region.getByRole('button', { name: m.candidate_entry() }));
    await expect(await region.findByText(m.candidate_proposed())).toBeVisible();
  },
};
export const Stale: Story = {
  args: { correction: true, scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [summary] = await canvas.findAllByText(m.game_profile_classification(), { selector: 'summary' });
    await userEvent.click(summary!);
    const region = within(summary!.closest('details')!);
    const platformLabel = pickText(definitions.release.properties['schema:gamePlatform'].labels, getLocale()).text;
    const platform = within(region.getByRole('heading', { name: platformLabel }).closest('section')!);
    await userEvent.click(platform.getByRole('button', { name: m.facts_edit_field() }));
    const value = platform.getByRole('textbox', { name: m.correction_value() });
    await userEvent.clear(value);
    await userEvent.type(value, 'fr');
    await userEvent.click(region.getByRole('button', { name: m.facts_submit() }));
    await expect(await platform.findByText(m.correction_stale())).toBeVisible();
  },
};

// UNRUN illustrative correction states; these use the default production composition and existing request seam.
export const CorrectionLongIdentity: Story = {
  args: { correction: true, longIdentity: true },
  play: ({ canvasElement }) => inspectCorrectionIdentity(canvasElement),
};
export const CorrectionSignedOut: Story = { args: { correction: true, signedOut: true } };
export const CorrectionLoading: Story = { args: { correction: true, scenario: 'loading' } };
export const CorrectionUnavailable: Story = { args: { correction: true, scenario: 'unavailable' } };
async function correctionFailure(canvasElement: HTMLElement, message: string) {
  const canvas = within(canvasElement);
  const [summary] = await canvas.findAllByText(m.game_profile_classification(), { selector: 'summary' });
  await userEvent.click(summary!);
  const region = within(summary!.closest('details')!);
  const platformLabel = pickText(definitions.release.properties['schema:gamePlatform'].labels, getLocale()).text;
  const field = within(region.getByRole('heading', { name: platformLabel }).closest('section')!);
  await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
  const value = field.getByRole('textbox', { name: m.correction_value() });
  await userEvent.clear(value);
  await userEvent.type(value, 'fr');
  await userEvent.click(region.getByRole('button', { name: m.facts_submit() }));
  await expect(await field.findByText(message)).toBeVisible();
  await expect(value).toHaveValue('fr');
}
export const CorrectionDenied: Story = {
  args: { correction: true, scenario: 'denied' },
  play: ({ canvasElement }) => correctionFailure(canvasElement, m.correction_denied()),
};
export const CorrectionUncertain: Story = {
  args: { correction: true, scenario: 'uncertain' },
  // The existing classification editor presents a lost response with its generic failure message.
  play: ({ canvasElement }) => correctionFailure(canvasElement, m.correction_unavailable()),
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
      gameId,
      'schema:VideoGame',
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
