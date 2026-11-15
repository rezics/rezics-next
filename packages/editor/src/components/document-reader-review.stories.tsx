import type { DocumentSnapshot } from '@rezics/document';
import { parseDocument, serializeDocument, withDocumentIds } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { withSurface } from '../../../ui/src/stories/support.tsx';
import { DocumentBody } from './document-body.tsx';

/** Contract-shaped synthetic fixtures for static reader layout review; not native document evidence. */
const longHref =
  'https://example.com/library/works/9789571368474/editions/hardcover-annotated-reader-notes-volume-three/chapters/the-dark-forest-axioms';

let unit = 0;
const snapshot = (profile: 'text' | 'blocks', content: DocumentSnapshot['doc']['content']): DocumentSnapshot =>
  parseDocument(
    JSON.parse(
      serializeDocument({
        version: 'rezics-document-v1',
        profile,
        doc: withDocumentIds({ type: 'doc', content }, () => `reader-review-${++unit}`),
      }),
    ),
  );

const text = (value: string) => ({ type: 'text' as const, text: value });
const link = (value: string, href: string) => ({
  type: 'text' as const,
  text: value,
  marks: [{ type: 'link' as const, attrs: { href } }],
});

const longUnbrokenLinks = snapshot('text', [
  { type: 'heading', attrs: { level: 2 }, content: [text('Catalogue source')] },
  {
    type: 'paragraph',
    content: [text('The edition record is at '), link(longHref, longHref), text('.')],
  },
]);

const mediaCaptions = snapshot('blocks', [
  {
    type: 'media',
    attrs: {
      src: 'synthetic-reader-audio',
      kind: 'audio',
      caption: `Dawn recording (synthetic fixture)\n${longHref}`,
    },
  },
]);

const missingMedia = snapshot('blocks', [
  {
    type: 'image',
    attrs: {
      src: 'synthetic-reader-image',
      alt: 'Cover for hardcover-annotated-reader-notes-volume-three-the-dark-forest-axioms',
      width: 1920,
      height: 1080,
    },
  },
  {
    type: 'media',
    attrs: {
      src: 'synthetic-reader-file',
      kind: 'file',
      caption: 'Transcript unavailable in this visit (synthetic fixture)',
    },
  },
]);

const mixedCjkText = snapshot('text', [
  { type: 'heading', attrs: { level: 2 }, content: [text('重讀《The Three-Body Problem》卷三')] },
  {
    type: 'paragraph',
    content: [
      text(
        '紅岸基地的發射紀錄寫於 1967 年冬天，葉文潔把地球的坐標送進黑暗，而 Luo Ji 後來才把 The Dark Forest 寫成可以運算的公理。ISBN 9789571368474 的繁體版把這段排成直欄，數字、拉丁書名與漢字必須在同一行裡折開。',
      ),
    ],
  },
  {
    type: 'paragraph',
    content: [text('長連結：'), link(longHref, longHref), text('。')],
  },
]);

const meta = {
  title: 'Editor/Document reader',
  id: 'editor-document-reader-review',
  component: DocumentBody,
  decorators: [withSurface],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Static reader wrapping review. Contract-shaped synthetic fixtures; not native evidence. Viewport and theme stay on the Storybook toolbar.',
      },
    },
  },
} satisfies Meta<typeof DocumentBody>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LongUnbrokenLinks: Story = {
  name: 'Long unbroken links',
  args: { document: longUnbrokenLinks },
};

export const MediaCaptions: Story = {
  name: 'Media captions',
  args: { document: mediaCaptions },
};

export const MissingMedia: Story = {
  name: 'Missing media',
  args: { document: missingMedia },
};

export const MixedCjkText: Story = {
  name: 'Mixed CJK text',
  args: { document: mixedCjkText },
  render: () => (
    <div lang="zh-Hant">
      <DocumentBody document={mixedCjkText} />
    </div>
  ),
};
