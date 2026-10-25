import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from './document-body.tsx';

const snapshot = (profile: 'text' | 'blocks', content: DocumentSnapshot['doc']['content']): DocumentSnapshot => ({
  version: 'rezics-document-v1',
  profile,
  doc: { type: 'doc', content },
});
const meta = { title: 'Rezics UI/Document Body', component: DocumentBody } satisfies Meta<typeof DocumentBody>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextProfile: Story = {
  args: {
    document: snapshot('text', [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Reading notes' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' italic', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' underline', marks: [{ type: 'underline' }] },
          { type: 'text', text: ' strike', marks: [{ type: 'strike' }] },
          { type: 'text', text: ' code', marks: [{ type: 'code' }] },
          { type: 'text', text: ' ruby', marks: [{ type: 'language', attrs: { lang: 'en' } }] },
          { type: 'ruby', attrs: { rt: 'book' }, content: [{ type: 'text', text: '本' }] },
        ],
      },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quotation.' }] }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A list item' }] }] },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 2 },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ordered item' }] }] },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task' }] }],
          },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const answer = 42;' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Emphasis', marks: [{ type: 'textEmphasis' }] },
          { type: 'text', text: ' colored', marks: [{ type: 'textStyle', attrs: { color: '#123456' } }] },
          { type: 'text', text: ' language', marks: [{ type: 'language', attrs: { dir: 'rtl' } }] },
        ],
      },
      { type: 'horizontalRule' },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Reading notes' })).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Task status' })).toBeChecked();
    await expect(canvas.getByText('const answer = 42;')).toBeVisible();
  },
};

export const BlocksProfile: Story = {
  args: {
    document: snapshot('blocks', [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dune' }] }] },
            ],
          },
        ],
      },
      { type: 'image', attrs: { src: 'cover-1', alt: 'Desert planet cover', width: 320, height: 480 } },
      { type: 'media', attrs: { src: 'media-1', kind: 'file', caption: 'Audio edition' } },
      { type: 'extensionBlock', attrs: { definition: 'rating', fallback: '4 stars' } },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Inline component: ' },
          { type: 'extensionInline', attrs: { definition: 'badge', fallback: 'Verified' } },
          { type: 'hardBreak' },
          { type: 'text', text: 'after break' },
        ],
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('table')).toBeVisible();
    await expect(canvas.getByRole('img', { name: 'Desert planet cover' })).toBeVisible();
    await expect(canvas.getByText('4 stars')).toBeVisible();
  },
};

export const SafeLinks: Story = {
  args: {
    document: snapshot('text', [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Website', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
          { type: 'text', text: ' email', marks: [{ type: 'link', attrs: { href: 'mailto:reader@example.com' } }] },
          { type: 'text', text: ' unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
        ],
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Website' })).toHaveAttribute(
      'rel',
      'noopener noreferrer nofollow ugc',
    );
    await expect(canvas.getByRole('link', { name: 'email' })).toHaveAttribute('href', 'mailto:reader@example.com');
    await expect(canvas.getByText('unsafe')).not.toHaveAttribute('href');
  },
};

export const Spoilers: Story = {
  args: {
    document: snapshot('text', [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hidden reveal', marks: [{ type: 'spoiler' }] }] },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'Reveal spoiler' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('Hidden reveal')).toBeVisible();
  },
};

export const MediaImages: Story = {
  args: {
    document: snapshot('blocks', [
      { type: 'image', attrs: { src: 'asset-7', variant: 'medium', alt: 'Mountain at dawn', width: 640, height: 400 } },
    ]),
  },
  play: async ({ canvasElement }) => {
    const image = within(canvasElement).getByRole('img', { name: 'Mountain at dawn' });
    await expect(image).toHaveAttribute('src', '/media/asset-7/medium');
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect(image).toHaveAttribute('width', '640');
  },
};
