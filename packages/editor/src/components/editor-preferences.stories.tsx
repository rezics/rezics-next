import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { EditorPreferences } from '../preferences.ts';
import { EditorPreferencesPanel } from './editor-preferences.tsx';

function SettingsDemo() {
  const [value, setValue] = useState<EditorPreferences>({ textSize: 16, lineSpacing: 1.7 });
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 p-4">
      <EditorPreferencesPanel
        value={value}
        onChange={setValue}
        scope="device"
        commands={[
          { id: 'bold', label: 'Bold' },
          { id: 'italic', label: 'Italic' },
        ]}
      />
      <output aria-label="Current preferences">{JSON.stringify(value)}</output>
    </div>
  );
}

const meta = {
  title: 'Components/EditorPreferences',
  component: EditorPreferencesPanel,
  args: { value: {}, onChange: () => undefined },
  render: () => <SettingsDemo />,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof EditorPreferencesPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Settings: Story = {};

export const NumericEntry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const size = canvas.getByRole('spinbutton', { name: 'Text size (px)' });
    await userEvent.clear(size);
    await userEvent.type(size, '20');
    await userEvent.tab();
    await expect(size).toHaveValue(20);
    const spacing = canvas.getByRole('spinbutton', { name: 'Line spacing' });
    await userEvent.clear(spacing);
    await userEvent.type(spacing, '1.8');
    await userEvent.tab();
    await expect(spacing).toHaveValue(1.8);
    await expect(canvas.getByLabelText('Current preferences')).toHaveTextContent('"textSize":20,"lineSpacing":1.8');
    await userEvent.clear(size);
    await userEvent.tab();
    await expect(size).toHaveAttribute('aria-invalid', 'true');
    await expect(canvas.getByRole('alert')).toHaveTextContent('Enter a whole number from 12 to 32.');
    await expect(canvas.getByLabelText('Current preferences')).toHaveTextContent('"textSize":20');
    await userEvent.click(canvas.getByRole('button', { name: 'Restore defaults' }));
    await expect(size).toHaveValue(16);
    await expect(size).toHaveAttribute('aria-invalid', 'false');
  },
};

export const ShortcutConflict: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Search editor preferences' }), 'Italic');
    const shortcut = canvas.getByRole('textbox', { name: 'Shortcut' });
    await userEvent.clear(shortcut);
    await userEvent.type(shortcut, 'Mod-b');
    await userEvent.tab();
    await expect(canvas.getByRole('alert')).toHaveTextContent('This shortcut is already assigned to Bold.');
    await expect(shortcut).toHaveAttribute('aria-invalid', 'true');
  },
};
