import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { CharacterProfile } from '../features/catalogue/character-profile-view';
import type { CharacterCommand, CharacterTransport } from '../features/catalogue/character-profile';
import { characterProfileFixture, type CharacterScenario } from '../kernel/fake/catalogue-character-profile';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type Variant = 'released' | 'long' | 'removed' | 'conflict';
function Instance({
  scenario,
  variant,
  onAttempt,
}: {
  scenario: CharacterScenario;
  variant: Variant;
  onAttempt?: ((command: CharacterCommand) => void) | undefined;
}) {
  const locale = getLocale();
  const [admitted, setAdmitted] = useState(scenario !== 'signed-out');
  const fixture = useMemo(() => characterProfileFixture(scenario, locale), [scenario, locale]);
  const transport = useMemo<CharacterTransport>(() => {
    let loads = 0;
    let attempts = 0;
    return {
      ...fixture.transport,
      load: async (address) => {
        const read = await fixture.transport.load(address);
        loads++;
        if (!read.ok || variant === 'released' || variant === 'conflict') return read;
        const supplied = structuredClone(read);
        if (variant === 'long') {
          supplied.release.properties['schema:url']!.labels = { ja: `参照 URL ${'SansEspacesLongName'.repeat(12)}` };
          supplied.release.properties['schema:url']!.descriptions = { ja: `完全な説明 ${'FullMeaning '.repeat(22)}` };
        }
        if (variant === 'removed' && loads > 1) delete supplied.release.properties['schema:url'];
        return supplied;
      },
      create: async (command) => {
        onAttempt?.(structuredClone(command));
        attempts++;
        if (variant === 'conflict' && attempts === 1) return { ok: false, reason: 'conflict' };
        if (variant === 'removed')
          return {
            ok: false,
            reason: 'invalid',
            refreshDefinitions: true,
            errors: [{ pointer: '/statements/schema:url/0/value', code: 'unsupported' }],
          };
        return fixture.transport.create(command);
      },
    };
  }, [fixture, variant, onAttempt]);
  return (
    <section className="min-w-0">
      <button
        type="button"
        className="min-h-11 px-4 underline"
        data-fixture-retire
        onClick={() => setAdmitted(!admitted)}
      >
        {admitted ? 'Retire current reader (fixture)' : 'Restore reader (fixture)'}
      </button>
      <CandidateReaderBoundary
        address="character-create-family"
        observed={
          admitted
            ? { state: 'signed-in', subject: 'character-family-fixture', csrfToken: 'original-epoch' }
            : { state: 'signed-out', csrfToken: null }
        }
      >
        <CharacterProfile
          {...fixture.props}
          locale={locale}
          session={admitted ? 'signed-in' : 'signed-out'}
          transport={transport}
        />
      </CandidateReaderBoundary>
    </section>
  );
}
function Example({
  scenario = 'ready',
  variant = 'released',
  pair = false,
  direction = 'ltr',
  onAttempt,
}: {
  scenario?: CharacterScenario;
  variant?: Variant;
  pair?: boolean;
  direction?: 'ltr' | 'rtl';
  onAttempt?: ((command: CharacterCommand) => void) | undefined;
}) {
  return (
    <PatternStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <div dir={direction}>
          <Instance scenario={scenario} variant={variant} onAttempt={onAttempt} />
          {pair && <Instance scenario={scenario} variant={variant} onAttempt={onAttempt} />}
        </div>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Character creation family',
  id: 'pages-catalogue-character-creation-family',
  component: Example,
  args: { scenario: 'ready', variant: 'released', direction: 'ltr' },
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
          'Authored production CharacterProfile journeys using the existing synthetic generated-client fixture. Review phone/desktop, both themes, direction and locale globals. Plays, geometry, native authority and SSR are deferred. Existing correction, authority/disclosure and independent-mount witnesses remain unchanged; this is no new native producer.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function draft(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const name = await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
  await userEvent.type(name, 'A new traveler');
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
  const languages = canvas.getAllByRole('textbox', { name: m.catalogue_create_language() });
  await expect(languages[1]).toHaveFocus();
  await userEvent.type(languages[1]!, 'ja');
  await userEvent.type(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!, '旅人');
  await userEvent.type(canvas.getAllByRole('textbox', { name: m.catalogue_create_aliases() })[1]!, '旅の人\n旅行者');
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:url');
  await userEvent.click(canvas.getByRole('button', { name: m.character_add_fact() }));
  await userEvent.type(
    canvas.getByRole('textbox', { name: m.correction_url() }),
    `https://example.org/${'traveler'.repeat(24)}`,
  );
  return canvas;
}
async function phoneGeometry(canvasElement: HTMLElement) {
  const form = canvasElement.querySelector('form');
  if (!form) return;
  for (const control of form.querySelectorAll<HTMLElement>('input, textarea, select, button, a')) {
    if (!control.getClientRects().length) continue;
    const rect = control.getBoundingClientRect();
    await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    if (window.innerWidth < 768 || window.matchMedia('(pointer: coarse)').matches) {
      await expect(rect.height).toBeGreaterThanOrEqual(44);
    }
  }
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}
export const Desktop: Story = {};
export const Phone: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = await draft(canvasElement);
    await phoneGeometry(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
    await expect(canvas.findByRole('link', { name: m.candidate_view_public() })).resolves.toBeVisible();
    await expect(canvas.getByRole('link', { name: m.character_correct() })).toBeVisible();
    for (const name of [m.candidate_view_public(), m.character_correct()]) {
      const link = canvas.getByRole('link', { name });
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await expect(canvasElement.querySelector('[data-slot="character-created"] details')!.hasAttribute('open')).toBe(
      false,
    );
    await expect(canvas.queryByRole('form')).toBeNull();
  },
};
export const LongFallbackPhone: Story = {
  args: { variant: 'long' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    await draft(canvasElement);
    await expect(canvasElement.querySelector('[data-slot="character-initial-fact"] legend')).toHaveAttribute(
      'lang',
      'ja',
    );
    await phoneGeometry(canvasElement);
  },
};
export const RightToLeft: Story = { ...LongFallbackPhone, args: { variant: 'long', direction: 'rtl' } };
export const EnteredDraft: Story = {
  play: async ({ canvasElement }) => {
    await draft(canvasElement);
  },
};
export const Correction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
    await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
    const summary = await canvas.findByRole('region', { name: m.character_create_correction_summary() });
    const correction = within(summary).getByRole('link');
    await userEvent.click(correction);
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveFocus();
    await phoneGeometry(canvasElement);
  },
};
export const ChangedDefinitions: Story = {
  args: { variant: 'removed' },
  play: async ({ canvasElement }) => {
    const canvas = await draft(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
    await expect(canvas.findByText(m.correction_stale())).resolves.toBeVisible();
    await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[0]).toHaveValue('A new traveler');
    await userEvent.click(canvas.getByRole('button', { name: m.recipe_remove_field() }));
    await userEvent.click(canvas.getByRole('button', { name: m.recipe_remove_field() }));
    await expect(canvas.getByRole('combobox', { name: m.character_initial_fact() })).toHaveFocus();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain', onAttempt: fn<(command: CharacterCommand) => void>() },
  play: async ({ canvasElement, args }) => {
    const canvas = await draft(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
    await expect(canvas.findByText(m.catalogue_create_uncertain())).resolves.toBeVisible();
    await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[0]).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
    await expect(canvas.findByRole('link', { name: m.candidate_view_public() })).resolves.toBeVisible();
    const attempts = args.onAttempt as ReturnType<typeof fn<(command: CharacterCommand) => void>>;
    await expect(attempts).toHaveBeenCalledTimes(2);
    await expect(attempts.mock.calls[1]![0]).toEqual(attempts.mock.calls[0]![0]);
  },
};
export const Conflict: Story = {
  args: { variant: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await draft(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
    await expect(canvas.findByText(m.catalogue_create_conflict())).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_review_new() }));
    await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[0]).toBeEnabled();
  },
};
const createdRecovery: Story['play'] = async ({ canvasElement }) => {
  const canvas = await draft(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
  await expect(canvas.findByRole('button', { name: m.correction_retry() })).resolves.toBeVisible();
  await expect(canvas.queryByRole('form')).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
  await expect(canvas.queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
};
export const ReaderUnavailable: Story = { args: { scenario: 'reader-unavailable' }, play: createdRecovery };
export const ConcealedReader: Story = { args: { scenario: 'concealed' }, play: createdRecovery };
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await draft(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.character_create() }));
    await expect(canvas.findByText(m.correction_denied())).resolves.toBeVisible();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Stale: Story = { args: { scenario: 'stale' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
export const IndependentMounts: Story = {
  args: { pair: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getAllByRole('form', { name: m.character_create_correction_form() })).toHaveLength(2),
    );
    const ids = [...canvasElement.querySelectorAll('[id]')].map((node) => node.id);
    await expect(new Set(ids).size).toBe(ids.length);
    const names = canvas.getAllByRole('textbox', { name: m.catalogue_create_label() });
    await userEvent.type(names[0]!, 'Independent first draft');
    await expect(names[1]).toHaveValue('');
  },
};

export const RetiredDraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await draft(canvasElement);
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('[data-fixture-retire]')!);
    await waitFor(() => expect(canvas.queryByRole('form')).toBeNull());
    await expect(canvasElement.innerHTML).not.toContain('A new traveler');
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('[data-fixture-retire]')!);
    await expect(canvas.findByRole('textbox', { name: m.catalogue_create_label() })).resolves.toHaveValue('');
  },
};
