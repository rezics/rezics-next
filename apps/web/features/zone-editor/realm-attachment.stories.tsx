import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ZoneRealmAttachmentClient, ZoneRealmAttachmentWrite } from './api.ts';
import { ZoneEditorDraftProvider } from './draft-provider.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { copyOf } from './messages.ts';
import { RealmAttachmentEditor } from './realm-attachment.tsx';

const meta = { title: 'Zone editor/Realm attachment', component: RealmAttachmentEditor,
  args: {
    zoneId: '00000000-0000-4000-8000-000000000301',
    actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000302',
    copy: copyOf('en'),
    zoneHead: 'https://rezics.com/id/00000000-0000-4000-8000-000000000304',
    attachedName: null,
    signInHref: '/auth/start',
    startingNotice: 'limit',
  } } satisfies Meta<typeof RealmAttachmentEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The attach refusal when that community already has every site it can. */
export const AtTheAttachmentLimit: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('This community is linked to the most sites it can be.');
    await expect(canvas.getByRole('button', { name: 'Attach' })).toBeVisible();
  },
};

const realmA = 'https://rezics.com/id/00000000-0000-4000-8000-000000000321';
const realmB = 'https://rezics.com/id/00000000-0000-4000-8000-000000000322';
const headA = 'https://rezics.com/id/00000000-0000-4000-8000-000000000323';
const headB = 'https://rezics.com/id/00000000-0000-4000-8000-000000000324';
const savedHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000325';
let writes: Array<{ body: ZoneRealmAttachmentWrite; key: string }> = [];
let reads = 0;
let resolutions = 0;

function AttachmentScenario({ mode }: { mode: 'stale' | 'lost' | 'denied' | 'exit' }) {
  const [section, setSection] = useState<'realm' | 'home'>('realm');
  const [api] = useState<ZoneRealmAttachmentClient>(() => {
    writes = [];
    reads = 0;
    resolutions = 0;
    return {
      async resolveRealmHandle(handle) {
        resolutions += 1;
        await expect(handle).toBe('harbor');
        return { ok: true, data: { realm: realmA, name: 'Harbor community' } };
      },
      async readConfiguration() {
        reads += 1;
        if (mode === 'stale' && reads === 1) return { ok: false, failure: 'unavailable' };
        return { ok: true, data: { revision: headB, realm: realmB, name: 'Tides community' } };
      },
      async saveConfiguration(_zone, body, key) {
        writes.push({ body: { ...body }, key });
        if (mode === 'stale' && writes.length === 1) return { ok: false, failure: 'stale', currentHead: headB };
        if (mode === 'lost' && writes.length <= 2) return { ok: false, failure: 'unavailable' };
        if (mode === 'denied') return { ok: false, failure: 'denied' };
        return { ok: true, data: { revision: savedHead, replayed: mode === 'lost' } };
      },
    };
  });
  const zoneId = `00000000-0000-4000-8000-00000000033${mode === 'stale' ? '1' : mode === 'lost' ? '2' : mode === 'denied' ? '3' : '4'}`;
  return <main className="mx-auto grid max-w-xl gap-4 p-6">
    <h1 className="text-xl font-semibold">Realm attachment</h1>
    <ZoneEditorDraftProvider zoneId={zoneId} actingSubject={meta.args.actingSubject}>
      <nav className="flex gap-2" aria-label="Editor sections">
        <button className="rounded-md border px-3 py-2 text-sm" onClick={() => setSection('home')}>Go to Home</button>
        <button className="rounded-md border px-3 py-2 text-sm" onClick={() => setSection('realm')}>Go to Realm</button>
      </nav>
      {section === 'realm' ? <RealmAttachmentEditor zoneId={zoneId} actingSubject={meta.args.actingSubject}
        copy={copyOf('en')} zoneHead={headA} attachedRealm={mode === 'stale' ? realmA : null}
        attachedName={mode === 'stale' ? 'Harbor community' : null} signInHref="/auth/start" api={api} />
        : <p>Home section</p>}
      {mode === 'exit' ? <LocalizedLink href="/manage/z/harbor/preview" documentNavigation
        className="text-sm underline">Preview saved site</LocalizedLink> : null}
    </ZoneEditorDraftProvider>
  </main>;
}

export const StaleRemovalRequiresReviewOfReplacement: Story = {
  render: () => <AttachmentScenario mode="stale" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /^Remove$/ }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('The attached Realm changed.');
    await expect(writes).toHaveLength(1);
    await expect(reads).toBe(0);
    await expect(canvas.getByRole('button', { name: /^Remove$/ })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Review current attachment' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Your attachment choice is still here; try again.');
    await expect(canvas.getByText('Harbor community')).toBeVisible();
    await expect(writes).toHaveLength(1);
    await expect(reads).toBe(1);
    await expect(canvas.queryByRole('button', { name: 'Retry attachment change' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Review current attachment' }));
    await expect(await canvas.findByText('Tides community')).toBeVisible();
    await expect(writes).toHaveLength(1);
    await expect(reads).toBe(2);
    await expect(canvas.getByRole('button', { name: /^Remove$/ })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Apply change to reviewed attachment' }));
    await expect(await canvas.findByText('Removed. This Zone no longer shows that Realm.')).toBeVisible();
    await expect(writes).toHaveLength(2);
    await expect(writes[0]!.body).toEqual({ expectedHead: headA, actingSubject: meta.args.actingSubject, defaultRealm: null });
    await expect(writes[1]!.body).toEqual({ expectedHead: headB, actingSubject: meta.args.actingSubject, defaultRealm: null });
    await expect(writes[1]!.key).not.toBe(writes[0]!.key);
  },
};

export const CommittedResponseRetryRetainsEnvelopeAndLaterTyping: Story = {
  render: () => <AttachmentScenario mode="lost" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: 'Realm handle' }), 'harbor');
    await userEvent.click(canvas.getByRole('button', { name: /^Attach$/ }));
    await expect(await canvas.findByRole('button', { name: 'Retry attachment change' })).toBeVisible();
    await waitFor(() => expect(writes).toHaveLength(2));
    const input = canvas.getByRole('textbox', { name: 'Realm handle' });
    await userEvent.clear(input);
    await userEvent.type(input, 'tides');
    await userEvent.click(canvas.getByRole('button', { name: 'Go to Home' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Go to Realm' }));
    await expect(await canvas.findByRole('textbox', { name: 'Realm handle' })).toHaveValue('tides');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry attachment change' }));
    await expect(await canvas.findByText('Attached. This Zone shows that Realm.')).toBeVisible();
    await expect(writes).toHaveLength(3);
    await expect(writes[1]).toEqual(writes[0]);
    await expect(writes[2]).toEqual(writes[0]);
    await expect(writes[0]!.body).toEqual({ expectedHead: headA, actingSubject: meta.args.actingSubject, defaultRealm: realmA });
    await expect(reads).toBe(0);
    await expect(resolutions).toBe(1);
    await expect(canvas.getByRole('textbox', { name: 'Realm handle' })).toHaveValue('tides');
    await expect(canvas.getByText('Harbor community')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /^Remove$/ }));
    await expect(await canvas.findByText('Removed. This Zone no longer shows that Realm.')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Realm handle' })).toHaveValue('tides');
  },
};

export const DeniedSaveKeepsHandleThroughSectionChange: Story = {
  render: () => <AttachmentScenario mode="denied" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: 'Realm handle' }), 'harbor');
    await userEvent.click(canvas.getByRole('button', { name: /^Attach$/ }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Your Realm handle is still here.');
    await userEvent.click(canvas.getByRole('button', { name: 'Go to Home' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Go to Realm' }));
    await expect(await canvas.findByRole('textbox', { name: 'Realm handle' })).toHaveValue('harbor');
    await expect(canvas.getByRole('button', { name: /^Attach$/ })).toBeEnabled();
    await expect(writes).toHaveLength(1);
  },
};

export const DirtyAttachmentBlocksDocumentExit: Story = {
  render: () => <AttachmentScenario mode="exit" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const startingUrl = window.location.href;
    await userEvent.type(await canvas.findByRole('textbox', { name: 'Realm handle' }), 'harbor');
    await userEvent.click(canvas.getByRole('link', { name: 'Preview saved site' }));
    const screen = within(document.body);
    await expect(await screen.findByRole('dialog')).toHaveTextContent('Save your unsaved work before leaving?');
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await expect(canvas.getByRole('textbox', { name: 'Realm handle' })).toHaveValue('harbor');
    await expect(window.location.href).toBe(startingUrl);
    await expect(writes).toHaveLength(0);
  },
};
