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
}: {
  scenario?: GameScenario;
  correction?: boolean;
  type?: string;
  signedOut?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(
    () => gameProfileFixture(scenario, locale, correction, type),
    [scenario, locale, correction, type],
  );
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
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:gamePlatform');
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
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('The Lantern Game');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
  },
};
async function refused(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
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
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
  },
};
export const Proposed: Story = {
  args: { correction: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = m.game_profile_classification();
    const [summary] = await canvas.findAllByText(name, { selector: 'summary' });
    await userEvent.click(summary!);
    const region = within(summary!.closest('details')!);
    const platformLabel = pickText(definitions.release.properties['schema:gamePlatform'].labels, getLocale()).text;
    const platform = within(region.getByRole('heading', { name: platformLabel }).closest('section')!);
    await userEvent.click(platform.getByRole('button', { name: m.facts_edit_field() }));
    const value = platform.getByRole('textbox', { name: m.correction_value() });
    await userEvent.clear(value);
    await userEvent.type(value, 'fr');
    await userEvent.click(region.getByRole('button', { name: m.facts_submit() }));
    await expect(await platform.findByText(m.correction_proposed())).toBeVisible();
    await userEvent.click(platform.getByRole('button', { name: m.correction_review() }));
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
