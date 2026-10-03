import { zoneMemberHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ReportAction } from './report-action.tsx';

const meta = {
  title: 'Safety/Report action',
  component: ReportAction,
  args: { target: 'https://rezics.com/id/00000000-0000-4000-8000-000000000101', kind: 'profile' },
} satisfies Meta<typeof ReportAction>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A link to the report page with the target filled in: it needs no account and no script. */
export const Profile: Story = {
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: 'Report this profile' });
    await expect(link.getAttribute('href')).toContain(
      '/report?target=https%3A%2F%2Frezics.com%2Fid%2F',
    );
  },
};

export const Reply: Story = {
  args: { kind: 'reply', target: 'https://rezics.com/id/00000000-0000-4000-8000-000000000202' },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('link', { name: 'Report this reply' }),
    ).toBeVisible();
  },
};

/** In a row of icon actions the name stays for assistive technology. */
export const IconOnly: Story = {
  args: {
    kind: 'post',
    iconOnly: true,
    target: localizedPath(zoneMemberHref('rain', 'threads', '1'), 'en'),
  },
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: 'Report this post' });
    await expect(link).toHaveAttribute('title', 'Report this post');
    const report = new URL(link.getAttribute('href')!, window.location.origin);
    await expect(report.searchParams.get('target')).toBe(
      localizedPath(zoneMemberHref('rain', 'threads', '1'), 'en'),
    );
  },
};

/** A Realm's page names the Realm so its rules can be reported. */
export const InRealm: Story = {
  args: { kind: 'post', realm: 'https://rezics.com/id/00000000-0000-4000-8000-0000000000e1' },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('link', { name: 'Report this post' }).getAttribute('href'),
    ).toContain('realm=');
  },
};
