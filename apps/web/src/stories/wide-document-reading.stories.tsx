import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { ThreadPostReadingBody } from '../threads/post-reading-body';
import { preparedPostReading } from './post-reading-fixtures';
import { PatternStory } from './page';

function WideDocumentReader({ retirement = false }: { retirement?: boolean }) {
  const [readerKey, setReaderKey] = useState('reader-a');
  const prepared = useMemo(() => preparedPostReading(6), []);
  return (
    <PatternStory visitor="Signed Out" path="/en/threads/prepared-wide-document-reading">
      <main className="mx-auto w-full max-w-5xl min-w-0 space-y-4 px-4 py-8 text-foreground">
        <h1 className="text-2xl font-semibold">Field notes / 観測記録</h1>
        <p className="max-w-prose text-muted-foreground">
          Inspect a code sample or comparison table, then return to the same published post.
        </p>
        {retirement ? (
          <button
            type="button"
            data-story-replace-reader="true"
            className="min-h-11 rounded-md border px-3"
            onClick={() => setReaderKey((current) => (current === 'reader-a' ? 'reader-b' : 'reader-a'))}
          >
            Replace reader visit
          </button>
        ) : null}
        <ThreadPostReadingBody
          post={prepared.post}
          documentMedia={prepared.page.documentMedia}
          mentions={{}}
          readerIdentity={readerKey}
          locale="en"
        />
      </main>
    </PatternStory>
  );
}

const meta = {
  title: 'Community/Wide document reading',
  id: 'pages-community-wide-document-reading',
  component: WideDocumentReader,
  parameters: {
    layout: 'fullscreen',
  },
  render: (args) => <WideDocumentReader {...args} />,
} satisfies Meta<typeof WideDocumentReader>;
export default meta;
type Story = StoryObj<typeof meta>;

function setClipboard(writeText: (value: string) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return () => {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous);
    else Reflect.deleteProperty(navigator, 'clipboard');
  };
}

async function inspectWrapCopyReturn({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  let copied = '';
  const suppliedCode = preparedPostReading(6).post.body.doc.content?.find((node) => node.type === 'codeBlock');
  const expectedCode = suppliedCode?.content?.map((node) => node.text ?? '').join('') ?? '';
  const restoreClipboard = setClipboard(async (value) => {
    copied = value;
  });
  try {
    const wrap = await canvas.findByRole('button', { name: m.wide_document_code_wrap() });
    await expect(wrap).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(wrap);
    await expect(wrap).toHaveAttribute('aria-pressed', 'false');

    const copy = canvas.getByRole('button', { name: m.wide_document_code_copy() });
    await userEvent.click(copy);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.wide_document_code_copied());
    await expect(copied).toBe(expectedCode);

    const trigger = canvas.getByRole('button', { name: m.wide_document_code_inspect() });
    await userEvent.click(trigger);
    const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
    await expect(within(dialog).getByRole('heading', { name: m.wide_document_code_title() })).toBeVisible();
    const close = within(dialog).getByRole('button', { name: m.wide_document_inspector_close() });
    await userEvent.click(close);
    await expect(trigger).toHaveFocus();

    const tableRegion = canvas.getByRole('region', { name: m.wide_document_table_scroll() });
    await expect(tableRegion).toHaveAttribute('tabindex', '0');
    await expect(tableRegion.querySelector('th[scope="col"]')).not.toBeNull();
    tableRegion.focus();
    await expect(tableRegion).toHaveFocus();
  } finally {
    restoreClipboard();
  }
}

async function clipboardFailure({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const restoreClipboard = setClipboard(async () => {
    throw new Error('Clipboard denied');
  });
  try {
    await userEvent.click(await canvas.findByRole('button', { name: m.wide_document_code_copy() }));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.wide_document_code_copy_failed());
    const manual = canvas.getByRole('textbox', { name: m.wide_document_code_manual_copy() });
    await expect(manual).toHaveValue(expect.stringContaining('console.log'));
    await expect(manual).toHaveAttribute('readonly');
  } finally {
    restoreClipboard();
  }
}

async function readerRetirement({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const trigger = await canvas.findByRole('button', { name: m.wide_document_code_inspect() });
  await userEvent.click(trigger);
  await expect(within(canvasElement.ownerDocument.body).getByRole('dialog')).toBeVisible();
  canvasElement.querySelector<HTMLButtonElement>('[data-story-replace-reader="true"]')?.click();
  await expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull();
  await expect(canvas.getByRole('button', { name: m.wide_document_code_inspect() })).toBeVisible();
}

export const DocumentJourney: Story = { play: inspectWrapCopyReturn };

export const ClipboardFailure: Story = {
  play: clipboardFailure,
};
export const ReaderRetirement: Story = {
  args: { retirement: true },
  play: readerRetirement,
};
