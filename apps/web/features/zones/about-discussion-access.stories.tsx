import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NO_PLATFORM_ACCESS, type PlatformAccess } from '../api/platform-access.ts';
import { spaceHref } from '../address/path.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { storyQuietThread } from '../feed/thread-fixtures.ts';
import { AboutDiscussion } from './about-discussion.tsx';
import type { AboutDiscussionApi, AboutDiscussionRead } from './about-discussion-api.ts';
import { aboutDiscussionMessages } from './about-discussion-messages.ts';

const reference = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const granted: PlatformAccess = { groups: ['realm-reply'], operations: [], generation: 'granted' };
const ready: Extract<AboutDiscussionRead, { kind: 'ready' }> = {
  kind: 'ready', mode: 'open', actingSubject: reference(4), thread: storyQuietThread,
  basis: { realm: storyQuietThread.realm, about: storyQuietThread.work.id,
    targetRevision: storyQuietThread.rootRevision, zone: reference(1), path: '/chapter', routeRevision: reference(2) },
};
const post = fn<AboutDiscussionApi['post']>(async () => ({ kind: 'recovery' }));
const readAgain = fn<NonNullable<AboutDiscussionApi['read']>>(async () => ready);
const t = aboutDiscussionMessages.en;

const meta = {
  title: 'Zones/About discussion access',
  component: AboutDiscussion,
  args: { read: ready, locale: 'en', href: spaceHref('reading', 'site', ['chapter']), retain: false, api: { post } },
  decorators: [(Story, context) => <ShellProvider locale="en" messages={shellMessages} initialTheme="light"
    initialCollapsed={false} signedIn={context.parameters.signedIn !== false}
    platformAccess={context.parameters.platformAccess ?? granted}>
    <div className="mx-auto w-full max-w-[640px] px-5 py-6"><Story /></div>
  </ShellProvider>],
  beforeEach: () => { post.mockClear(); readAgain.mockClear(); },
} satisfies Meta<typeof AboutDiscussion>;
export default meta;
type Story = StoryObj<typeof meta>;

async function closed(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByRole('article')).toHaveLength(1);
  await expect(canvas.getByRole('link', { name: t.continueThread })).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent(t.postingUnavailable);
  await expect(canvas.queryByRole('button', { name: t.reply })).toBeNull();
  await expect(canvas.queryByRole('button', { name: t.send })).toBeNull();
  await expect(canvas.queryByRole('button', { name: t.retry })).toBeNull();
  await expect(canvas.queryByRole('textbox', { name: t.body })).toBeNull();
}

export const NoGrant: Story = {
  parameters: { platformAccess: NO_PLATFORM_ACCESS },
  play: async ({ canvasElement }) => { await closed(canvasElement); await expect(post).not.toHaveBeenCalled(); },
};

export const Anonymous: Story = { ...NoGrant, parameters: { signedIn: false, platformAccess: NO_PLATFORM_ACCESS } };

export const GroupGranted: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: t.reply })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: t.reply }));
    await userEvent.type(canvas.getByRole('textbox', { name: t.body }), 'A question about this chapter.');
    await expect(canvas.getByRole('button', { name: t.send })).toBeEnabled();
    await expect(canvas.getByRole('link', { name: t.continueThread })).toBeVisible();
  },
};

export const OperationGranted: Story = {
  ...GroupGranted,
  parameters: { platformAccess: { groups: [], operations: ['postV1RealmsByRealmAbout-posts'], generation: 'operation' } },
};

export const RetryOnlyTheDiscussion: Story = {
  args: { read: { kind: 'unavailable' },
    recoveryScope: { zone: ready.basis.zone, path: ready.basis.path, actingSubject: ready.actingSubject,
      signedIn: true, personal: true, postingOpen: true } },
  render: args => <AboutDiscussion {...args} api={{ post, read: readAgain }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(t.unavailable);
    await userEvent.click(canvas.getByRole('button', { name: t.retry, exact: true }));
    await expect(await canvas.findByRole('link', { name: t.continueThread })).toBeVisible();
    await expect(canvas.getAllByRole('article')).toHaveLength(1);
    await expect(readAgain).toHaveBeenCalledWith({ zone: ready.basis.zone, path: ready.basis.path,
      actingSubject: ready.actingSubject, signedIn: true, personal: true, postingOpen: true });
    await expect(post).not.toHaveBeenCalled();
  },
};

function LiveAccess(props: ComponentProps<typeof AboutDiscussion>) {
  const [access, setAccess] = useState(granted);
  return <ShellProvider locale="en" messages={shellMessages} initialTheme="light" initialCollapsed={false}
    signedIn platformAccess={access}>
    <button type="button" onClick={() => setAccess(NO_PLATFORM_ACCESS)}>Revoke posting access</button>
    <button type="button" onClick={() => setAccess(granted)}>Restore posting access</button>
    <AboutDiscussion {...props} />
  </ShellProvider>;
}

export const RevokedComposer: Story = {
  render: args => <LiveAccess {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: t.reply }));
    await userEvent.type(canvas.getByRole('textbox', { name: t.body }), 'My retained question.');
    await userEvent.click(canvas.getByRole('button', { name: 'Revoke posting access' }));
    await closed(canvasElement);
    await expect(post).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Restore posting access' }));
    await expect(canvas.getByRole('textbox', { name: t.body })).toHaveValue('My retained question.');
    await expect(canvas.getByRole('button', { name: t.send })).toBeEnabled();
  },
};

export const RevokedRecovery: Story = {
  render: args => <LiveAccess {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: t.reply }));
    await userEvent.type(canvas.getByRole('textbox', { name: t.body }), 'My unresolved question.');
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(post).toHaveBeenCalledTimes(1);
    await expect(await canvas.findByRole('button', { name: t.retry })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Revoke posting access' }));
    await closed(canvasElement);
    await expect(post).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Restore posting access' }));
    await expect(canvas.getByRole('textbox', { name: t.body })).toHaveValue('My unresolved question.');
    await expect(canvas.getByRole('button', { name: t.retry })).toBeEnabled();
  },
};
