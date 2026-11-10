import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AccountMenu } from '../../shell/shell';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PatternStory } from '../page';
import { sessionQuery } from '../../session/query';

const trusted = fn(async () => 'https://auth.example.test/oidc');
const unresolved = fn(() => new Promise<string>(() => {}));
const missing = fn(async () => '');
const rejected = fn(async (): Promise<string> => {
  throw new Error('configuration unavailable');
});

function Connected({ readIssuer }: { readIssuer: () => Promise<string> }) {
  const client = useQueryClient();
  useState(() => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'story-csrf-token',
      subject: 'account-menu-pattern-member',
    });
  });
  return (
    <div className="max-w-sm p-4">
      <AccountMenu
        session="signed-in"
        csrfToken="story-csrf-token"
        readIssuer={readIssuer}
        phone={window.matchMedia('(max-width: 767px)').matches}
      />
    </div>
  );
}

function Example({ readIssuer }: { readIssuer: () => Promise<string> }) {
  return (
    <PatternStory visitor="Signed In">
      <Connected readIssuer={readIssuer} />
    </PatternStory>
  );
}

async function open({ canvasElement }: { canvasElement: HTMLElement }) {
  const phone = window.matchMedia('(max-width: 767px)').matches;
  await userEvent.click(
    await within(canvasElement).findByRole('button', {
      name: phone ? m.shell_you() : m.account_menu(),
    }),
  );
  return within(
    await within(document.body).findByRole('dialog', {
      name: phone ? m.shell_you() : m.account_menu(),
    }),
  );
}

async function unavailable(context: { canvasElement: HTMLElement }) {
  const menu = await open(context);
  const security = await menu.findByRole('link', { name: m.account_security_unavailable() });
  await expect(security).toHaveAttribute('aria-disabled', 'true');
  await expect(security).not.toHaveAttribute('href');
  await expect(menu.getByRole('button', { name: m.account_sign_out() })).toBeEnabled();
}

const meta = { title: 'Account/Shell Account Menu', id: 'patterns-account-shell-account-menu' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const TrustedIssuer: Story = {
  render: () => <Example readIssuer={trusted} />,
  play: async (context) => {
    const menu = await open(context);
    await expect(await menu.findByRole('link', { name: m.account_security_settings() })).toHaveAttribute(
      'href',
      'https://auth.example.test/security',
    );
    for (const [label, path] of [
      [m.library_nav_collections(), 'collections'],
      [m.library_nav_following(), 'following'],
    ] as const) {
      await expect(await menu.findByRole('link', { name: label })).toHaveAttribute(
        'href',
        `/${getLocale()}/library/${path}`,
      );
    }
    const signOut = menu.getByRole('button', { name: m.account_sign_out() }).closest('form')!;
    await expect(signOut).toHaveAttribute('action', '/auth/sign-out');
    await expect(signOut.querySelector('[name="csrf_token"]')).toHaveValue('story-csrf-token');
  },
};
export const UnresolvedIssuer: Story = {
  beforeEach: () => {
    unresolved.mockClear();
  },
  render: () => <Example readIssuer={unresolved} />,
  play: async (context) => {
    await unavailable(context);
    await waitFor(() => expect(unresolved).toHaveBeenCalledTimes(1));
  },
};
export const MissingIssuer: Story = {
  render: () => <Example readIssuer={missing} />,
  play: unavailable,
};
export const RejectedIssuer: Story = {
  render: () => <Example readIssuer={rejected} />,
  play: unavailable,
};
