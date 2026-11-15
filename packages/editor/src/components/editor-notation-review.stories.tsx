import {
  documentVersion,
  fromMarkdown,
  normalizeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { DocumentBody } from './document-body.tsx';
import { RichTextEditor } from './rich-text-editor.tsx';

/** Contract-shaped synthetic snapshots for notation review. Schema-valid examples, not native chapter receipts. */
const paragraph = (id: string, content: DocumentNode[]): DocumentNode => ({
  type: 'paragraph',
  attrs: { id },
  content,
});
const text = (value: string, marks?: DocumentNode['marks']): DocumentNode => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});

const mixedScriptRubyLanguageAndDirection = normalizeDocument({
  version: documentVersion,
  profile: 'text',
  doc: withDocumentIds({
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { id: 'heading', level: 2, lang: 'zh-Hant-TW', dir: 'ltr' },
        content: [
          {
            type: 'ruby',
            attrs: { rt: 'ㄏㄢˋ', position: 'inter-character', lang: 'zh-Hant' },
            content: [{ type: 'text', text: '漢', marks: [{ type: 'bold' }] }],
          },
          {
            type: 'text',
            text: '字😀',
            marks: [
              { type: 'link', attrs: { href: '/work' } },
              { type: 'textEmphasis', attrs: { shape: 'sesame', fill: 'filled', position: 'over' } },
            ],
          },
        ],
      },
      paragraph('mixed-script-body', [
        text('《三體》', [{ type: 'language', attrs: { lang: 'zh-Hant-TW', dir: 'auto' } }]),
        text('讀後。劉慈欣（'),
        text('Liu Cixin', [{ type: 'language', attrs: { lang: 'en' } }]),
        text('）把宇宙寫成一座黑暗森林：每個文明都是帶槍的獵人，連呼吸都必須小心。'),
        text('The Dark Forest', [{ type: 'language', attrs: { lang: 'en' } }]),
        text(' 不是比喻，是生存法則。'),
      ]),
      {
        type: 'paragraph',
        attrs: { id: 'p', lang: 'ja', dir: 'ltr' },
        content: [
          { type: 'ruby', attrs: { rt: 'かん', position: 'over' }, content: [{ type: 'text', text: '漢' }] },
          { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.test/' } }] },
          { type: 'hardBreak' },
        ],
      },
      {
        type: 'paragraph',
        attrs: { id: 'rtl-note', lang: 'ar', dir: 'rtl' },
        content: [
          { type: 'text', text: 'language', marks: [{ type: 'language', attrs: { dir: 'rtl' } }] },
          text(' The Dark Forest 不是比喻。'),
        ],
      },
    ],
  }),
});

const footnoteReferencesAndDefinitions = fromMarkdown(
  [
    'Read this[^Source:Release-1]. See it again[^Source:Release-1].',
    '',
    '[^Source:Release-1]: **Published findings**',
    '    Continued detail.',
  ].join('\n'),
  'text',
);

const structuredTable = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: withDocumentIds({
    type: 'doc',
    content: [
      {
        type: 'table',
        attrs: { id: 'table' },
        content: [
          {
            type: 'tableRow',
            attrs: { id: 'row' },
            content: [
              {
                type: 'tableHeader',
                attrs: { id: 'cell-1', colspan: 2, colwidth: [120, 160] },
                content: [paragraph('cell-p-1', [text('A')])],
              },
              { type: 'tableCell', attrs: { id: 'cell-2' }, content: [paragraph('cell-p-2', [text('B')])] },
            ],
          },
        ],
      },
    ],
  }),
});

function NotationReview({
  document,
  label,
  lang,
}: {
  document: DocumentSnapshot;
  label: string;
  lang?: string;
}) {
  const [value, setValue] = useState(document);
  return (
    <div className="flex w-full flex-col gap-5">
      <RichTextEditor value={value} onChange={setValue} label={label} toolbar="always" lang={lang} />
      <section aria-label="Reading preview" {...(lang ? { lang } : {})}>
        <DocumentBody document={value} />
      </section>
    </div>
  );
}

const meta = {
  title: 'Editor/Writing/Notation Review',
  id: 'editor-notation-review',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Ordinary manual review of authored domain notation on RichTextEditor and DocumentBody. Fixtures are contract-shaped synthetic snapshots. Entries open settled; width and theme stay on the toolbar.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedScriptRubyLanguageAndDirection: Story = {
  name: 'Mixed-script ruby, language and direction',
  render: () => (
    <NotationReview document={mixedScriptRubyLanguageAndDirection} label="Reading notes" lang="zh-Hant" />
  ),
};

export const FootnoteReferencesAndDefinitions: Story = {
  name: 'Footnote references and definitions',
  render: () => <NotationReview document={footnoteReferencesAndDefinitions} label="Annotated document" />,
};

export const StructuredTable: Story = {
  name: 'Structured table',
  render: () => <NotationReview document={structuredTable} label="Structural document" />,
};
