import type { Meta, StoryObj } from '@storybook/react-vite';
import { ImageIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import {
  FileUpload,
  FileUploadClearTrigger,
  FileUploadDescription,
  FileUploadDropzone,
  FileUploadDropzoneIcon,
  FileUploadHelper,
  FileUploadList,
  FileUploadTitle,
  FileUploadTrigger,
} from './file-upload.tsx';

const file = (name: string, type: string, size: number) =>
  new File([new Uint8Array(size)], name, { type, lastModified: Date.UTC(2026, 8, 1) });

// A 1x1 ink-blue PNG, so the list can show a real image preview.
const pixel = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPQT0z/DwADTwHVg3tMwQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);
const cover = new File([pixel], 'three-body-problem-cover.png', {
  type: 'image/png',
  lastModified: Date.UTC(2026, 8, 1),
});
const epub = file('三体-第一章-试读.epub', 'application/epub+zip', 1_204_000);
const notes = file(
  'translation-notes-for-the-dark-forest-chapter-12-with-glossary-and-footnotes.pdf',
  'application/pdf',
  402_000,
);

const meta = {
  title: 'Rezics UI/File Upload',
  component: FileUpload,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A dropzone and file picker with an accepted-file list, type and size limits and keyboard access. In REZICS use it for a Work’s cover image in the editor, attachments on moderation appeals, and importing a reading list (CSV) into shelves. Set `accept`, `maxFiles` and `maxFileSize`, and say the limits in the helper text.',
      },
    },
  },
  args: { accept: 'image/*', maxFiles: 1, maxFileSize: 5 * 1024 * 1024 },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="max-w-md">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <FileUpload {...args}>
      <FileUploadDropzone>
        <FileUploadDropzoneIcon>
          <ImageIcon />
        </FileUploadDropzoneIcon>
        <FileUploadTitle>Drop a cover image here</FileUploadTitle>
        <FileUploadDescription>or choose one from your device</FileUploadDescription>
        <FileUploadHelper>
          PNG, JPG or WebP, up to 5 MB. Portrait covers look best.
        </FileUploadHelper>
      </FileUploadDropzone>
      <FileUploadList />
    </FileUpload>
  ),
} satisfies Meta<typeof FileUpload>;
export default meta;
type Story = StoryObj<typeof meta>;

const hiddenInput = (canvasElement: HTMLElement) =>
  canvasElement.querySelector('input[type=file]') as HTMLInputElement;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.upload(hiddenInput(canvasElement), cover);
    await waitFor(() =>
      expect(canvas.getByText('three-body-problem-cover.png')).toBeInTheDocument(),
    );
    await userEvent.click(canvas.getByRole('button', { name: /delete/i }));
    await waitFor(() =>
      expect(canvas.queryByText('three-body-problem-cover.png')).not.toBeInTheDocument(),
    );
  },
};

export const WithFile: Story = { args: { defaultAcceptedFiles: [cover] } };

export const Rejected: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.upload(hiddenInput(canvasElement), epub, { applyAccept: false });
    await expect(canvas.queryByText(epub.name)).not.toBeInTheDocument();
  },
};

export const Multiple: Story = {
  args: { accept: undefined, maxFiles: 5, defaultAcceptedFiles: [cover, epub, notes] },
  render: (args) => (
    <FileUpload {...args}>
      <FileUploadDropzone>
        <FileUploadDropzoneIcon />
        <FileUploadTitle>Attach evidence for your appeal</FileUploadTitle>
        <FileUploadDescription>
          Screenshots, PDFs or the original chapter file
        </FileUploadDescription>
        <FileUploadHelper>Up to 5 files, 5 MB each.</FileUploadHelper>
      </FileUploadDropzone>
      <FileUploadList />
      <FileUploadClearTrigger asChild>
        <Button className="self-end" size="sm" variant="ghost">
          Remove all
        </Button>
      </FileUploadClearTrigger>
    </FileUpload>
  ),
};

export const ButtonOnly: Story = {
  args: { accept: '.csv,text/csv' },
  render: (args) => (
    <FileUpload {...args}>
      <FileUploadTrigger asChild>
        <Button className="w-fit" variant="outline">
          Import reading list (CSV)
        </Button>
      </FileUploadTrigger>
      <FileUploadList />
    </FileUpload>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const Chinese: Story = {
  args: { defaultAcceptedFiles: [epub], accept: undefined },
  render: (args) => (
    <FileUpload {...args}>
      <FileUploadDropzone>
        <FileUploadDropzoneIcon />
        <FileUploadTitle>将封面图片拖到这里</FileUploadTitle>
        <FileUploadDescription>或从设备中选择文件</FileUploadDescription>
        <FileUploadHelper>支持 PNG、JPG、WebP，最大 5 MB。</FileUploadHelper>
      </FileUploadDropzone>
      <FileUploadList />
    </FileUpload>
  ),
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  args: { accept: undefined, maxFiles: 5, defaultAcceptedFiles: [cover, notes] },
};
