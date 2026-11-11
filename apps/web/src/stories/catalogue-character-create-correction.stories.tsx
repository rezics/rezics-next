import { chooseSelectValue } from './select-option';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useRef, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { CharacterProfile } from '../features/catalogue/character-profile-view';
import type { CharacterCommand, CharacterTransport } from '../features/catalogue/character-profile';
import { characterProfileFixture } from '../kernel/fake/catalogue-character-profile';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type Scenario = 'ready' | 'general' | 'conflict' | 'uncertain' | 'retirement';
function Example({
  scenario = 'ready',
  onAttempt,
}: {
  scenario?: Scenario;
  onAttempt?: (command: CharacterCommand) => void;
}) {
  const locale = getLocale();
  const [admitted, setAdmitted] = useState(true);
  const attempts = useRef(0);
  const fixture = useMemo(
    () => characterProfileFixture(scenario === 'uncertain' ? 'uncertain' : 'ready', locale),
    [scenario, locale],
  );
  const transport = useMemo<CharacterTransport>(
    () => ({
      ...fixture.transport,
      create: async (command) => {
        onAttempt?.(structuredClone(command));
        attempts.current++;
        // Illustrative native-shaped adapter refusals, not recorded native acceptance.
        if (scenario === 'general')
          return {
            ok: false,
            reason: 'invalid',
            refreshDefinitions: true,
            errors: [
              { pointer: '', code: 'out_of_range' },
              { pointer: '/statements/schema:height/9/value/content/amount', code: 'required' },
              { pointer: '/future/value~1with~0escapes', code: 'unsupported' },
            ],
          };
        if (scenario === 'conflict' && attempts.current === 1) return { ok: false, reason: 'conflict' };
        return fixture.transport.create(command);
      },
    }),
    [fixture, scenario, onAttempt],
  );
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        {scenario === 'retirement' && (
          <button type="button" onClick={() => setAdmitted(!admitted)}>
            {admitted ? 'Retire current permission (fixture)' : 'Restore current permission (fixture)'}
          </button>
        )}
        <CandidateReaderBoundary
          address="character-create-correction"
          observed={
            admitted
              ? { state: 'signed-in', subject: 'character-correction-fixture', csrfToken: 'fixture-epoch' }
              : { state: 'signed-out', csrfToken: null }
          }
        >
          <CharacterProfile
            locale={locale}
            {...fixture.props}
            session={admitted ? 'signed-in' : 'signed-out'}
            transport={transport}
          />
        </CandidateReaderBoundary>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Character create correction',
  id: 'pages-catalogue-character-create-correction',
  component: Example,
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
          'UNRUN authored production CharacterProfile/Create journeys with existing native-shaped synthetic fixtures. All locales, themes and phone/desktop viewports apply. Native, browser, visual, SSR and growth acceptance are deferred; these are illustrative fixtures, not recordings or proof.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const observer = () => fn<(command: CharacterCommand) => void>();
async function draft(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const name = await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
  await userEvent.type(name, '旅人 — A new traveler');
  return { canvas, name };
}
async function submit(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: m.character_create() }));
}
async function corrections(canvasElement: HTMLElement) {
  const region = await within(canvasElement).findByRole('region', { name: m.character_create_correction_summary() });
  const links = within(region).getAllByRole('link');
  for (const link of links) {
    const target = canvasElement.ownerDocument.getElementById(decodeURIComponent(link.getAttribute('href')!.slice(1)))!;
    await expect(target).toHaveAttribute('aria-invalid', 'true');
    await expect(target.getAttribute('aria-describedby')?.split(' ')).toContain(link.closest('li')!.id);
    link.focus();
    await userEvent.keyboard('{Enter}');
    await expect(target).toHaveFocus();
  }
  return region;
}
export const InvalidLanguage: Story = {
  args: { onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const { canvas, name } = await draft(canvasElement);
    const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
    await userEvent.clear(language);
    await userEvent.type(language, 'english/日本語~');
    await submit(canvasElement);
    const region = await corrections(canvasElement);
    await expect(region).toHaveTextContent(m.catalogue_create_validation_language());
    await expect(name).toHaveValue('旅人 — A new traveler');
    await expect(args.onAttempt).not.toHaveBeenCalled();
    await userEvent.clear(language);
    await userEvent.type(language, 'en');
    await submit(canvasElement);
    await expect(await canvas.findByRole('link', { name: m.character_correct() })).toBeVisible();
    await expect(args.onAttempt).toHaveBeenCalledTimes(1);
  },
};
export const InvalidNameAndDescription: Story = {
  args: { onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.catalogue_create_description() }),
      '長い説明'.repeat(70),
    );
    await submit(canvasElement);
    const region = await corrections(canvasElement);
    await expect(region).toHaveTextContent(m.catalogue_create_validation_name_required());
    await expect(region).toHaveTextContent(m.catalogue_create_validation_description_length());
    await expect(args.onAttempt).not.toHaveBeenCalled();
  },
};
export const InvalidInitialFact: Story = {
  args: { onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const { canvas, name } = await draft(canvasElement);
    await chooseSelectValue(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:height');
    await userEvent.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    await submit(canvasElement);
    await corrections(canvasElement);
    await expect(name).toHaveValue('旅人 — A new traveler');
    await expect(args.onAttempt).not.toHaveBeenCalled();
    await userEvent.type(canvas.getByRole('textbox', { name: m.correction_amount() }), '+170');
    await chooseSelectValue(
      canvas.getByRole('combobox', { name: m.correction_unit() }),
      'http://www.wikidata.org/entity/Q174728',
    );
    await submit(canvasElement);
    await expect(await canvas.findByRole('link', { name: m.character_correct() })).toBeVisible();
  },
};
export const GeneralPointer: Story = {
  args: { scenario: 'general', onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const { canvas, name } = await draft(canvasElement);
    await submit(canvasElement);
    const region = await canvas.findByRole('region', { name: m.character_create_correction_summary() });
    await expect(within(region).queryAllByRole('link')).toHaveLength(0);
    await expect(region).toHaveTextContent(m.character_create_correction_fallback());
    await expect(name).toHaveValue('旅人 — A new traveler');
    const details = region.parentElement!.querySelector('details')!;
    await expect(details.open).toBe(false);
    details.querySelector('summary')!.focus();
    await userEvent.keyboard('{Enter}');
    await expect(details.open).toBe(true);
    await expect(details).toHaveTextContent('/future/value~1with~0escapes');
    await expect(args.onAttempt).toHaveBeenCalledTimes(1);
  },
};
export const ConflictReview: Story = {
  args: { scenario: 'conflict', onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const { canvas, name } = await draft(canvasElement);
    await submit(canvasElement);
    await expect(await canvas.findByText(m.correction_stale())).toBeVisible();
    await expect(name).toBeDisabled();
    await expect(canvas.queryByRole('region', { name: m.character_create_correction_summary() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_review_new() }));
    await expect(name).toHaveValue('旅人 — A new traveler');
    await submit(canvasElement);
    await canvas.findByRole('link', { name: m.character_correct() });
    const calls = (args.onAttempt as ReturnType<typeof observer>).mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0].key).not.toBe(calls[0]![0].key);
    await expect(calls[1]![0].item).toEqual(calls[0]![0].item);
  },
};
export const UncertainExactRetry: Story = {
  args: { scenario: 'uncertain', onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const { canvas, name } = await draft(canvasElement);
    await submit(canvasElement);
    await expect(await canvas.findByText(m.correction_unavailable())).toBeVisible();
    await expect(name).toBeDisabled();
    await expect(canvas.queryByRole('region', { name: m.character_create_correction_summary() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
    await canvas.findByRole('link', { name: m.character_correct() });
    const calls = (args.onAttempt as ReturnType<typeof observer>).mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0]).toEqual(calls[0]![0]);
  },
};
export const CurrentPermissionRetirement: Story = {
  args: { scenario: 'retirement', onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const { canvas } = await draft(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    await submit(canvasElement);
    await corrections(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Retire current permission (fixture)' }));
    await expect(canvas.queryByRole('region', { name: m.character_create_correction_summary() })).toBeNull();
    await expect(canvas.queryByRole('textbox', { name: m.catalogue_create_label() })).toBeNull();
    await expect(args.onAttempt).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Restore current permission (fixture)' }));
    await expect(await canvas.findByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('');
  },
};
export const ManyCurrentFields: Story = {
  args: { onAttempt: observer() },
  play: async ({ canvasElement, args }) => {
    const { canvas } = await draft(canvasElement);
    for (let index = 1; index < 16; index++) {
      await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
      await userEvent.type(
        canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })[index]!,
        `en-x${index}`,
      );
      await userEvent.type(
        canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[index]!,
        `旅人 — Traveler ${index}`,
      );
    }
    const descriptions = canvas.getAllByRole('textbox', { name: m.catalogue_create_description() });
    for (const description of descriptions)
      await userEvent.type(description, '長い説明・한국어・Beschreibung'.repeat(14));
    await submit(canvasElement);
    await corrections(canvasElement);
    const ids = Array.from(canvasElement.querySelectorAll('[id]'), (element) => element.id);
    await expect(new Set(ids).size).toBe(ids.length);
    await expect(args.onAttempt).not.toHaveBeenCalled();
    await userEvent.click(canvas.getAllByRole('button', { name: m.catalogue_create_remove_language() })[7]!);
    await userEvent.click(canvas.getAllByRole('button', { name: m.catalogue_create_remove_language() })[7]!);
    await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(15);
    await expect(args.onAttempt).not.toHaveBeenCalled();
  },
};
