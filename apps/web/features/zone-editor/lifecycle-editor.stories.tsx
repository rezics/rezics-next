import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { ZoneLifecycleClient, ZoneLifecycleStatus } from './api.ts';
import { ZoneLifecycleEditor } from './lifecycle-editor.tsx';
import { messages } from './messages.ts';
import { ZoneEditorFrame } from './frame.tsx';
import { messages as manageMessages } from '../manage/messages.ts';

const zoneId = '00000000-0000-4000-8000-000000000601';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000602';
const head = 'https://rezics.com/id/00000000-0000-4000-8000-000000000603';
const nextHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000604';
const agent = { iri: actor, label: 'Harbor editor', handle: null, kind: 'person' as const, path: 'direct-principal' as const };

function lifecycleClient(starting: ZoneLifecycleStatus, staleOnce: boolean): ZoneLifecycleClient {
  let status = starting;
  let stale = staleOnce;
  return {
    async readConfiguration() { return { ok: true, data: { revision: nextHead, status } }; },
    async retire() {
      if (stale) { stale = false; return { ok: false, failure: 'stale', currentHead: nextHead }; }
      status = 'retired';
      return { ok: true, data: { revision: nextHead, replayed: false } };
    },
    async recover() {
      if (stale) { stale = false; return { ok: false, failure: 'stale', currentHead: nextHead }; }
      status = 'active';
      return { ok: true, data: { revision: nextHead, replayed: false } };
    },
  };
}

function LifecycleStory({ status, stableEntry = false, staleOnce = false }: {
  status: ZoneLifecycleStatus; stableEntry?: boolean; staleOnce?: boolean;
}) {
  const [api] = useState(() => lifecycleClient(status, staleOnce));
  return <ZoneEditorFrame name="Harbor notes" editorPath={stableEntry ? `/manage/z/${zoneId}` : '/manage/z/harbor'}
    lifecycleOnly={stableEntry} agent={agent} locale="en" manageMessages={manageMessages}
    sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome}
    sectionNavigation={messages.en.sectionNavigation} sectionRealm={messages.en.sectionRealm}
    sectionTheme={messages.en.sectionTheme} sectionLifecycle={messages.en.sectionLifecycle}>
    <ZoneLifecycleEditor zoneId={zoneId} actingSubject={actor} locale="en" copy={messages.en}
      initial={{ revision: head, status }} signInHref="/auth/start" api={api} onRetired={() => {}} />
  </ZoneEditorFrame>;
}

const meta = {
  title: 'Zone editor/Lifecycle',
  render: () => <LifecycleStory status="active" />,
  parameters: { route: { pathname: '/en/manage/z/harbor/lifecycle' }, viewport: { defaultViewport: 'responsive' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The author sees what retirement changes and what recovery preserves before confirming. */
export const RetirementEffectBeforeAction: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Status' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(canvas.getByRole('button', { name: 'Retire site' }));
    await expect(canvas.getByText('Before you retire this site', { exact: true })).toBeVisible();
    await expect(canvas.getByText(/Readers will no longer be able to open it/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Confirm' })).toBeVisible();
  },
};

/** A retired Zone keeps a management entry by its stable Zone identifier. */
export const RecoverRetiredSite: Story = {
  render: () => <LifecycleStory status="retired" stableEntry />,
  parameters: { route: { pathname: `/en/manage/z/${zoneId}/lifecycle` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Status' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.queryByRole('link', { name: 'Home' })).toBeNull();
    await expect(canvas.getByText('This site is retired and unavailable to readers.', { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Recover site' }));
    await expect(canvas.getByText('Recover this site?', { exact: true })).toBeVisible();
    await expect(canvas.getByText(/Readers will be able to open the last published page/)).toBeVisible();
  },
};

/** A stale response keeps the retirement choice and blocks another command until review. */
export const StaleRetirementNeedsReview: Story = {
  render: () => <LifecycleStory status="active" staleOnce />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Retire site' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Confirm' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('The site changed before this action');
    await expect(canvas.getByText('Before you retire this site', { exact: true })).toBeVisible();
    const confirm = canvas.getByRole('button', { name: 'Confirm' });
    await expect(confirm).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Review current status' }));
    await expect(canvas.getByText(/The current status is loaded/)).toBeVisible();
    await expect(canvas.getByText('Before you retire this site', { exact: true })).toBeVisible();
    await expect(confirm).toBeEnabled();
  },
};
