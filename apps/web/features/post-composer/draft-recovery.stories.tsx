import type { ComponentProps } from 'react';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/button';
import { fromPlainText, normalizeDocument, parseStoredDocument, serializeDocument, withDocumentIds } from '@rezics/document';
import { PostComposer } from './composer.tsx';
import { postText } from './messages.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { forgetReadingLanguages } from '../content-language/use-reading-languages.ts';
import { messages as editorMessages } from '../document-editor/messages.ts';
import { newPostProgress } from './api.ts';
import { MediaImageProvider } from '@rezics/ui/media-image';
import { mediaMessages } from '../document-editor/media-messages.ts';

const actor = 'https://rezics.com/id/a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a';
const realm = 'https://rezics.com/id/7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';
const work = 'https://rezics.com/id/d0e1f2a3-b4c5-4d6e-8f7a-000000000001';
const draftKey = `rezics:post-draft:${actor}`;
const representationId = '11111111-1111-4111-8111-111111111111';
const mediaUseId = '33333333-3333-4333-8333-333333333333';
const rootRevision = 'https://rezics.com/id/44444444-4444-4444-8444-444444444444';
const imageDraft = serializeDocument(normalizeDocument({ ...fromPlainText('Keep the text through failures.', 'blocks'),
  doc: withDocumentIds({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Keep the text through failures.' }] },
    { type: 'image', attrs: { id: '22222222-2222-4222-8222-222222222222', representationId, mediaUseId,
      src: `/api/main/v1/media/representations/${representationId}/bytes?use=${mediaUseId}` } },
  ] }) }));

function ReopenComposer(args: ComponentProps<typeof PostComposer>) {
  const [generation, reopen] = useState(0);
  return <main className="grid max-w-3xl gap-5 p-5">
    <Button type="button" variant="outline" onClick={() => reopen(value => value + 1)}>Reopen draft</Button>
    <PostComposer key={generation} {...args} />
  </main>;
}

const meta = {
  title: 'Compose/Draft recovery', component: PostComposer,
  args: { locale: 'en', actingSubject: actor },
  render: args => <ReopenComposer {...args} />,
  decorators: [(Story, context) => <ShellProvider locale={context.args.locale} messages={shellMessages}
    initialTheme="light" initialCollapsed={false} signedIn>
      <MediaImageProvider viewer={{ ready: true, signedIn: true, age: 'adult', optIns: { general: true, r15: false, sexual: false, grotesque: false } }}
        labels={mediaMessages[context.args.locale]}><Story /></MediaImageProvider>
    </ShellProvider>],
  beforeEach({ parameters }) {
    forgetReadingLanguages();
    const snapshot = parameters.recovery === 'snapshot';
    const body = parameters.recovery === 'image' || snapshot ? imageDraft : 'Keep the text through failures.';
    const intent = { realm, work, mainVersion: 'https://rezics.com/id/d0e1f2a3-b4c5-4d6e-8f7a-000000000002',
      title: 'A complete draft', body, spoiler: false, language: 'en', actingSubject: actor };
    const complete = parseStoredDocument(imageDraft)!;
    localStorage.setItem(draftKey, JSON.stringify({ community: { id: realm, name: 'Fiction Harbor' },
      work: { id: work, mainVersion: 'https://rezics.com/id/d0e1f2a3-b4c5-4d6e-8f7a-000000000002', title: 'The last letter' },
      title: 'A complete draft', body,
      ...(parameters.recovery === 'image' || snapshot ? { bodyFormat: 'document' } : {}),
      ...(snapshot ? {
        // The last complete body is older than the raw recovery. Keep its acknowledged image basis.
        imageDraft: { intent, progress: { ...newPostProgress(), rootRevision,
          revisionId: '55555555-5555-4555-8555-555555555555', digest: 'a'.repeat(64), writeState: 'acknowledged' } },
        recoveryBody: JSON.stringify({ ...complete, doc: withDocumentIds({ type: 'doc', content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Retained current text.', marks: [{ type: 'bold' }] }] },
          ...complete.doc.content!.filter(node => node.type === 'image'),
          { type: 'image', attrs: { src: '/invalid-image.png', representationId: 'invalid' } },
        ] }) }),
      } : {}), spoiler: false, language: 'en', progress: null }));
    let failed = false;
    const original = window.fetch.bind(window);
    const fetch = spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
      if (!path.startsWith('/api/main/')) return original(input, init);
      if (path.endsWith('/media/metadata')) return Response.json({ code: 'unavailable' }, { status: 503 });
      if (path.endsWith('/person-preferences')) return Response.json({ contentLanguages: ['en'] });
      if (path.endsWith('/selection')) {
        if (parameters.recovery !== 'unknown' && !failed) { failed = true; return Response.json({ code: 'unavailable' }, { status: 503 }); }
        return Response.json({ work, selectedDraft: rootRevision });
      }
      if (path.endsWith('/member-reply-drafts')) {
        if (parameters.recovery === 'unknown' && !failed) { failed = true; throw new TypeError('Write response lost'); }
        const command = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body));
        return Response.json({ reply: command.reply, variantId: command.variantId, deleted: false,
          revisionId: '00000000-0000-4000-8000-000000000003', revisionDigest: 'a'.repeat(64) });
      }
      if (path.endsWith('/realm-replies')) return Response.json({});
      if (path.endsWith('/realm-reply-placements')) {
        const body = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body));
        return Response.json({ reply: body.reply });
      }
      if (path.includes('/threads/')) return Response.json({ code: 'reply_unavailable' }, { status: 404 });
      if (path.endsWith(`/realms/${realm.slice(-36)}`)) return Response.json({ realm, reviewMode: 'open', rules: [] });
      if (path.endsWith('/realms')) return Response.json({ items: [] });
      throw new Error(`Unexpected recovery request: ${path}`);
    });
    const setItem = Storage.prototype.setItem;
    const storage = parameters.recovery === 'storage' ? spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === draftKey) throw new DOMException('Device full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    }) : undefined;
    return () => { fetch.mockRestore(); storage?.mockRestore(); localStorage.removeItem(draftKey); forgetReadingLanguages(); };
  },
} satisfies Meta<typeof PostComposer>;
export default meta;
type Story = StoryObj<typeof meta>;

async function post(canvasElement: HTMLElement, locale: ComponentProps<typeof PostComposer>['locale'], retry = false) {
  const button = await within(canvasElement).findByRole('button', { name: (retry ? postText.retryPost : postText.post)[locale] });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

export const UnwrittenAttemptAfterReopen: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), t = postText;
    await expect(await canvas.findByDisplayValue('A complete draft')).not.toHaveAttribute('readonly');
    await post(canvasElement, args.locale);
    await expect(await canvas.findByText(t.unwritten[args.locale])).toBeVisible();
    const requests = (window.fetch as typeof fetch & { mock: { calls: [RequestInfo | URL, RequestInit?][] } }).mock.calls;
    await expect(requests.some(([input]) => /member-reply-drafts|realm-repl(?:ies|y-placements)/.test(input instanceof Request ? input.url : String(input)))).toBe(false);
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    const title = await canvas.findByDisplayValue('A complete draft');
    await expect(title).not.toHaveAttribute('readonly');
    await userEvent.type(title, ' revised');
    await expect(canvas.getByRole('textbox', { name: t.body[args.locale] })).toHaveAttribute('contenteditable', 'true');
    await expect(canvas.getByRole('checkbox', { name: t.spoiler[args.locale] })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: new RegExp(t.postLanguage[args.locale]) })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: t.workChange[args.locale] })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: t.communityChange[args.locale] }));
    await expect(await canvas.findByRole('searchbox', { name: t.communitySearch[args.locale] })).toBeEnabled();
  },
};

export const CancelUnwrittenAttempt: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await post(canvasElement, args.locale);
    await userEvent.click(await canvas.findByRole('button', { name: postText.cancelAttempt[args.locale] }));
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.getByDisplayValue('A complete draft')).not.toHaveAttribute('readonly');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey)!).progress).toBeNull());
    await expect(canvas.getByRole('textbox', { name: postText.body[args.locale] })).toHaveTextContent('Keep the text through failures.');
  },
};

export const UnknownWriteAfterReopen: Story = {
  parameters: { recovery: 'unknown' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await post(canvasElement, args.locale);
    await expect(await canvas.findByText(postText.writeUnknown[args.locale])).toBeVisible();
    const key = JSON.parse(localStorage.getItem(draftKey)!).progress.key;
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    await expect(await canvas.findByDisplayValue('A complete draft')).toHaveAttribute('readonly');
    await expect(await canvas.findByText(postText.writeUnknown[args.locale])).toBeVisible();
    await expect(canvas.queryByRole('button', { name: postText.cancelAttempt[args.locale] })).toBeNull();
    await expect(JSON.parse(localStorage.getItem(draftKey)!).progress.key).toBe(key);
    await post(canvasElement, args.locale, true);
    await expect(await canvas.findByText(postText.postedAppearing[args.locale])).toBeVisible();
  },
};

export const DeviceStorageUnavailable: Story = {
  parameters: { recovery: 'storage' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(postText.draftSaveFailed[args.locale])).toBeVisible();
    await expect(canvas.queryByText(postText.draftSaved[args.locale])).toBeNull();
    await expect(canvas.getByRole('button', { name: postText.retrySave[args.locale] })).toBeVisible();
    await expect(canvas.getByRole('button', { name: postText.exportDraft[args.locale] })).toBeVisible();
    await post(canvasElement, args.locale);
    const requests = (window.fetch as typeof fetch & { mock: { calls: [RequestInfo | URL, RequestInit?][] } }).mock.calls;
    await expect(requests.some(([input]) => /member-reply-drafts|realm-repl(?:ies|y-placements)/.test(input instanceof Request ? input.url : String(input)))).toBe(false);
    await expect(canvas.getByDisplayValue('A complete draft')).not.toHaveAttribute('readonly');
  },
};

export const StableImageWithoutPreview: Story = {
  parameters: { recovery: 'image' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(postText.draftSaved[args.locale])).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    const editor = await canvas.findByRole('textbox', { name: postText.body[args.locale] });
    await expect(editor).toHaveTextContent('Keep the text through failures.');
    const stored = parseStoredDocument(JSON.parse(localStorage.getItem(draftKey)!).body);
    await expect(stored?.doc.content?.find(node => node.type === 'image')?.attrs).toMatchObject({ representationId, mediaUseId });
    await expect(await canvas.findByText(postText.draftSaved[args.locale])).toBeVisible();
  },
};

export const SnapshotFailureKeepsCurrentText: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: postText.body[args.locale] });
    await userEvent.click(editor);
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', '<p>Retained current text.</p><img src="/invalid-image.png" data-representation-id="invalid" />');
    clipboard.setData('text/plain', 'Retained current text.');
    await userEvent.paste(clipboard);
    await expect(await canvas.findByText(postText.draftIncomplete[args.locale])).toBeVisible();
    await expect(canvas.queryByText(postText.draftSaved[args.locale])).toBeNull();
    await expect(canvas.getByRole('button', { name: postText.post[args.locale] })).toBeDisabled();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey)!).recoveryBody).toContain('Retained current text.'));
    await expect(canvas.getByRole('button', { name: editorMessages[args.locale].exportDocument })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: editorMessages[args.locale].removeImages }));
    await expect(await canvas.findByText(postText.draftSaved[args.locale])).toBeVisible();
    await expect(editor).toHaveTextContent('Retained current text.');
  },
};

const unwrittenRecovery: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), locale = args.locale;
    await post(canvasElement, locale);
    const cancel = await canvas.findByRole('button', { name: postText.cancelAttempt[locale] });
    cancel.focus();
    await userEvent.keyboard('{Enter}');
    const editor = canvas.getByRole('textbox', { name: postText.body[locale] });
    await expect(editor).toHaveFocus();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.getByDisplayValue('A complete draft')).not.toHaveAttribute('readonly');
    // Testing Library does not implement End selection inside a contenteditable.
    // Paste into the restored focus; preserve outcomes without depending on caret-node shape.
    await userEvent.paste('Continued after cancel. ');
    await expect(editor).toHaveTextContent('Continued after cancel.');
    await expect(editor).toHaveTextContent('Keep the text through failures.');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey)!).progress).toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    await expect(await canvas.findByRole('textbox', { name: postText.body[locale] })).toHaveTextContent('Continued after cancel.');
    await expect(await canvas.findByText(postText.draftSaved[locale])).toBeVisible();
  },
};
export const UnwrittenPhone: Story = { ...unwrittenRecovery, globals: { viewport: { value: 'phone' } } };
export const UnwrittenPhoneChinese: Story = { ...unwrittenRecovery, args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

const storageRecovery: Story = {
  parameters: { recovery: 'storage' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), t = postText, locale = args.locale;
    await expect(await canvas.findByText(t.draftSaveFailed[locale])).toBeVisible();
    const title = canvas.getByDisplayValue('A complete draft');
    await userEvent.type(title, ' revised');
    await expect(canvas.queryByText(t.draftSaved[locale])).toBeNull();
    await expect(JSON.parse(localStorage.getItem(draftKey)!).title).toBe('A complete draft');

    const create = spyOn(URL, 'createObjectURL');
    const download = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await userEvent.click(canvas.getByRole('button', { name: t.exportDraft[locale] }));
      await expect(download).toHaveBeenCalled();
      const exported = create.mock.calls.at(-1)![0] as Blob;
      await expect(JSON.parse(await exported.text())).toMatchObject({ title: 'A complete draft revised', body: 'Keep the text through failures.' });
    } finally { create.mockRestore(); download.mockRestore(); }

    const retry = canvas.getByRole('button', { name: t.retrySave[locale] });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(t.draftSaveFailed[locale])).toBeVisible();
    await expect(retry).toHaveFocus();
    await expect(canvas.queryByText(t.draftSaved[locale])).toBeNull();
    // Restore only the failed platform operation, then exercise the component's Retry.
    (Storage.prototype.setItem as typeof Storage.prototype.setItem & { mockRestore: () => void }).mockRestore();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(t.draftSaved[locale])).toBeVisible();
    await expect(canvas.queryByRole('button', { name: t.retrySave[locale] })).toBeNull();
    await expect(canvas.getByRole('textbox', { name: t.body[locale] })).toHaveFocus();
    await userEvent.paste('Continued after saving. ');
    await expect(canvas.getByRole('textbox', { name: t.body[locale] })).toHaveTextContent('Continued after saving.');
    await expect(canvas.getByRole('textbox', { name: t.body[locale] })).toHaveTextContent('Keep the text through failures.');
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    await expect(await canvas.findByDisplayValue('A complete draft revised')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: t.body[locale] })).toHaveTextContent('Continued after saving.');
    await expect(await canvas.findByText(t.draftSaved[locale])).toBeVisible();
  },
};

export const DeviceStorageRecoveryPhone: Story = { ...storageRecovery, globals: { viewport: { value: 'phone' } } };
export const DeviceStorageRecoveryPhoneChinese: Story = { ...storageRecovery, args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };
