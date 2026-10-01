import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CoverEditor } from './cover-editor.tsx';
import { agents, ids } from './fixtures.ts';
import { messages } from './messages.ts';

const work = { id: ids.serial, title: { value: '雨夜书店', language: 'zh-Hans' },
  types: ['https://schema.org/Book'] };

/**
 * Main's reserve, byte upload and selection replies; the reserve can pause to expose the saving state.
 * `clearance` is what screening says about the new image, `later` what the next status read says, and
 * `retryAfter` a spent upload budget (G-543's `429`).
 */
function coverServer(options: { clearance?: string; later?: string; retryAfter?: number } = {}) {
  let release: (() => void) | undefined;
  const reserved = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const send = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/media/uploads')) {
      await reserved;
      if (options.retryAfter) return Response.json({ status: 429, code: 'rate_limited' },
        { status: 429, headers: { 'retry-after': String(options.retryAfter) } });
      return Response.json({ asset: 'asset-1', upload: 'upload-1' });
    }
    if (url.endsWith('/bytes')) return Response.json({ status: 'activated', clearance: options.clearance ?? 'cleared' });
    if (url.endsWith('/media/uploads/upload-1')) return Response.json({ clearance: options.later ?? options.clearance ?? 'cleared' });
    if (url.endsWith('/avatar')) return Response.json({ selection: 'selection-1' });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { send, calls, release: () => release?.() };
}

async function saveCover(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const input = canvas.getByLabelText('Choose an image') as HTMLInputElement;
  const source = document.createElement('canvas');
  source.width = 90; source.height = 60;
  source.getContext('2d')!.fillRect(0, 0, 90, 60);
  const image = await new Promise<Blob>(resolve => source.toBlob(blob => resolve(blob!), 'image/png'));
  await userEvent.upload(input, new File([image], 'cover.png', { type: 'image/png' }));
  const dialog = await within(document.body).findByRole('dialog', { name: 'Frame the cover' });
  const save = within(dialog).getByRole('button', { name: 'Use this cover' });
  await waitFor(() => expect(save).toBeEnabled());
  await userEvent.click(save);
  return { canvas, dialog };
}

let server = coverServer();
const meta = {
  title: 'Studio/CoverEditor',
  component: CoverEditor,
  parameters: { route: { pathname: '/en/studio/@agent-00000000-0000-4000-8000-000000000001/works/'
    + '00000000-0000-4000-8000-000000000101?tab=details' } },
  args: { agent: agents[0]!, work, cover: null, locale: 'en', messages, send: ((...args) => server.send(...args)) as typeof fetch },
  beforeEach() { server = coverServer(); },
} satisfies Meta<typeof CoverEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Choosing, framing, saving and returning to the cover step, including a paused Main response. */
export const SaveCover: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('Choose an image') as HTMLInputElement;
    const source = document.createElement('canvas');
    source.width = 90; source.height = 60;
    source.getContext('2d')!.fillRect(0, 0, 90, 60);
    const image = await new Promise<Blob>(resolve => source.toBlob(blob => resolve(blob!), 'image/png'));
    await userEvent.upload(input, new File([image], 'cover.png', { type: 'image/png' }));

    const dialog = await within(document.body).findByRole('dialog', { name: 'Frame the cover' });
    const save = within(dialog).getByRole('button', { name: 'Use this cover' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await expect(within(dialog).getByRole('button', { name: 'Uploading…' })).toBeDisabled();
    server.release();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await expect(canvas.getByText('Cover updated.')).toBeVisible();
    await expect(server.calls).toHaveLength(3);
  },
};

/** A cover Main has cleared reads Visible. */
export const CoverVisible: Story = {
  async play({ canvasElement }) {
    server.release();
    const { canvas } = await saveCover(canvasElement);
    await waitFor(() => expect(canvas.getByText('Visible')).toBeVisible());
  },
};

/** A new cover is Checking while screening runs, and turns Visible when the next look finds it cleared. */
export const CoverCheckingThenVisible: Story = {
  beforeEach() { server = coverServer({ clearance: 'screening', later: 'cleared' }); },
  async play({ canvasElement }) {
    server.release();
    const { canvas } = await saveCover(canvasElement);
    await waitFor(() => expect(canvas.getByText('Checking')).toBeVisible());
    await waitFor(() => expect(canvas.getByText('Visible')).toBeVisible(), { timeout: 8000 });
  },
};

/** A held cover is Under review and visible to its uploader alone; nothing asks them to act. */
export const CoverUnderReview: Story = {
  beforeEach() { server = coverServer({ clearance: 'held' }); },
  async play({ canvasElement }) {
    server.release();
    const { canvas } = await saveCover(canvasElement);
    await waitFor(() => expect(canvas.getByText('Under review')).toBeVisible());
    await expect(canvas.getByText(/Only you can see this image while our team reviews it/)).toBeVisible();
  },
};

/** An image Main rejected is Not accepted and is not made the cover. */
export const CoverNotAccepted: Story = {
  beforeEach() { server = coverServer({ clearance: 'rejected' }); },
  async play({ canvasElement }) {
    server.release();
    const { canvas } = await saveCover(canvasElement);
    await waitFor(() => expect(canvas.getByText('Not accepted')).toBeVisible());
    await expect(server.calls.some(url => url.endsWith('/avatar'))).toBe(false);
  },
};

/** A spent upload budget says when to try again, from Retry-After. */
export const UploadLimit: Story = {
  beforeEach() { server = coverServer({ retryAfter: 120 }); },
  async play({ canvasElement }) {
    server.release();
    const { canvas } = await saveCover(canvasElement);
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('2 minutes'));
  },
};
