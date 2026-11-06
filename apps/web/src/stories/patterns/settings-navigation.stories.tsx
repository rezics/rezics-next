import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { settingsNavigationExample } from '../../kernel/fake/settings-account';
import { m } from '../../paraglide/messages.js';
import { SectionsNavigation, type SettingsSection } from '../../settings/sections-navigation';

const meta = {
  title: 'Patterns/Account/Settings navigation',
  component: SectionsNavigation,
  parameters: { layout: 'padded' },
  beforeEach: () => {
    const original = window.location.href;
    return () => window.history.replaceState(null, '', original);
  },
} satisfies Meta<typeof SectionsNavigation>;
export default meta;
type Story = StoryObj<typeof Example>;

function Example({
  state = 'ready',
  pending = false,
  longLabels = false,
}: {
  state?: 'ready' | 'closed' | 'preparing' | 'unavailable';
  pending?: boolean;
  longLabels?: boolean;
}) {
  const descriptions: Partial<Record<SettingsSection['id'], string>> = {
    reading: m.settings_spoiler_legend(),
    notifications: m.settings_notifications_text(),
    privacy: m.settings_privacy_text(),
    account: m.settings_account_safety_text(),
  };
  const sections = settingsNavigationExample(state)
    .filter((section) => !pending || !['privacy', 'verification'].includes(section.id))
    .map((section) => ({
      ...section,
      label: longLabels && descriptions[section.id] ? `${section.label} · ${descriptions[section.id]}` : section.label,
    }));
  return (
    <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[12rem_minmax(0,48rem)]">
      <SectionsNavigation sections={sections} admission={pending ? 'unknown' : 'available'} />
      <div className="space-y-8">
        {sections.map((section) => (
          <section key={section.id} id={section.id} tabIndex={-1} className="scroll-mt-6 rounded-lg border p-4">
            <h2 className="font-medium">{section.label}</h2>
            {section.status ? <p>{section.status}</p> : null}
          </section>
        ))}
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const navigation = within(canvas.getByRole('navigation', { name: m.settings_sections_label() }));
    const first = navigation.getByRole('link', { name: m.settings_reading_heading() });
    first.focus();
    await userEvent.keyboard('{Enter}');
    await expect(window.location.hash).toBe('#reading');
    await userEvent.click(navigation.getByRole('link', { name: m.settings_account_heading() }));
    await expect(window.location.hash).toBe('#account');
    for (const anchor of navigation.getAllByRole('link')) {
      const target = canvasElement.querySelector(anchor.getAttribute('href')!);
      await expect(target).not.toBeNull();
    }
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#reading'));
  },
};

export const LongLabels: Story = {
  render: () => <Example longLabels />,
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation');
    for (const anchor of within(nav).getAllByRole('link')) await expect(anchor).toBeVisible();
    await expect(nav.scrollWidth).toBeLessThanOrEqual(nav.clientWidth);
  },
};

export const PendingAdmission: Story = {
  render: () => <Example pending />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.settings_sections_loading());
  },
};

export const Closed: Story = {
  render: () => <Example state="closed" />,
  play: async ({ canvasElement }) => {
    const nav = within(within(canvasElement).getByRole('navigation'));
    await expect(nav.queryByRole('link', { name: m.settings_privacy_heading() })).toBeNull();
    await expect(nav.queryByRole('link', { name: m.settings_verification_heading() })).toBeNull();
    await expect(nav.queryByRole('link', { name: m.settings_notifications_heading() })).toBeNull();
  },
};

export const Preparing: Story = {
  render: () => <Example state="preparing" />,
};

export const TransportUnavailable: Story = {
  render: () => <Example state="unavailable" />,
  play: async ({ canvasElement }) => {
    const nav = within(within(canvasElement).getByRole('navigation'));
    await expect(
      nav.getByRole('link', { name: `${m.settings_reading_heading()} ${m.settings_unavailable_title()}` }),
    ).toBeVisible();
    await userEvent.click(nav.getByRole('link', { name: m.settings_account_heading() }));
    await expect(window.location.hash).toBe('#account');
  },
};
