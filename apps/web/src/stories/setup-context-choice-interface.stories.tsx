import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { SetupContextPickerField } from '../community/setup-context-picker-field';
import {
  ContextChoiceError,
  createSetupContextPicker,
  type ContextChoiceSource,
} from '../community/setup-context-picker';
import type { SetupChoice } from '../community/space-setup';
import { m } from '../paraglide/messages.js';

// Actual-field observations, authored UNRUN. These supplied labels establish no native admission.
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const saved = { id: id(1), label: 'Saved العربية Context — ' + 'UnbrokenSavedIdentity'.repeat(12) };
const chosen = { id: id(2), label: 'Chosen 日本語 Context — ' + 'UnbrokenChosenIdentity'.repeat(12) };
const directory = { id: chosen.id, label: 'Supplied directory name — ' + 'LongReadableDirectoryLabel'.repeat(10) };
type Mode = 'long' | 'loading' | 'denied' | 'unavailable' | 'empty' | 'manual' | 'sparse';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function prepare(mode: Mode) {
  let failure: 'denied' | 'unavailable' | null = mode === 'denied' || mode === 'unavailable' ? mode : null;
  const searches: { query: string; cursor?: string }[] = [];
  const resolutions: string[] = [];
  const pendingPage = deferred<{ contexts: readonly SetupChoice[]; next: string | null }>();
  const source: ContextChoiceSource = {
    async search({ query, cursor }) {
      searches.push({ query, ...(cursor === undefined ? {} : { cursor }) });
      if (failure) throw new ContextChoiceError(failure);
      if (mode === 'loading') return pendingPage.promise;
      if (mode === 'empty') return { contexts: [], next: null };
      if (mode === 'sparse' && cursor === undefined) return { contexts: [], next: '' };
      return { contexts: [directory], next: null };
    },
    async resolve(requested) {
      resolutions.push(requested);
      return requested === saved.id ? saved : requested === chosen.id ? chosen : null;
    },
  };
  const picker = createSetupContextPicker(source, chosen.id);
  if (mode === 'long') {
    await picker.current(saved.id, 'supplied-head-a');
    await picker.choose(chosen.id);
  } else if (mode !== 'manual') {
    picker.retrySearch();
    await new Promise((done) => setTimeout(done, 10));
  }
  return {
    picker,
    source,
    searches,
    resolutions,
    recover: () => {
      failure = null;
    },
    pendingPage,
  };
}
type Observation = Awaited<ReturnType<typeof prepare>>;
const load = (mode: Mode) => async () => ({ observation: await prepare(mode) });
const meta = {
  title: 'Community/Setup Context Choice Interface',
  id: 'patterns-community-setup-context-choice-interface',
  component: SetupContextPickerField,
  args: {
    disabled: false,
    picker: createSetupContextPicker({
      search: async () => ({ contexts: [], next: null }),
      resolve: async () => null,
    }),
  },
  loaders: [load('long')],
  render: (args, { loaded, parameters }) => (
    <section dir={parameters.direction === 'rtl' ? 'rtl' : 'ltr'} className="w-full p-4" data-context-choice-interface>
      <SetupContextPickerField {...args} picker={(loaded.observation as Observation).picker} />
    </section>
  ),
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
          'Authored observations UNRUN. The actual setup field receives the installed controller with explicit presentation-only sources. Long labels, distinct read states, reference recovery, exact continuation and independent current/selected controls are retained. Keyboard, 44px geometry, 390/1280 and RTL observations await browser execution; native authorization, private reads and full acceptance remain owed.',
      },
    },
  },
  globals: { locale: 'en' },
} satisfies Meta<typeof SetupContextPickerField>;
export default meta;
type Story = StoryObj<typeof meta>;

async function layout(canvasElement: HTMLElement) {
  const region = canvasElement.querySelector<HTMLElement>('[data-context-choice-interface]')!;
  await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
  for (const node of region.querySelectorAll<HTMLElement>('p, ul, li, details, button, input')) {
    if (!node.getClientRects().length) continue;
    await expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
  }
  for (const control of region.querySelectorAll<HTMLElement>('button, input, summary')) {
    if (!control.getClientRects().length) continue;
    const rect = control.getBoundingClientRect();
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.height).toBeGreaterThanOrEqual(44);
  }
}
async function focusVisible(node: HTMLElement) {
  await expect(node).toHaveFocus();
  const style = node.ownerDocument.defaultView!.getComputedStyle(node);
  await expect(style.outlineStyle).not.toBe('none');
  await expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
}
const longObservation: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText(saved.label)).toBeVisible();
  await expect(canvas.getByText(chosen.label)).toBeVisible();
  await expect(canvas.getByText(m.setup_context_hint())).toBeVisible();
  await expect(canvas.getByText(m.setup_context_changed())).toBeVisible();
  await expect(canvas.getByText(m.setup_context_keep_draft())).toBeVisible();
  const details = canvasElement.querySelector('details')!;
  await expect(details.open).toBe(false);
  await layout(canvasElement);
  canvas.getByRole('searchbox', { name: m.space_setup_context_label() }).focus();
  await userEvent.tab();
  const summary = canvasElement.querySelector('summary')!;
  await focusVisible(summary);
  await userEvent.keyboard('{Enter}');
  await expect(details.open).toBe(true);
  await userEvent.tab();
  const reference = canvas.getByRole('textbox', { name: m.space_setup_reference() });
  await focusVisible(reference);
  await expect(reference).toHaveValue(chosen.id);
  await layout(canvasElement);
  await userEvent.tab();
  await focusVisible(canvas.getByRole('button', { name: m.space_setup_resolve() }));
};
export const LongCurrentAndSelectedPhone: Story = { name: 'Long Current And Selected', play: longObservation };
export const LongCurrentAndSelectedDesktop: Story = { tags: ['!dev'], globals: {}, play: longObservation };
export const LongCurrentAndSelectedRTL: Story = { parameters: { direction: 'rtl' }, play: longObservation };
export const LongCurrentAndSelectedDesktopRTL: Story = {
  tags: ['!dev'],
  parameters: { direction: 'rtl' },
  globals: {},
  play: longObservation,
};
export const LoadingIsNotEmpty: Story = {
  loaders: [load('loading')],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.setup_context_searching());
    await expect(canvas.queryByText(m.setup_context_empty())).toBeNull();
    await expect(canvas.queryByText(directory.label)).toBeNull();
    await expect(canvas.getByText(m.space_setup_reference_hint())).toBeVisible();
    await layout(canvasElement);
  },
};
const recovery: NonNullable<Story['play']> = async ({ canvasElement, loaded }) => {
  const canvas = within(canvasElement);
  const observation = loaded.observation as Observation;
  await expect(canvas.getByRole('alert')).toBeVisible();
  await expect(canvas.queryByText(m.setup_context_empty())).toBeNull();
  await expect(canvas.queryByText(directory.label)).toBeNull();
  await expect(canvas.getByText(m.space_setup_reference_hint())).toBeVisible();
  await layout(canvasElement);
  observation.recover();
  const retry = canvas.getByRole('button', { name: m.space_setup_retry() });
  retry.focus();
  await userEvent.keyboard('{Enter}');
  await expect(await canvas.findByText(directory.label)).toBeVisible();
  await expect(observation.resolutions).toEqual([]);
  await userEvent.click(canvas.getByRole('button', { name: `${directory.label} ${directory.id}` }));
  await expect(await canvas.findByText(chosen.label)).toBeVisible();
  await expect(observation.resolutions).toEqual([chosen.id]);
};
export const DeniedWithExplicitRetry: Story = { loaders: [load('denied')], play: recovery };
export const UnavailableWithKnownReference: Story = {
  loaders: [load('unavailable')],
  play: async ({ canvasElement, loaded }) => {
    const canvas = within(canvasElement);
    const observation = loaded.observation as Observation;
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.setup_context_unavailable());
    await expect(canvas.queryByText(m.setup_context_empty())).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.space_setup_resolve() }));
    await expect(await canvas.findByText(chosen.label)).toBeVisible();
    await expect(observation.resolutions).toEqual([chosen.id]);
  },
};
export const UnavailableWithExplicitRetry: Story = { loaders: [load('unavailable')], play: recovery };
export const EmptyHasNoNext: Story = {
  loaders: [load('empty')],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.setup_context_empty())).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.setup_context_next() })).toBeNull();
    await layout(canvasElement);
  },
};
export const SparseExactNext: Story = {
  loaders: [load('sparse')],
  play: async ({ canvasElement, loaded }) => {
    const canvas = within(canvasElement);
    const observation = loaded.observation as Observation;
    await expect(canvas.getByText(m.setup_context_empty())).toBeVisible();
    const next = canvas.getByRole('button', { name: m.setup_context_next() });
    await layout(canvasElement);
    next.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(directory.label)).toBeVisible();
    await expect(observation.searches).toEqual([{ query: '' }, { query: '', cursor: '' }]);
    await expect(observation.resolutions).toEqual([]);
    await expect(canvas.queryByRole('button', { name: m.setup_context_next() })).toBeNull();
    await layout(canvasElement);
  },
};
export const ManualValidReference: Story = {
  loaders: [load('manual')],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reference = canvas.getByRole('textbox', { name: m.space_setup_reference() });
    const resolve = canvas.getByRole('button', { name: m.space_setup_resolve() });
    await expect(resolve).toBeEnabled();
    await userEvent.clear(reference);
    await userEvent.type(reference, 'invalid');
    await expect(resolve).toBeDisabled();
    await userEvent.clear(reference);
    await userEvent.type(reference, chosen.id);
    await expect(resolve).toBeEnabled();
    await layout(canvasElement);
    await userEvent.tab();
    await focusVisible(resolve);
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(chosen.label)).toBeVisible();
    await expect(canvasElement.querySelector('details')!.open).toBe(false);
  },
};
export const DisabledResolve: Story = {
  loaders: [load('manual')],
  args: { disabled: true },
  play: async ({ canvasElement, loaded }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: m.space_setup_reference() })).toHaveValue(chosen.id);
    await expect(canvas.getByRole('button', { name: m.space_setup_resolve() })).toBeDisabled();
    await expect((loaded.observation as Observation).resolutions).toEqual([]);
    await layout(canvasElement);
  },
};
export const CurrentUseCurrentClearAndCheck: Story = {
  play: async ({ canvasElement, loaded }) => {
    const canvas = within(canvasElement);
    const observation = loaded.observation as Observation;
    await userEvent.click(canvas.getByRole('button', { name: m.setup_context_check_current() }));
    await expect(await canvas.findByText(saved.label)).toBeVisible();
    await expect(canvas.getByText(chosen.label)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.setup_context_use_current() }));
    await waitFor(() => expect(observation.picker.getSnapshot().selected?.id).toBe(saved.id));
    await expect(observation.resolutions).toEqual([saved.id, chosen.id, saved.id, saved.id]);
    await userEvent.click(canvas.getByRole('button', { name: m.setup_context_clear() }));
    await expect(observation.picker.getSnapshot().current?.id).toBe(saved.id);
    await expect(observation.picker.getSnapshot().selected).toBeNull();
    await expect(canvasElement.querySelector('details')!.open).toBe(true);
    await layout(canvasElement);
  },
};
export const CurrentnessAndRetiredWork: Story = {
  play: async ({ canvasElement, loaded }) => {
    const canvas = within(canvasElement);
    const observation = loaded.observation as Observation;
    const pending = deferred<SetupChoice | null>();
    observation.source.resolve = () => pending.promise;
    const disconnect = observation.picker.connect();
    const old = observation.picker.current(saved.id, 'supplied-head-b');
    await waitFor(() => expect(canvas.queryByText(saved.label)).toBeNull());
    disconnect();
    observation.picker.connect();
    observation.source.resolve = async () => saved;
    await observation.picker.current(saved.id, 'supplied-head-a');
    pending.resolve({ id: saved.id, label: 'RETIRED LABEL MUST NOT APPEAR' });
    await old;
    await expect(await canvas.findByText(saved.label)).toBeVisible();
    await expect(canvas.queryByText('RETIRED LABEL MUST NOT APPEAR')).toBeNull();
    let retiredReads = 0;
    observation.source.resolve = async () => {
      retiredReads++;
      return saved;
    };
    observation.picker.dispose();
    await userEvent.click(canvas.getByRole('button', { name: m.setup_context_use_current() }));
    await expect(retiredReads).toBe(0);
    await expect(observation.picker.getSnapshot().selected?.id).toBe(chosen.id);
  },
};
