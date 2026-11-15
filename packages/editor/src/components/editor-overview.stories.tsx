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
      { id: 'components-editorproduct--writing', name: 'Writing' },
      { id: 'components-editorproduct--knowledge', name: 'Knowledge' },
      { id: 'components-editorproduct--compact', name: 'Compact' },
      { id: 'components-editorproduct--read-only', name: 'Read only' },
      { id: 'components-editorproduct--settings', name: 'Settings' },
    ],
  },
  {
    heading: 'Profiles and reading',
    items: [
      { id: 'components-richtexteditor--text-profile', name: 'Text profile' },
      { id: 'components-richtexteditor--blocks-profile', name: 'Blocks profile' },
      { id: 'components-document-body--blocks-profile', name: 'Document body' },
      { id: 'components-prose--article', name: 'Prose' },
      { id: 'components-document-spoiler--hidden-until-revealed', name: 'Spoiler' },
      { id: 'components-document-mixed-script--traditional-chinese', name: 'Mixed-script reading' },
    ],
  },
  {
    heading: 'Authoring',
    items: [
      { id: 'editor-structural-editing--structural-editing', name: 'Structural editing' },
      { id: 'editor-media-and-opaque-content--image-properties', name: 'Media and opaque content' },
      { id: 'editor-domain-annotations--domain-annotations', name: 'Domain annotations' },
      { id: 'components-editorformatting--authored-formatting', name: 'Authored formatting' },
      { id: 'components-editor-link--insert-link', name: 'Link' },
      { id: 'components-editor-mention--keyboard-choose', name: 'Mention' },
      { id: 'components-editor-image--alt-text', name: 'Image' },
      { id: 'components-editor-mixed-script--cjk-dominant-text', name: 'Mixed-script editing' },
    ],
  },
  {
    heading: 'Controls',
    items: [
      { id: 'components-editor-touch-bar--format-selection', name: 'Touch bar' },
      { id: 'components-editor-touch-bar--undo-redo', name: 'Undo and redo' },
      { id: 'components-editor-slash-menu--filter-commands', name: 'Slash menu' },
      { id: 'components-editor-selection-menu--mark-commands', name: 'Selection menu' },
      { id: 'components-editorpreferences--settings', name: 'Preferences' },
    ],
  },
] as const;

function EditorOverview() {
  const [document, setDocument] = useState<DocumentSnapshot>(syntheticChapter);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 bg-background font-sans text-foreground">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Editor</h1>
        <p className="text-muted-foreground">
          Implemented review states for the extracted editor in the composed UI catalogue. Width, locale and theme stay
          on the toolbar. Host save, publication and native acceptance remain separately scheduled.
        </p>
      </header>
      <RichTextEditor
        value={document}
        onChange={setDocument}
        label="Synthetic review chapter"
        preset="writing"
      />
      <Separator />
      <nav aria-label="Editor review entries" className="flex flex-col gap-8">
        {reviewEntries.map((section) => (
          <section key={section.heading} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{section.heading}</h2>
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
