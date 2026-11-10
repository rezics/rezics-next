import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ZoneFeedback } from '../features/zones/manage/feedback';
import { ZonesRouteError } from '../features/zones/manage/route-feedback';
import { zonesNavigation } from '../features/zones/manage/navigation';
import type { Failure } from '../features/zones/manage/model';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import workspaceMeta from './zones-owner-workspace.stories';
import createMeta from './zones-create.stories';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const longReturnTo = `/ja/my/zones/new?name=${'読書と旅の記録 مكتبة الرحلات & "<書棚>" +/#?'.repeat(8)}&cursor=opaque+/cursor==#names`;
const desktop = {};
const phone = {};

const meta = {
  title: 'Zones/Owner recovery family',
  id: 'patterns-zones-owner-recovery-family',
  component: ZoneFeedback,
  tags: ['autodocs'],
  args: { failure: { kind: 'unavailable' }, locale: 'en' },
  render: (args) => (
    <div lang={getLocale()} className="mx-auto min-w-0 max-w-3xl p-4">
      <ZoneFeedback {...args} locale={getLocale()} />
    </div>
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
          'UNRUN: actual ZoneFeedback, nine failures with and without caller-owned retry. Review phone 390, desktop 1280, every locale/theme and RTL. Connected owner pages use their unchanged canonical fixtures. Class/DOM assertions are not measured geometry or browser proof. Growth repeats independent supplied instances at 1/8/32, never a backend failure page: constant presentation per instance and zero added IO, traversal or transport changes. Native/physical growth and original acceptance remain deferred.',
      },
    },
  },
} satisfies Meta<typeof ZoneFeedback>;
export default meta;
type Story = StoryObj<typeof meta>;

function failure(kind: Failure['kind'], retry = false): Story {
  return {
    args: { failure: { kind }, ...(retry ? { onRetry: fn() } : {}) },
    globals: desktop,
    play: async ({ canvasElement, args }) => {
      const alert = within(canvasElement).getByRole('alert');
      const action = alert.querySelector<HTMLElement>('a,button');
      const signIn = args.failure.kind === 'signed-out';
      expect(alert.querySelector('p')?.textContent).not.toBe('');
      expect(alert.querySelector('details')).toBeNull();
      if (signIn || args.onRetry || args.failure.kind === 'unavailable') {
        expect(action?.tagName).toBe(signIn || !args.onRetry ? 'A' : 'BUTTON');
        action!.focus();
        expect(action).toHaveFocus();
        if (args.onRetry) {
          expect(args.onRetry).not.toHaveBeenCalled();
          if (!signIn) {
            await userEvent.keyboard('{Enter}');
            expect(args.onRetry).toHaveBeenCalledTimes(1);
            expect(within(canvasElement).getByRole('alert')).toBe(alert);
          }
        }
      } else expect(action).toBeNull();
    },
  };
}

export const SignedOut = failure('signed-out');
export const SignedOutWithCallback = failure('signed-out', true);
export const Denied = failure('denied');
export const DeniedWithCallback = failure('denied', true);
export const Closed = failure('closed');
export const ClosedWithCallback = failure('closed', true);
export const Actor = failure('actor');
export const ActorWithCallback = failure('actor', true);
export const Missing = failure('missing');
export const MissingWithCallback = failure('missing', true);
export const Invalid = failure('invalid');
export const InvalidWithCallback = failure('invalid', true);
export const Conflict = failure('conflict');
export const ConflictWithCallback = failure('conflict', true);
export const Stale = failure('stale');
export const StaleWithCallback = failure('stale', true);
export const Unavailable = failure('unavailable');
export const UnavailableWithCallback = failure('unavailable', true);
export const SignInEscapingPhone: Story = {
  ...SignedOutWithCallback,
  globals: phone,
  args: { ...SignedOutWithCallback.args, returnTo: longReturnTo },
  play: async ({ canvasElement, args }) => {
    const link = within(canvasElement).getByRole('link');
    expect(link).toHaveAttribute('href', `/auth/sign-in?return_to=${encodeURIComponent(longReturnTo)}`);
    link.focus();
    expect(link).toHaveFocus();
    expect(args.onRetry).not.toHaveBeenCalled();
  },
};
export const ReturnNavigationPhone: Story = {
  ...Unavailable,
  globals: phone,
  args: { returnTo: longReturnTo },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link');
    expect(link).toHaveAttribute('href', longReturnTo);
    link.focus();
    expect(link).toHaveFocus();
  },
};

function IndependentRecovery({ count = 1, rtl = false }: { count?: number; rtl?: boolean }) {
  const callbacks = useMemo(() => Array.from({ length: count }, () => fn()), [count]);
  return (
    <div lang={getLocale()} dir={rtl ? 'rtl' : undefined} className="mx-auto min-w-0 max-w-3xl space-y-6 p-4">
      {callbacks.map((onRetry, index) => (
        <ZoneFeedback key={index} failure={{ kind: 'unavailable' }} locale={getLocale()} onRetry={onRetry} />
      ))}
    </div>
  );
}
export const IndependentPhoneRtl: Story = {
  globals: phone,
  render: () => <IndependentRecovery count={2} rtl />,
  play: async ({ canvasElement }) => {
    const actions = within(canvasElement).getAllByRole('button');
    actions[0]!.focus();
    await userEvent.tab();
    expect(actions[1]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(within(canvasElement).getAllByRole('alert')).toHaveLength(2);
  },
};
export const SuppliedOne: Story = { render: () => <IndependentRecovery />, globals: desktop };
export const SuppliedEight: Story = { render: () => <IndependentRecovery count={8} />, globals: desktop };
export const SuppliedThirtyTwo: Story = { render: () => <IndependentRecovery count={32} />, globals: phone };

// Reuse the exported canonical connected components, including their instance-local native fakes.
const Workspace = workspaceMeta.component;
const Create = createMeta.component;
export const OwnerUnavailable: Story = { render: () => <Workspace scenario="unavailable" />, globals: phone };
export const OwnerDenied: Story = { render: () => <Workspace scenario="denied" />, globals: desktop };
export const OwnerStale: Story = { render: () => <Workspace scenario="stale" />, globals: phone };
export const OwnerEmpty: Story = { render: () => <Workspace scenario="empty" />, globals: desktop };
export const OwnerReady: Story = { render: () => <Workspace />, globals: desktop };
export const OwnerUncertainRetry: Story = {
  render: () => <Workspace scenario="uncertain" />,
  globals: phone,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByRole('button', { name: m.zones_owner_trash_action() }))[0]!);
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.zones_owner_trash_action() }));
    const alert = await canvas.findByRole('alert');
    expect(alert).toHaveTextContent(m.zones_owner_unavailable());
    const retry = within(alert).getByRole('button', { name: m.zones_owner_retry() });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    expect(await canvas.findByText(m.zones_owner_trashed())).toBeVisible();
  },
};
export const RouteFailure: Story = {
  globals: phone,
  render: () => (
    <PatternStory path="/my/zones" visitor="Signed In">
      <AppShell navigation={zonesNavigation}>
        <ZonesRouteError />
      </AppShell>
    </PatternStory>
  ),
};
export const CreateSignIn: Story = { render: () => <Create scenario="signed-out" />, globals: phone };
export const CreateUncertainRetry: Story = {
  render: () => <Create scenario="uncertain" />,
  globals: phone,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.zones_create_starter() }), 'book');
    await userEvent.type(canvas.getByRole('textbox', { name: m.zone_name_primary() }), '読書と旅の記録 مكتبة الرحلات');
    await userEvent.click(canvas.getByRole('button', { name: m.zones_create_submit() }));
    const alert = await canvas.findByRole('alert');
    expect(alert).toHaveTextContent(m.zones_owner_unavailable());
    expect(canvas.getByText(m.zones_create_uncertain())).toBeVisible();
    const retry = within(alert).getByRole('button', { name: m.zones_owner_retry() });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    expect(await canvas.findByText(m.zones_create_saved())).toBeVisible();
  },
};
