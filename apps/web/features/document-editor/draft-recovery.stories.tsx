import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { fromPlainText, normalizeDocument, parseStoredDocument, serializeDocument, withDocumentIds } from '@rezics/document';
import { Button } from '@rezics/ui/button';
import { BodyEditor } from './body-editor.tsx';
import { messages } from './messages.ts';
import type { DocumentSaveState } from './publication.ts';
import type { UiLocale } from '../../i18n/define.ts';

const key = 'rezics:story:complete-image-draft';
const representationId = '11111111-1111-4111-8111-111111111111';
const mediaUseId = '33333333-3333-4333-8333-333333333333';
const initial = serializeDocument(fromPlainText('Keep text and image together.', 'blocks'));
const stableImage = { type: 'image', attrs: { id: '22222222-2222-4222-8222-222222222222', representationId, mediaUseId,
  src: `/api/main/v1/media/representations/${representationId}/bytes?use=${mediaUseId}` } };
const savedImage = serializeDocument(normalizeDocument({ ...fromPlainText('Keep text and image together.', 'blocks'),
  doc: withDocumentIds({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Keep text and image together.' }] }, stableImage,
  ] }) }));
const recoveryImage = serializeDocument(normalizeDocument({ ...fromPlainText('Current text and both images.', 'blocks'),
  doc: withDocumentIds({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Current text and both images.' }] }, stableImage,
    { type: 'image', attrs: { id: '44444444-4444-4444-8444-444444444444', representationId,
      src: `/api/main/v1/media/representations/${representationId}/bytes` } },
  ] }) }));

function CompleteDraft({ locale = 'en', bind = false, failUpload = false, arranged = false }: { locale?: UiLocale; bind?: boolean; failUpload?: boolean; arranged?: boolean }) {
  const [saved, setSaved] = useState(arranged ? savedImage : initial);
  const [retained, setRetained] = useState<string | undefined>(arranged ? recoveryImage : undefined);
  const [generation, reopen] = useState(0);
  const [state, setState] = useState<DocumentSaveState>('ready');
  return <div className="grid max-w-3xl gap-3 p-5">
    <BodyEditor key={generation} compact label="Complete draft" locale={locale} value={saved} recoveryValue={retained}
      actingSubject="https://rezics.com/id/71473997-6e2e-4e59-9044-01627a79e839"
      mediaTarget="https://rezics.com/id/01a14f4e-526a-706c-9404-479d17f3e7ba" onSaveStateChange={setState}
      onRecoveryChange={recoveryBody => { setRetained(recoveryBody); localStorage.setItem(key, JSON.stringify({ body: saved, recoveryBody })); }}
      onChange={body => { setSaved(body); setRetained(undefined); localStorage.setItem(key, JSON.stringify({ body })); }}
      onUploadImage={async () => {
        if (failUpload) throw new Error('Upload unavailable');
        return { src: `/api/main/v1/media/representations/${representationId}/bytes${bind ? '' : `?use=${mediaUseId}`}`,
          representationId, ...(bind ? {} : { mediaUseId }) };
      }}
      resolveImageMetadata={async () => { throw new Error('Preview metadata unavailable'); }} />
    <output aria-label="Draft state">{state}</output>
    <output aria-label="Saved image count">{parseStoredDocument(saved)?.doc.content?.filter(node => node.type === 'image').length ?? 0}</output>
    <Button type="button" variant="outline" onClick={() => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
      setSaved(stored.body ?? initial); setRetained(stored.recoveryBody); reopen(value => value + 1);
    }}>Reopen draft</Button>
  </div>;
}

const meta = {
  title: 'Post Composer/Complete image drafts', component: CompleteDraft,
  beforeEach() {
    localStorage.removeItem(key);
    let refused = false;
    const original = window.fetch.bind(window);
    const fetch = spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
      if (!path.endsWith('/v1/media/uses')) return original(input, init);
      if (!refused) { refused = true; return Response.json({ code: 'unavailable' }, { status: 503 }); }
      return Response.json({ use: mediaUseId });
    });
    return () => { fetch.mockRestore(); localStorage.removeItem(key); };
  },
} satisfies Meta<typeof CompleteDraft>;
export default meta;
type Story = StoryObj<typeof meta>;

async function upload(canvasElement: HTMLElement, locale: UiLocale = 'en') {
  const canvas = within(canvasElement), t = messages[locale];
  const editor = await canvas.findByRole('textbox', { name: 'Complete draft' });
  await userEvent.click(editor);
  await userEvent.click(canvas.getByRole('button', { name: t.image }));
  const picker = await canvas.findByLabelText(t.uploadFile);
  await userEvent.upload(picker, new File(['image bytes'], 'draft.png', { type: 'image/png' }));
}

export const StableImageWithoutPreview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await upload(canvasElement);
    await waitFor(() => expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('1'));
    await expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready');
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    await expect(canvas.getByRole('textbox', { name: 'Complete draft' })).toHaveTextContent('Keep text and image together.');
    await expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('1');
  },
};

export const RetryBindingAfterReopen: Story = {
  args: { bind: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await upload(canvasElement);
    await waitFor(() => expect(canvas.getByLabelText('Draft state')).toHaveTextContent('failed'));
    await expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('0');
    const retained = JSON.parse(localStorage.getItem(key)!).recoveryBody;
    await expect(parseStoredDocument(retained)?.doc.content?.some(node => node.type === 'image')).toBe(true);
    await expect(canvas.getByRole('button', { name: messages.en.exportDocument })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    await waitFor(() => expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('1'));
    await expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready');
  },
};

export const RemoveFailedImage: Story = {
  args: { bind: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await upload(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: messages.en.removeImages }));
    await waitFor(() => expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready'));
    await expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('0');
    await expect(canvas.getByRole('textbox', { name: 'Complete draft' })).toHaveTextContent('Keep text and image together.');
  },
};

export const CancelFailedUpload: Story = {
  args: { failUpload: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await upload(canvasElement);
    await waitFor(() => expect(canvas.getByLabelText('Draft state')).toHaveTextContent('failed'));
    await userEvent.click(canvas.getByRole('button', { name: messages.en.cancel }));
    await waitFor(() => expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready'));
    await expect(canvas.getByRole('textbox', { name: 'Complete draft' })).toHaveTextContent('Keep text and image together.');
  },
};

const retryRecovery: Story = {
  args: { arranged: true },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const t = messages[args.locale ?? 'en'];
    await waitFor(() => expect(canvas.getByLabelText('Draft state')).toHaveTextContent('failed'));
    const editor = canvas.getByRole('textbox', { name: 'Complete draft' });
    await expect(editor).toHaveTextContent('Current text and both images.');
    await expect(editor.querySelectorAll('figure')).toHaveLength(2);
    await expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('1');
    const retained = JSON.parse(localStorage.getItem(key)!).recoveryBody;
    await expect(retained).toContain('Current text and both images.');

    const create = spyOn(URL, 'createObjectURL');
    const download = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await userEvent.click(canvas.getByRole('button', { name: t.exportDocument }));
      await expect(download).toHaveBeenCalled();
      const exported = JSON.parse(await (create.mock.calls.at(-1)![0] as Blob).text());
      await expect(exported).toEqual(JSON.parse(retained));
      await expect(JSON.parse(localStorage.getItem(key)!).recoveryBody).toBe(retained);
    } finally { create.mockRestore(); download.mockRestore(); }

    const retry = canvas.getByRole('button', { name: t.retrySave });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready'));
    await expect(editor).toHaveFocus();
    await expect(editor).toHaveTextContent('Current text and both images.');
    await expect(canvas.queryByRole('button', { name: t.retrySave })).toBeNull();
    await expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('2');
    const stored = JSON.parse(localStorage.getItem(key)!);
    await expect(stored.recoveryBody).toBeUndefined();
    await expect(parseStoredDocument(stored.body)?.doc.content?.filter(node => node.type === 'image').map(node => node.attrs))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: stableImage.attrs.id, representationId, mediaUseId }),
        expect.objectContaining({ id: '44444444-4444-4444-8444-444444444444', representationId, mediaUseId }),
      ]));
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    const reopened = await canvas.findByRole('textbox', { name: 'Complete draft' });
    await expect(reopened).toHaveTextContent('Current text and both images.');
    await expect(reopened.querySelectorAll('figure')).toHaveLength(2);
    await expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready');
    await userEvent.click(reopened);
  },
};

export const ImageRecoveryPhone: Story = { ...retryRecovery, globals: { viewport: { value: 'phone' } } };
export const ImageRecoveryPhoneChinese: Story = { ...retryRecovery, args: { arranged: true, locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

const removeRecovery: Story = {
  args: { arranged: true },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), t = messages[args.locale ?? 'en'];
    const remove = await canvas.findByRole('button', { name: t.removeImages });
    const editor = canvas.getByRole('textbox', { name: 'Complete draft' });
    await expect(editor).toHaveTextContent('Current text and both images.');
    remove.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready'));
    await expect(editor).toHaveFocus();
    await expect(editor).toHaveTextContent('Current text and both images.');
    await expect(editor.querySelectorAll('figure')).toHaveLength(0);
    await expect(canvas.queryByRole('button', { name: t.removeImages })).toBeNull();
    await expect(JSON.parse(localStorage.getItem(key)!).recoveryBody).toBeUndefined();
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    await expect(await canvas.findByRole('textbox', { name: 'Complete draft' })).toHaveTextContent('Current text and both images.');
    await expect(canvas.getByLabelText('Saved image count')).toHaveTextContent('0');
    await expect(canvas.getByLabelText('Draft state')).toHaveTextContent('ready');
  },
};

export const RemoveRecoveryPhone: Story = { ...removeRecovery, globals: { viewport: { value: 'phone' } } };
export const RemoveRecoveryPhoneChinese: Story = { ...removeRecovery, args: { arranged: true, locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };
