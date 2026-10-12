import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { ZoneLifecycleClient, ZoneLifecycleStatus } from './api.ts';
import { ZoneLifecycleEditor } from './lifecycle-editor.tsx';
import { messages } from './messages.ts';
import { ZoneEditorFrame } from './frame.tsx';
import { ZoneEditorDraftProvider, useZoneEditorExit } from './draft-provider.tsx';
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

const lifecycleCommandCalls: { key: string; body: Parameters<ZoneLifecycleClient['retire']>[1] }[] = [];
let lifecycleRedirects = 0;

function LifecycleExitControls() {
  const [section, setSection] = useState<'status' | 'theme'>('status');
  const [previewed, setPreviewed] = useState(false);
  const requestExit = useZoneEditorExit();
  const [api] = useState<ZoneLifecycleClient>(() => {
    let attempts = 0;
    return {
      async readConfiguration() { return { ok: true, data: { revision: head, status: 'active' } }; },
      async retire(_zone, body, key) {
        attempts += 1;
        lifecycleCommandCalls.push({ key, body });
        if (attempts <= 2) return { ok: false, failure: 'unavailable' };
        return { ok: true, data: { revision: nextHead, replayed: true } };
      },
      async recover() { return { ok: false, failure: 'conflict' }; },
    };
  });
  return <div className="grid min-w-0 gap-5">
    <nav aria-label="Story sections" className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => setSection('status')}>Status editor</Button>
      <Button variant="outline" size="sm" onClick={() => setSection('theme')}>Theme editor</Button>
    </nav>
    {section === 'status' ? <ZoneLifecycleEditor zoneId={zoneId} actingSubject={actor} locale="en" copy={messages.en}
      initial={{ revision: head, status: 'active' }} signInHref="/auth/start" api={api}
      onRetired={() => { lifecycleRedirects += 1; }} /> : <p>Theme section</p>}
    <Button variant="outline" size="sm" className="justify-self-start"
      onClick={() => requestExit(() => setPreviewed(true))}>{messages.en.preview}</Button>
    {previewed ? <p role="status" className="text-sm">Saved preview opened</p> : null}
  </div>;
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

/** Leaving Status retains a retirement receipt retry even though no editable field is dirty. */
export const UnresolvedRetirementGuardsExitAcrossSections: Story = {
  beforeEach() {
    lifecycleCommandCalls.length = 0;
    lifecycleRedirects = 0;
  },
  render: () => <ZoneEditorDraftProvider zoneId={zoneId} actingSubject={actor}>
    <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en"
      manageMessages={manageMessages} sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome}
      sectionNavigation={messages.en.sectionNavigation} sectionRealm={messages.en.sectionRealm}
      sectionTheme={messages.en.sectionTheme} sectionLifecycle={messages.en.sectionLifecycle}>
      <LifecycleExitControls />
    </ZoneEditorFrame>
  </ZoneEditorDraftProvider>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: messages.en.lifecycleRetire }));
    await userEvent.click(canvas.getByRole('button', { name: messages.en.lifecycleConfirmAction }));
    await expect(await canvas.findByText(messages.en.lifecycleFailureUnavailable, { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Theme editor' }));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    await expect(unload.defaultPrevented).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: messages.en.preview }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: messages.en.exitSave }));
    await expect(await canvas.findByText('Saved preview opened', { exact: true })).toBeVisible();
    await expect(lifecycleCommandCalls).toHaveLength(3);
    await expect(lifecycleCommandCalls[1]).toEqual(lifecycleCommandCalls[0]);
    await expect(lifecycleCommandCalls[2]).toEqual(lifecycleCommandCalls[0]);
    await expect(lifecycleRedirects).toBe(0);
    await userEvent.click(canvas.getByRole('button', { name: 'Status editor' }));
    await expect(await canvas.findByText(messages.en.lifecycleRetiredReplay, { exact: true })).toBeVisible();
    await expect(canvas.getByText(messages.en.lifecycleStatusRetired, { exact: true })).toBeVisible();
  },
};
