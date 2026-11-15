import { fromMarkdown, type DocumentSnapshot } from '@rezics/document';
import { Separator } from '@rezics/ui/shadcn/separator';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { RichTextEditor } from './rich-text-editor.tsx';

/** Contract-shaped synthetic fixture for Storybook review. */
const syntheticChapter = fromMarkdown(
  '# Synthetic review chapter\n\nThe sea is quiet. The sea carries our story.',
  'blocks',
);

const reviewEntries = [
  {
    heading: 'Writing presets',
    items: [
      { id: 'editor-presets-review--writing', name: 'Writing' },
      { id: 'editor-presets-review--knowledge', name: 'Knowledge' },
      { id: 'editor-presets-review--compact', name: 'Compact' },
      { id: 'editor-presets-review--read-only', name: 'Read-only' },
    ],
  },
  {
    heading: 'Preferences',
    items: [
      { id: 'editor-preferences-review--sparse-device-overrides', name: 'Sparse device overrides' },
      { id: 'editor-preferences-review--long-labels', name: 'Long labels' },
      { id: 'editor-preferences-review--invalid-shortcut', name: 'Invalid shortcut' },
    ],
  },
  {
    heading: 'Inspection',
    items: [
      { id: 'editor-inspection-review--long-query', name: 'Long query' },
      { id: 'editor-inspection-review--empty-results', name: 'Empty results' },
      { id: 'editor-inspection-review--long-heading-labels', name: 'Long heading labels' },
      { id: 'editor-inspection-review--empty-outline', name: 'Empty outline' },
    ],
  },
  {
    heading: 'Command palette',
    items: [
      { id: 'editor-command-palette--long-localized-commands', name: 'Long localized commands' },
      { id: 'editor-command-palette--disabled-commands', name: 'Disabled commands' },
      { id: 'editor-command-palette--empty-results', name: 'Empty results' },
    ],
  },
  {
    heading: 'Media controls',
    items: [
      { id: 'editor-media-controls--long-alt-text', name: 'Long alt text' },
      { id: 'editor-media-controls--invalid-dimensions', name: 'Invalid dimensions' },
      { id: 'editor-media-controls--long-caption', name: 'Long caption' },
    ],
  },
  {
    heading: 'Tables',
    items: [
      { id: 'editor-tables-review--creation-long-translated-labels', name: 'Creation, long translated labels' },
      { id: 'editor-tables-review--actions-long-translated-labels', name: 'Actions, long translated labels' },
    ],
  },
  {
    heading: 'Document reader',
    items: [
      { id: 'editor-document-reader-review--long-unbroken-links', name: 'Long unbroken links' },
      { id: 'editor-document-reader-review--media-captions', name: 'Media captions' },
      { id: 'editor-document-reader-review--missing-media', name: 'Missing media' },
      { id: 'editor-document-reader-review--mixed-cjk-text', name: 'Mixed CJK text' },
    ],
  },
  {
    heading: 'Links',
    items: [
      { id: 'editor-links-review--long-url', name: 'Long URL' },
      { id: 'editor-links-review--long-translated-labels', name: 'Long translated labels' },
      { id: 'editor-links-review--invalid-url', name: 'Invalid URL' },
    ],
  },
  {
    heading: 'Notation',
    items: [
      {
        id: 'editor-notation-review--mixed-script-ruby-language-and-direction',
        name: 'Mixed-script ruby, language and direction',
      },
      { id: 'editor-notation-review--footnote-references-and-definitions', name: 'Footnote references and definitions' },
      { id: 'editor-notation-review--structured-table', name: 'Structured table' },
    ],
  },
] as const;

const interactionRegressions = [
  {
    heading: 'Product journeys',
    items: [
      { id: 'editor-writing-editor-product--writing', name: 'Writing' },
      { id: 'editor-writing-editor-product--knowledge', name: 'Knowledge' },
      { id: 'editor-writing-editor-product--compact', name: 'Compact' },
      { id: 'editor-writing-editor-product--read-only', name: 'Read only' },
      { id: 'editor-writing-editor-product--settings', name: 'Settings' },
    ],
  },
  {
    heading: 'Profiles and reading',
    items: [
      { id: 'editor-writing-rich-text-editor--text-profile', name: 'Text profile' },
      { id: 'editor-writing-rich-text-editor--blocks-profile', name: 'Blocks profile' },
      { id: 'editor-reading-document-body--blocks-profile', name: 'Document body' },
      { id: 'editor-reading-prose--article', name: 'Prose' },
      { id: 'editor-reading-document-spoiler--hidden-until-revealed', name: 'Spoiler' },
      { id: 'editor-reading-document-mixed-script--traditional-chinese', name: 'Mixed-script reading' },
    ],
  },
  {
    heading: 'Authoring',
    items: [
      { id: 'editor-writing-structural-editing--structural-editing', name: 'Structural editing' },
      { id: 'editor-writing-media-and-opaque-content--image-properties', name: 'Media and opaque content' },
      { id: 'editor-writing-domain-annotations--domain-annotations', name: 'Domain annotations' },
      { id: 'editor-writing-formatting--authored-formatting', name: 'Authored formatting' },
      { id: 'editor-writing-link--insert-link', name: 'Link' },
      { id: 'editor-writing-mention--keyboard-choose', name: 'Mention' },
      { id: 'editor-writing-image--alt-text', name: 'Image' },
      { id: 'editor-writing-mixed-script--cjk-dominant-text', name: 'Mixed-script editing' },
    ],
  },
  {
    heading: 'Controls',
    items: [
      { id: 'editor-writing-touch-bar--format-selection', name: 'Touch bar' },
      { id: 'editor-writing-touch-bar--undo-redo', name: 'Undo and redo' },
      { id: 'editor-writing-slash-menu--filter-commands', name: 'Slash menu' },
      { id: 'editor-writing-selection-menu--mark-commands', name: 'Selection menu' },
      { id: 'editor-preferences-preference-controls--settings', name: 'Preferences' },
    ],
  },
] as const;

function EntryList({
  sections,
}: {
  sections: readonly { heading: string; items: readonly { id: string; name: string }[] }[];
}) {
  return (
    <div className="flex flex-col gap-8">
      {sections.map((section) => (
        <section key={section.heading} className="flex flex-col gap-3">
          <h3 className="text-lg font-semibold">{section.heading}</h3>
          <ul className="flex flex-col gap-2">
            {section.items.map((item) => (
              <li key={item.id}>
                <a className="text-foreground underline underline-offset-4" href={`?path=/story/${item.id}`}>
                  {item.name}
                </a>
                <span className="text-muted-foreground"> {item.id}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EditorOverview() {
  const [document, setDocument] = useState<DocumentSnapshot>(syntheticChapter);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 bg-background font-sans text-foreground">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Editor</h1>
        <p className="text-muted-foreground">
          Implemented review states for the extracted editor in the composed UI catalogue. Primary entries open in their
          named state. Width, locale and theme stay on the toolbar. Host save, publication and native acceptance remain
          separately scheduled.
        </p>
      </header>
      <RichTextEditor
        value={document}
        onChange={setDocument}
        label="Synthetic review chapter"
        preset="writing"
      />
      <Separator />
      <nav aria-labelledby="editor-review-entries-heading" className="flex flex-col gap-8">
        <h2 id="editor-review-entries-heading" className="text-xl font-semibold">
          Review entries
        </h2>
        <EntryList sections={reviewEntries} />
      </nav>
      <Separator />
      <nav aria-labelledby="editor-interaction-regressions-heading" className="flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h2 id="editor-interaction-regressions-heading" className="text-xl font-semibold">
            Interaction regressions
          </h2>
          <p className="text-muted-foreground">
            Play-based journeys. Open these only when you want those automated tours.
          </p>
        </div>
        <EntryList sections={interactionRegressions} />
      </nav>
    </div>
  );
}

const meta = {
  title: 'Editor/Overview',
  id: 'editor-overview',
  component: EditorOverview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof EditorOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Catalogue: Story = {};
