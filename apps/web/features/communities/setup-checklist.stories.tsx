import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { CommunitySetupChecklist } from './setup-checklist.tsx';

const actor = 'https://rezics.com/id/00000000-0000-8000-8000-000000000412';
const realm = 'https://rezics.com/id/00000000-0000-8000-8000-000000000436';

function NewCommunityChecklist() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    localStorage.setItem(`rezics:community-setup:${actor}:${realm}`, JSON.stringify({ topics: false, invite: false }));
    setReady(true);
  }, []);
  return ready ? <div className="mx-auto max-w-3xl p-4"><CommunitySetupChecklist realm={realm} actor={actor}
    path={localizedPath(spaceHref(realm, 'community'), 'en')} locale="en" rules={false} icon={false} banner={false} />
  </div> : null;
}

const meta = { title: 'Communities/Setup checklist', component: NewCommunityChecklist } satisfies Meta<typeof NewCommunityChecklist>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FirstMinutes: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('heading', { name: 'Set up your community' })).toBeVisible();
  await expect(canvas.getAllByRole('listitem')).toHaveLength(6);
  await expect(canvas.getAllByRole('link', { name: 'Open' }).at(-1)).toHaveAttribute('href',
    localizedPath(spaceHref(realm, 'community', ['submit']), 'en'));
} };
