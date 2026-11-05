import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertCircleIcon, FileTextIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@rezics/ui/shadcn/attachment';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Attachment',
  component: Attachment,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Attachment>;
export default meta;
type Story = StoryObj<typeof meta>;

const States = {
  idle: 'Ready to upload',
  uploading: 'Uploading… 42%',
  processing: 'Processing…',
  error: 'Upload failed',
  done: '2.4 MB',
} as const;

const File = ({
  state,
  title = 'dune-annotations.pdf',
  description,
  onRemove,
}: {
  state: keyof typeof States;
  title?: string;
  description?: string;
  onRemove?: () => void;
}) => (
  <Attachment state={state} className="max-w-xs">
    <AttachmentMedia>{state === 'error' ? <AlertCircleIcon /> : <FileTextIcon />}</AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>{title}</AttachmentTitle>
      <AttachmentDescription>{description ?? States[state]}</AttachmentDescription>
    </AttachmentContent>
    {onRemove ? (
      <AttachmentActions>
        <AttachmentAction aria-label={`Remove ${title}`} onClick={onRemove}>
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    ) : null}
  </Attachment>
);

export const Default: Story = {
  render: () => <File state="done" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('dune-annotations.pdf')).toBeVisible();
    await expect(canvas.getByText('2.4 MB')).toBeVisible();
  },
};

export const States_: Story = {
  name: 'States',
  render: () => (
    <div className="flex flex-col gap-2">
      {(Object.keys(States) as (keyof typeof States)[]).map((state) => (
        <File key={state} state={state} title={`${state}.pdf`} />
      ))}
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const [state, text] of Object.entries(States)) {
      await expect(canvas.getByText(text)).toBeVisible();
      await expect(canvas.getByText(`${state}.pdf`).closest('[data-slot="attachment"]')).toHaveAttribute(
        'data-state',
        state,
      );
    }
  },
};

const Removable = () => {
  const [files, setFiles] = useState(['chapter-1.epub', 'chapter-2.epub']);
  return (
    <AttachmentGroup>
      {files.map((file) => (
        <File key={file} state="done" title={file} onRemove={() => setFiles(files.filter((name) => name !== file))} />
      ))}
      {files.length === 0 ? <p className="text-sm text-muted-foreground">No files attached</p> : null}
    </AttachmentGroup>
  );
};

export const Removal: Story = {
  render: () => <Removable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove chapter-1.epub' }));
    await expect(canvas.queryByText('chapter-1.epub')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove chapter-2.epub' }));
    await expect(await canvas.findByText('No files attached')).toBeVisible();
  },
};

export const Openable: Story = {
  render: () => (
    <Attachment className="max-w-xs">
      <AttachmentMedia>
        <FileTextIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>reading-notes.pdf</AttachmentTitle>
        <AttachmentDescription>Open in a new tab</AttachmentDescription>
      </AttachmentContent>
      <AttachmentTrigger render={<a href="#notes" aria-label="Open reading-notes.pdf" />} />
    </Attachment>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Open reading-notes.pdf' })).toHaveAttribute(
      'href',
      '#notes',
    );
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <div className="flex w-64 flex-col gap-2">
      <File
        state="done"
        title="a-very-long-file-name-for-the-annotated-edition-of-the-three-body-problem-volume-one.pdf"
        description="Annotated by the book club in 2026"
      />
      <File
        state="error"
        title="三體：地球往事-讀書會筆記（第二版）.docx"
        description="上傳失敗：檔案超過 20 MB 的上限"
      />
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/^三體：地球往事/)).toBeVisible();
    await expect(canvas.getByText(/上傳失敗/)).toBeVisible();
  },
};
