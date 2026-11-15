import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { EditorPreferences } from '../preferences.ts';
import {
  EditorPreferencesPanel,
  type EditorPreferencesLabels,
  type EditorPreferencesScope,
  type EditorPreferenceControl,
} from './editor-preferences.tsx';

/** Contract-shaped synthetic fixture: sparse device overrides over preset defaults. */
const sparseDeviceOverrides: EditorPreferences = {
  typeface: 'custom',
  customFont: 'Source Serif 4',
  textSize: 18,
  toolbar: 'fixed',
  outline: true,
  pasteMode: 'plain',
  pinnedCommands: ['bold'],
};

/** Contract-shaped synthetic fixture: italic chord collides with the default bold binding. */
const conflictingShortcut: EditorPreferences = {
  keyboardBindings: { italic: 'Mod-b' },
};

const reviewCommands: readonly EditorPreferenceControl[] = [
  { id: 'bold', label: 'Bold' },
  { id: 'italic', label: 'Italic' },
  { id: 'find', label: 'Find and replace' },
];

/** Synthetic long-label overlay for wrapping review; product copy stays in editorPreferencesLabels. */
const longLabels: Partial<EditorPreferencesLabels> = {
  scope: 'Save these writing workspace preferences to',
  outline: 'Show the document outline beside the writing canvas',
  markdownShortcuts: 'Turn typed Markdown patterns into live formatting while writing',
  autoLink: 'Convert typed URLs into links as you write',
  customFont: 'Installed font family on this writing device',
  resetShortcut: 'Restore the default keyboard shortcut for this command',
  pinned: 'Keep this command pinned on the toolbar',
  visible: 'Keep this command visible in the toolbar',
  moveUp: 'Move this command earlier in the toolbar',
  moveDown: 'Move this command later in the toolbar',
  reset: 'Restore every editor preference to the documented defaults',
};

const longCommands: readonly EditorPreferenceControl[] = [
  { id: 'bold', label: 'Bold emphasis for the current text selection' },
  { id: 'italic', label: 'Italic emphasis for the current text selection' },
  { id: 'find', label: 'Find and replace across the current writing visit' },
];

function PreferencesReview({
  initial,
  labels,
  commands = reviewCommands,
}: {
  initial: EditorPreferences;
  labels?: Partial<EditorPreferencesLabels>;
  commands?: readonly EditorPreferenceControl[];
}) {
  const [value, setValue] = useState(initial);
  const [scope, setScope] = useState<EditorPreferencesScope>('device');
  return (
    <EditorPreferencesPanel
      value={value}
      onChange={setValue}
      scope={scope}
      onScopeChange={setScope}
      commands={commands}
      labels={labels}
    />
  );
}

const meta = {
  title: 'Editor/Preferences',
  id: 'editor-preferences-review',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const SparseDeviceOverrides: Story = {
  name: 'Sparse device overrides',
  render: () => <PreferencesReview initial={sparseDeviceOverrides} />,
};

export const LongLabels: Story = {
  name: 'Long labels',
  render: () => <PreferencesReview initial={sparseDeviceOverrides} labels={longLabels} commands={longCommands} />,
};

export const InvalidShortcut: Story = {
  name: 'Invalid shortcut',
  render: () => <PreferencesReview initial={conflictingShortcut} />,
};
