import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MarkdownEditor } from './markdown-editor.tsx';

function Example() {
  const [value, setValue] = useState('**Welcome** to the discussion.\n\n> A quoted passage\n\n'
    + '- One idea\n- Another idea\n\nRead >!the ending!< when you are ready.');
  return <div className="max-w-2xl p-5"><MarkdownEditor label="Your post" value={value} onChange={setValue}
    rows={8} maxLength={8000} editLabel="Write" previewLabel="Preview" showSpoiler="Show spoiler" /></div>;
}

const meta = { title: 'Post Composer/Markdown editor', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Preview: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('tab', { name: 'Preview' }));
  await expect(canvas.getByText('Welcome')).toHaveProperty('tagName', 'STRONG');
  await expect(canvas.getByRole('blockquote')).toBeVisible();
  await expect(canvas.queryByText('the ending')).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: 'Show spoiler' }));
  await expect(canvas.getByText('the ending')).toBeVisible();
} };
