import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { GameInitialFacts } from '../features/catalogue/game-profile-fields';
import { GameProfile } from '../features/catalogue/game-profile-view';
import { AddonProfile } from '../features/catalogue/addon-profile-view';
import type { StatementInput } from '../features/catalogue/statement-editor';
import {
  gameId,
  gamePlatformId,
  gameCreatorId,
  gameProfileFixture,
  type GameScenario,
} from '../kernel/fake/catalogue-game-profile';
import { addonProfileFixture, addonWorkId } from '../kernel/fake/catalogue-addon-profile';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';

// All plays authored UNRUN. These are connected supplied-data examples, not native/SSR or geometry evidence.
const releasedName = 'Full released classification — 日本語 العربية ' + 'CatalogueName'.repeat(18);
const citation = 'https://archive.example/game/' + 'complete-original-record-'.repeat(18) + '?exact=A%2Fb#citation';
type Row = { key: string; statement: StatementInput };
type Scenario = GameScenario | 'pending';
function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `supplied-${index}`,
    statement: {
      property: { id: 'schema:inLanguage' },
      value: { type: 'value', content: `日本語 العربية ${'unabridged-value-'.repeat(12)}` },
      qualifiers: [],
      references: [],
      rank: 'normal',
    },
  }));
}
function InitialExample({ count, removed, long }: { count: number; removed: boolean; long: boolean }) {
  const locale = getLocale();
  const release = useMemo(() => {
    const value = gameProfileFixture().release;
    if (long) value.properties['schema:inLanguage']!.labels = { en: releasedName };
    if (removed) delete value.properties['schema:inLanguage'];
    return value;
  }, [removed, long]);
  const [statements, setStatements] = useState(() => {
    const supplied = rows(count);
    if (long && supplied[0]) {
      supplied[0].statement.qualifiers = [
        { property: { id: 'schema:name' }, value: { type: 'value', content: { text: releasedName, language: 'ja' } } },
      ];
      supplied[0].statement.references = [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
      ];
    }
    return supplied;
  });
  return (
    <section data-family-initial className="min-w-0 max-w-full">
      <GameInitialFacts
        type="schema:VideoGame"
        locale={locale}
        release={release}
        disabled={false}
        statements={statements}
        change={setStatements}
        search={async () => []}
      />
    </section>
  );
}
function Family({
  mode = 'initial',
  scenario = 'ready',
  count = 1,
  independent = false,
  removed = false,
  long = false,
  direction = 'ltr',
}: {
  mode?: 'initial' | 'game-create' | 'correction' | 'addon';
  scenario?: Scenario;
  count?: number;
  independent?: boolean;
  removed?: boolean;
  long?: boolean;
  direction?: 'ltr' | 'rtl';
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = gameProfileFixture(scenario === 'pending' ? 'ready' : scenario, locale, mode === 'correction');
    if (long) {
      value.release.properties['schema:gamePlatform']!.labels = { en: releasedName };
      value.publicRead.related[gamePlatformId]!.labels = { en: releasedName };
      if (mode === 'correction')
        value.publicRead.subject.statements['schema:gamePlatform']![0]!.references[0]!.parts[0]!.value = {
          type: 'value',
          content: citation,
        };
    }
    return value;
  }, [scenario, locale, long, mode]);
  const addon = useMemo(() => addonProfileFixture('ready', locale), [locale]);
  return (
    <PatternStory
      path={
        mode === 'addon'
          ? '/catalogue/addon'
          : mode === 'correction'
            ? `/subjects/${gameId}/the-lantern-game/game`
            : '/catalogue/game'
      }
      visitor="Signed In"
    >
      <AppShell>
        <div
          data-game-fields-family
          dir={direction}
          className="mx-auto min-w-0 w-full max-w-4xl space-y-8 p-4 [overflow-wrap:anywhere]"
        >
          {mode === 'initial' ? (
            <>
              <InitialExample count={count} removed={removed} long={long} />
              {independent && <InitialExample count={1} removed={false} long={long} />}
            </>
          ) : mode === 'addon' ? (
            <AddonProfile {...addon.props} locale={locale} work={addonWorkId} />
          ) : (
            <GameProfile
              {...(mode === 'correction' ? { id: gameId } : {})}
              locale={locale}
              session="signed-in"
              onNavigate={() => {}}
              search={async () => [
                { id: gamePlatformId, title: releasedName, types: ['skos:Concept'], typeLabel: '', cover: null },
                { id: gameCreatorId, title: 'Ineligible writer', types: ['schema:Person'], typeLabel: '', cover: null },
              ]}
              transport={{
                ...fixture.transport,
                classifications:
                  scenario === 'pending'
                    ? { ...fixture.transport.classifications, propose: () => new Promise<never>(() => {}) }
                    : fixture.transport.classifications,
              }}
            />
          )}
        </div>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Game fields family',
  component: Family,
  tags: ['autodocs'],
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
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
          'Actual Game initial facts, classification corrections and existing Addon creation caller. All authored plays remain UNRUN. Use phone390/desktop1280, locale and theme globals, and the explicit RTL examples. Fixture requests preserve native envelopes; this source proves no native or visual acceptance.',
      },
    },
  },
} satisfies Meta<typeof Family>;
export default meta;
type Story = StoryObj<typeof meta>;

async function contained(element: HTMLElement) {
  const view = element.ownerDocument.defaultView!;
  const rect = element.getBoundingClientRect();
  await expect(element).toBeVisible();
  await expect(rect.left).toBeGreaterThanOrEqual(0);
  await expect(rect.right).toBeLessThanOrEqual(view.innerWidth + 1);
  await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
}
async function target(element: HTMLElement) {
  await contained(element);
  const view = element.ownerDocument.defaultView!;
  if (view.innerWidth <= 639 && view.matchMedia('(pointer: coarse)').matches) {
    await expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(element.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  } else {
    await expect(element.getBoundingClientRect().height).toBeLessThan(44);
  }
}
async function inspectFrames(canvasElement: HTMLElement) {
  const frames = canvasElement.querySelectorAll<HTMLElement>(
    '[data-slot="game-initial-fact"], [data-slot="game-classification"]',
  );
  for (const frame of frames) {
    await contained(frame);
    const heading = frame.querySelector<HTMLElement>(':scope > [data-content-item-slot="title"]')!;
    await contained(heading);
    await expect(heading.className).not.toMatch(/truncate|line-clamp/);
    await expect(frame.closest('section')).toBe(frame.parentElement);
    for (const element of frame.querySelectorAll<HTMLElement>('p, label, input, select, a, button')) {
      await contained(element);
    }
  }
  await expect(canvasElement.querySelector('a button, button button, a a, [data-slot="list-row-link"]')).toBeNull();
}
export const InitialFacts: Story = {
  args: { long: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('group', { name: m.game_profile_initial() })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: releasedName })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.correction_url() })).toHaveValue(citation);
    await inspectFrames(canvasElement);
  },
};
export const IndependentSelectors: Story = {
  args: { independent: true, long: true },
  play: async ({ canvasElement }) => {
    const mounts = canvasElement.querySelectorAll<HTMLElement>('[data-family-initial]');
    const first = within(mounts[0]!);
    const second = within(mounts[1]!);
    const selectors = [first, second].map((scope) => scope.getByRole('combobox', { name: m.character_add_fact() }));
    await expect(selectors[0]!.id).not.toBe(selectors[1]!.id);
    for (let index = 0; index < 2; index++) {
      const label = [first, second][index]!.getByText(m.character_add_fact(), {
        selector: 'label',
      }) as HTMLLabelElement;
      await expect(label.htmlFor).toBe(selectors[index]!.id);
      await userEvent.click(label);
      await expect(selectors[index]!).toHaveFocus();
      await userEvent.selectOptions(selectors[index]!, 'schema:url');
      await target(selectors[index]!);
      await userEvent.tab();
      await expect([first, second][index]!.getAllByRole('button', { name: m.correction_add() })[0]!).toHaveFocus();
      await userEvent.tab({ shift: true });
      await expect(selectors[index]!).toHaveFocus();
      const focus = canvasElement.ownerDocument.defaultView!.getComputedStyle(selectors[index]!);
      await expect(
        (focus.boxShadow !== '' && focus.boxShadow !== 'none') ||
          (focus.outlineStyle !== 'none' && Number.parseFloat(focus.outlineWidth) > 0),
      ).toBe(true);
      await expect(selectors[index]!).toHaveAccessibleName(m.character_add_fact());
    }
    await userEvent.selectOptions(selectors[0]!, 'schema:url');
    const add = first.getAllByRole('button', { name: m.correction_add() })[0]!;
    await target(add);
    await userEvent.keyboard('{Tab}{Enter}');
    await expect(selectors[0]!).toHaveValue('');
    await expect(selectors[1]!).toHaveValue('schema:url');
    await expect(mounts[0]!.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(2);
    await expect(mounts[1]!.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(1);
    await inspectFrames(canvasElement);
  },
};
export const MultiplicityAndLimit: Story = {
  args: { count: 31 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByRole('combobox', { name: m.character_add_fact() });
    const add = canvas.getByRole('button', { name: m.correction_add() });
    await userEvent.selectOptions(select, 'schema:inLanguage');
    await target(add);
    await userEvent.click(add);
    await expect(canvasElement.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(32);
    await userEvent.selectOptions(select, 'schema:inLanguage');
    await expect(add).toBeDisabled();
    await userEvent.click(canvas.getAllByRole('button', { name: m.recipe_remove_field() })[0]!);
    await expect(add).toBeEnabled();
  },
};
export const RemovedDefinition: Story = {
  args: { removed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.candidate_value_unavailable())).toBeVisible();
    await expect(canvas.getByText(m.correction_preserved())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.recipe_remove_field() })).toBeEnabled();
  },
};
export const EmptyInitial: Story = {
  args: { count: 0 },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="game-initial-fact"]')).toBeNull();
    await expect(within(canvasElement).getByRole('button', { name: m.correction_add() })).toBeDisabled();
  },
};

async function classification(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const summary = (await canvas.findAllByText(m.game_profile_classification(), { selector: 'summary' }))[0]!;
  const article = canvas.getByRole('article');
  const reload = within(article).getByRole('button', { name: m.correction_reload() });
  const facts = article.querySelector<HTMLElement>('details > summary')!;
  reload.focus();
  await userEvent.tab();
  await expect(facts).toHaveFocus();
  await userEvent.tab();
  await expect(summary).toHaveFocus();
  await expect(canvasElement.ownerDocument.defaultView!.getComputedStyle(summary).outlineWidth).not.toBe('0px');
  await userEvent.keyboard('{Enter}');
  await expect(summary.closest('details')).toHaveAttribute('open', '');
  const scope = within(summary.closest('details')!);
  const label = canvasElement.querySelector('[data-slot="game-classification"] > h3')!.textContent!;
  const frame = scope.getByRole('heading', { level: 3, name: label }).closest('section')!;
  const field = within(frame);
  const edit = field.getByRole('button', { name: m.facts_edit_field() });
  const add = scope.getAllByRole('button', { name: m.facts_add_value() })[0]!;
  await target(edit);
  await target(add);
  const submit = scope.getByRole('button', { name: m.facts_submit() });
  await target(submit);
  await userEvent.click(edit);
  await expect(submit).toBeDisabled();
  const value = field.getByRole('textbox', { name: m.correction_value() });
  await expect(value).toHaveValue('ja');
  await userEvent.clear(value);
  await userEvent.type(value, 'fr');
  await expect(submit).toBeEnabled();
  await userEvent.click(submit);
  return { canvas, scope, field, frame, submit, value };
}
export const Proposed: Story = {
  args: { mode: 'correction' },
  play: async ({ canvasElement }) => {
    const { scope, field } = await classification(canvasElement);
    await expect(await field.findByText(m.correction_proposed())).toBeVisible();
    const review = field.getByRole('button', { name: m.correction_review() });
    await target(review);
    await userEvent.click(review);
    await expect(await scope.findByRole('heading', { name: m.candidate_proposed() })).toBeVisible();
    await expect(scope.getByRole('heading', { name: m.candidate_current() })).toBeVisible();
    await expect(scope.getByRole('button', { name: m.candidate_accept() })).toBeEnabled();
  },
};
export const LongClassification: Story = {
  args: { mode: 'correction', long: true },
  play: async ({ canvasElement }) => {
    const { field, frame } = await classification(canvasElement);
    await expect(await field.findByText(m.correction_proposed())).toBeVisible();
    await contained(frame);
    await expect(field.getByRole('heading', { level: 3, name: releasedName })).toBeVisible();
    await expect(field.getByRole('link', { name: citation })).toHaveAttribute('href', citation);
    for (const element of frame.querySelectorAll<HTMLElement>('h3, a, label, input')) await contained(element);
  },
};
export const Pending: Story = {
  args: { mode: 'correction', scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const { frame, submit, value } = await classification(canvasElement);
    await expect(frame.querySelector('fieldset')).toBeDisabled();
    await expect(submit).toBeDisabled();
    await expect(value).toBeDisabled();
    await expect(frame.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  },
};
async function failure(canvasElement: HTMLElement, message: string) {
  const state = await classification(canvasElement);
  await expect(await state.field.findByRole('alert')).toHaveTextContent(message);
  await expect(state.value).toHaveValue('fr');
  await expect(state.field.queryByRole('button', { name: m.correction_review() })).toBeNull();
  return state;
}
export const Denied: Story = {
  args: { mode: 'correction', scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const { field, frame } = await failure(canvasElement, m.correction_denied());
    await userEvent.click(field.getByRole('button', { name: m.catalogue_create_review_new() }));
    await expect(frame.querySelector('fieldset')).toBeEnabled();
  },
};
export const Stale: Story = {
  args: { mode: 'correction', scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const { submit } = await failure(canvasElement, m.correction_stale());
    await expect(submit).toBeDisabled();
  },
};
export const UncertainReplay: Story = {
  args: { mode: 'correction', scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const { field, submit, value } = await failure(canvasElement, m.correction_unavailable());
    await expect(value).toBeDisabled();
    await userEvent.click(submit);
    await expect(await field.findByText(m.correction_proposed())).toBeVisible();
  },
};
export const Unavailable: Story = {
  args: { mode: 'correction', scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(m.correction_unavailable());
    await expect(canvasElement.querySelector('[data-slot="game-classification"]')).toBeNull();
  },
};
export const AddonCompatibility: Story = {
  args: { mode: 'addon' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const useBase = await canvas.findByRole('button', { name: m.addon_use_base() });
    await userEvent.click(useBase);
    const frame = canvasElement.querySelector<HTMLElement>('[data-slot="game-initial-fact"]')!;
    await expect(frame).toBeVisible();
    const property = 'wdt:P8646';
    await expect(
      within(frame).getByRole('heading', {
        level: 2,
        name: pickText(definitions.release.properties[property].labels, getLocale()).text,
      }),
    ).toBeVisible();
    await userEvent.click(within(frame).getByRole('button', { name: m.recipe_remove_field() }));
    await expect(canvasElement.querySelector('[data-slot="game-initial-fact"]')).toBeNull();
    await expect(canvas.getByRole('button', { name: m.addon_use_base() })).toBeEnabled();
  },
};

export const GameCreation: Story = {
  args: { mode: 'game-create' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: m.catalogue_create_type() }),
      'schema:VideoGame',
    );
    await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'The Lantern Game');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:inLanguage');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
    const frame = canvasElement.querySelector<HTMLElement>('[data-slot="game-initial-fact"]')!;
    await userEvent.type(within(frame).getByRole('textbox', { name: m.correction_value() }), 'ja');
    await inspectFrames(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(canvasElement.querySelector('[data-game-create-review]')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(await canvas.findByText(m.catalogue_create_created())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/${getLocale()}/subjects/${gameId}/the-lantern-game`,
    );
  },
};
export const InitialPhone390: Story = {
  ...InitialFacts,
  globals: { viewport: { value: 'phone390', isRotated: false }, locale: 'ja' },
};
export const InitialDesktop1280Rtl: Story = {
  ...IndependentSelectors,
  args: { ...IndependentSelectors.args, direction: 'rtl' },
  globals: { viewport: { value: 'desktop1280', isRotated: false }, locale: 'zh-Hant' },
};
export const ProposedPhone390: Story = {
  ...Proposed,
  globals: { viewport: { value: 'phone390', isRotated: false }, locale: 'ja' },
};
export const LongClassificationDesktop1280Rtl: Story = {
  ...LongClassification,
  args: { ...LongClassification.args, direction: 'rtl' },
  globals: { viewport: { value: 'desktop1280', isRotated: false }, locale: 'zh-Hant' },
};
export const AddonPhone390Rtl: Story = {
  ...AddonCompatibility,
  args: { mode: 'addon', direction: 'rtl' },
  globals: { viewport: { value: 'phone390', isRotated: false }, locale: 'ja' },
};
