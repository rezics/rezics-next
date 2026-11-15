import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { normalizeDocument, withDocumentIds, documentVersion } from '@rezics/document';
import { RichTextEditor } from './rich-text-editor.tsx';
import { DocumentBody } from './document-body.tsx';

const initial = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: withDocumentIds({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Format this text' }] },
      { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'An authored heading' }] },
      { type: 'codeBlock', attrs: { language: 'javascript' }, content: [{ type: 'text', text: 'const value = 1;' }] },
    ],
  }),
});

function Demo() {
  const [value, setValue] = useState(initial),
    [hostSaves, setHostSaves] = useState(0);
  return (
    <form
      className="mx-auto flex max-w-4xl flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        setHostSaves((count) => count + 1);
      }}
    >
      <RichTextEditor
        value={value}
        onChange={setValue}
        label="Authored formatting document"
        preferences={{ toolbar: 'fixed' }}
        onSave={() => setHostSaves((count) => count + 1)}
      />
      <section aria-label="Saved document preview">
        <DocumentBody document={value} />
      </section>
      <output aria-label="Host save count">{hostSaves}</output>
    </form>
  );
}
const meta = {
  title: 'Components/EditorFormatting',
  render: () => <Demo />,
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const AuthoredFormatting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Authored formatting document' });
    await userEvent.click(textbox);
    const paragraph = textbox.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(canvas.getByRole('button', { name: 'Text colors' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Text colors' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Text color' }), '#dc2626');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Background color' }), '#fef08a');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Text colors' })).not.toBeInTheDocument());
    await waitFor(() =>
      expect(
        canvas.getByRole('region', { name: 'Saved document preview' }).querySelector('[data-document-text-style]'),
      ).toHaveStyle({ color: '#dc2626', backgroundColor: '#fef08a' }),
    );
    await expect(canvas.getByLabelText('Host save count')).toHaveTextContent('0');
    await userEvent.click(canvas.getByRole('button', { name: 'Align center' }));
    await waitFor(() =>
      expect(canvas.getByRole('region', { name: 'Saved document preview' }).querySelector('p')).toHaveStyle({
        textAlign: 'center',
      }),
    );
    await expect(canvas.getByRole('button', { name: 'Align center' })).toHaveAttribute('aria-pressed', 'true');
  },
};

export const CodeLanguage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Authored formatting document' });
    await userEvent.click(within(textbox).getByText('const value = 1;'));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Code language' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Code language' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Code language' }));
    const language = dialog.getByRole('textbox', { name: 'Programming language' });
    await userEvent.clear(language);
    await userEvent.type(language, 'typescript');
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(canvas.getByRole('region', { name: 'Saved document preview' }).querySelector('code')).toHaveAttribute(
        'data-language',
        'typescript',
      ),
    );
    await expect(canvas.getByLabelText('Host save count')).toHaveTextContent('0');
  },
};
