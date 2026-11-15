import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@rezics/ui/shadcn/button';
import { useRef, useState } from 'react';
import { defaultEditorKeyboardBindings } from '../preferences.ts';
import { richTextEditorLabels } from './editor-labels.ts';
import { EditorCommandPalette, type EditorProductCommand } from './editor-command-palette.tsx';
import { editorWorkbenchLabels } from './editor-workbench-labels.ts';

function command(
  id: string,
  label: string,
  options: { shortcut?: string | undefined; disabled?: boolean } = {},
): EditorProductCommand {
  return {
    id,
    label,
    run: () => undefined,
    ...(options.shortcut ? { shortcut: options.shortcut } : {}),
    ...(options.disabled ? { disabled: true } : {}),
  };
}

/** Contract-shaped synthetic palette commands for review; not a recorded editing visit. */
const localizedCommands: readonly EditorProductCommand[] = [
  command('find', editorWorkbenchLabels.find, { shortcut: defaultEditorKeyboardBindings.find }),
  command('heading1', 'この段落を見出し1に変換する', { shortcut: defaultEditorKeyboardBindings.heading1 }),
  command('heading2', '將目前段落轉換為標題 2', { shortcut: defaultEditorKeyboardBindings.heading2 }),
  command('blockquote', 'Aktuellen Absatz in ein Zitat umwandeln', {
    shortcut: defaultEditorKeyboardBindings.blockquote,
  }),
  command('replace', editorWorkbenchLabels.replaceWith),
];

const disabledCommands: readonly EditorProductCommand[] = [
  command('undo', richTextEditorLabels.undo, { shortcut: defaultEditorKeyboardBindings.undo, disabled: true }),
  command('redo', richTextEditorLabels.redo, { shortcut: defaultEditorKeyboardBindings.redo, disabled: true }),
  command('find', editorWorkbenchLabels.find, { shortcut: defaultEditorKeyboardBindings.find }),
];

function PaletteReview({ commands }: { commands: readonly EditorProductCommand[] }) {
  const [open, setOpen] = useState(true);
  const launcher = useRef<HTMLButtonElement>(null);
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <Button ref={launcher} type="button" variant="outline" onClick={() => setOpen(true)}>
        {editorWorkbenchLabels.commandPalette}
      </Button>
      <EditorCommandPalette
        open={open}
        onClose={() => setOpen(false)}
        commands={commands}
        labels={editorWorkbenchLabels}
        isCurrent={() => true}
        finalFocus={() => launcher.current ?? false}
      />
    </div>
  );
}

const meta = {
  title: 'Editor/Writing/Command Palette',
  id: 'editor-command-palette',
  component: PaletteReview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PaletteReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LongLocalizedCommands: Story = {
  name: 'Long localized commands',
  render: () => <PaletteReview commands={localizedCommands} />,
};

export const DisabledCommands: Story = {
  name: 'Disabled commands',
  render: () => <PaletteReview commands={disabledCommands} />,
};

export const EmptyResults: Story = {
  name: 'Empty results',
  render: () => <PaletteReview commands={[]} />,
};
