import { fromMarkdown, serializeDocument } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { BodyEditor } from '../document-editor/body-editor.tsx';
import { bodyText } from '../document-editor/body.ts';

const initial = serializeDocument(
  fromMarkdown(
    '**Welcome** to the discussion.\n\n> A quoted passage\n\n' +
      '- One idea\n- Another idea\n\nRead >!the ending!< when you are ready.',
  ),
);

function Example({ locale = 'en', readOnly = false }: { locale?: UiLocale; readOnly?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="grid max-w-3xl gap-3 p-5">
      <BodyEditor
        label="Your post"
        value={value}
        onChange={setValue}
        maxLength={7800}
        locale={locale}
        readOnly={readOnly}
      />
      <output aria-label="Plain text projection" className="sr-only">
        {bodyText(value)}
      </output>
    </div>
  );
}

const meta = { title: 'Post Composer/Body editor', component: Example } satisfies Meta<
  typeof Example
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RichPost: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Your post' });
    await expect(within(editor).getByText('Welcome')).toHaveProperty('tagName', 'STRONG');
    await expect(within(editor).getByText('A quoted passage').closest('blockquote')).not.toBeNull();
    await userEvent.click(editor);
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    await userEvent.type(editor, ' More to discuss.', { skipClick: true, delay: 20 });
    await waitFor(() =>
      expect(canvas.getByLabelText('Plain text projection')).toHaveTextContent('More to discuss.'),
    );
    await expect(within(editor).getByText('Welcome')).toHaveProperty('tagName', 'STRONG');
  },
};

export const LockedDraft: Story = { args: { readOnly: true } };
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' } };
