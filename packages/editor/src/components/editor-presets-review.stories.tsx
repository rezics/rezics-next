import {
  checkDocument,
  documentVersion,
  fromMarkdown,
  fromPlainText,
  normalizeDocument,
  withDocumentIds,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import type { EditorPreferences } from '../preferences.ts';
import { RichTextEditor } from './rich-text-editor.tsx';
import type { EditorPreset } from './editor-workbench.tsx';

/** Contract-shaped synthetic chapter; not a recorded or native snapshot. */
const chapter = fromMarkdown('# A voyage\n\nThe sea is quiet. The sea carries our story.', 'blocks');

/** Contract-shaped synthetic compact reply. */
const reply = fromPlainText('A compact reply for this visit.', 'text');

/** Contract-shaped synthetic knowledge notes with blocks and a table. */
const knowledgeNotes = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: withDocumentIds({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Harbour notes' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Block and table operations stay on this visit.' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First observation' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second observation' }] }],
          },
        ],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Source' }] }],
              },
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Status' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open' }] }],
              },
            ],
          },
        ],
      },
    ],
  }),
});

function reviewDocument(preset: EditorPreset): DocumentSnapshot {
  if (preset === 'knowledge') return knowledgeNotes;
  if (preset === 'compact') return reply;
  return chapter;
}

function reviewLabel(preset: EditorPreset, readOnly: boolean): string {
  if (readOnly) return 'Chapter draft';
  if (preset === 'knowledge') return 'Knowledge notes';
  if (preset === 'compact') return 'Reply';
  return 'Chapter draft';
}

function PresetReviewHost({
  preset = 'writing',
  readOnly = false,
}: {
  preset?: EditorPreset;
  readOnly?: boolean;
}) {
  const [document, setDocument] = useState<DocumentSnapshot>(() => reviewDocument(preset));
  const [preferences, setPreferences] = useState<EditorPreferences>({});
  const [saves, setSaves] = useState(0);
  const [pending, setPending] = useState(false);
  const label = reviewLabel(preset, readOnly);
  return (
    <form
      className="mx-auto flex w-full max-w-5xl flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && !readOnly && checkDocument(document)) setSaves((count) => count + 1);
      }}
    >
      <RichTextEditor
        value={document}
        onChange={(next) => {
          setDocument(next);
          setPending(false);
        }}
        onSnapshotPending={() => setPending(true)}
        label={label}
        preset={preset}
        readOnly={readOnly}
        preferences={preferences}
        onPreferencesChange={setPreferences}
        preferencesScope="session"
        onSave={() => {
          if (!readOnly) setSaves((count) => count + 1);
        }}
        actions={
          <Button type="submit" disabled={pending || readOnly}>
            Save draft
          </Button>
        }
      />
      <output aria-label="Saved drafts">{saves}</output>
    </form>
  );
}

const meta = {
  id: 'editor-presets-review',
  title: 'Editor/Presets review',
  component: PresetReviewHost,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Ordinary manual review of Writing, Knowledge, Compact and Read-only presets on the actual RichTextEditor. Documents are contract-shaped synthetic snapshots, not recorded or native evidence. Each entry opens in its named state and keeps edits on this visit. Width and theme stay on the Storybook toolbar.',
      },
    },
  },
} satisfies Meta<typeof PresetReviewHost>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Writing: Story = {
  args: { preset: 'writing' },
};

export const Knowledge: Story = {
  args: { preset: 'knowledge' },
};

export const Compact: Story = {
  args: { preset: 'compact' },
};

export const ReadOnly: Story = {
  name: 'Read-only',
  args: { preset: 'writing', readOnly: true },
};
