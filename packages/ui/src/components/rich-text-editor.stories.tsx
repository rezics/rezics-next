import type { DocumentProfile, DocumentSnapshot } from '@rezics/document';
import { checkDocument, fromPlainText } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';

type DemoOptions = {
  profile: DocumentProfile;
  label: string;
  initial?: string;
  maxLength?: number;
  readOnly?: boolean;
  compact?: boolean;
};

function createDemo(options: DemoOptions) {
  const initial = fromPlainText(options.initial ?? '', options.profile);
  const latest: { current: DocumentSnapshot | null } = { current: null };

  function Demo() {
    const [value, setValue] = useState(initial);

    return (
      <RichTextEditor
        value={value}
        onChange={(next) => {
          latest.current = next;
          setValue(next);
        }}
        label={options.label}
        placeholder="Write something for REZICS"
        maxLength={options.maxLength}
        readOnly={options.readOnly}
        compact={options.compact}
      />
    );
  }

  return { Demo, initial, latest };
}

function checkedSnapshot(latest: { current: DocumentSnapshot | null }, fallback: DocumentSnapshot): DocumentSnapshot {
  const snapshot = latest.current ?? fallback;
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot;
}

const meta = {
  title: 'Components/RichTextEditor',
  component: RichTextEditor,
  args: {
    value: fromPlainText(''),
    onChange: () => undefined,
    label: 'A post',
  },
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A snapshot-backed writing surface for text and blocks profile documents. It publishes a validated snapshot after a short typing pause or when focus leaves the editor.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="min-h-56 bg-background p-6 font-sans text-foreground">
        <div className="mx-auto max-w-2xl">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const textProfile = createDemo({ profile: 'text', label: 'Text profile post' });
const textLimits = createDemo({ profile: 'text', label: 'Limited post', maxLength: 8 });
const blocksProfile = createDemo({ profile: 'blocks', label: 'Blocks profile post' });
const markdown = createDemo({ profile: 'blocks', label: 'Markdown post' });
const paste = createDemo({ profile: 'blocks', label: 'Pasted post' });
const labelled = createDemo({ profile: 'text', label: 'Reply to Mira', compact: true });
const readOnly = createDemo({ profile: 'text', label: 'Saved reply', initial: 'A saved reply.', readOnly: true });

export const TextProfile: Story = {
  render: () => <textProfile.Demo />,
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'Text profile post' });
    await userEvent.type(textbox, '## A text heading{Enter}> A text quote');
    await waitFor(() => {
      const current = textProfile.latest.current;
      expect(current?.doc.content?.[0]?.content?.[0]?.text).toBe('A text heading');
      expect(current?.doc.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe('A text quote');
    });
    const snapshot = checkedSnapshot(textProfile.latest, textProfile.initial);
    expect(snapshot.profile).toBe('text');
    expect(snapshot.doc.content?.[0]?.type).toBe('heading');
    expect(snapshot.doc.content?.[0]?.attrs?.level).toBe(2);
    expect(snapshot.doc.content?.[1]?.type).toBe('blockquote');
  },
};

export const TextProfileLimits: Story = {
  render: () => <textLimits.Demo />,
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'Limited post' });
    await userEvent.type(textbox, '123456789');
    await waitFor(() => expect(textLimits.latest.current).not.toBeNull());
    const snapshot = checkedSnapshot(textLimits.latest, textLimits.initial);
    expect(snapshot.profile).toBe('text');
    expect(snapshot.doc.content?.[0]?.content?.[0]?.text).toBe('12345678');
  },
};

export const BlocksProfile: Story = {
  render: () => <blocksProfile.Demo />,
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'Blocks profile post' });
    await userEvent.type(textbox, '## A blocks heading ');
    await waitFor(() => expect(blocksProfile.latest.current).not.toBeNull());
    const snapshot = checkedSnapshot(blocksProfile.latest, blocksProfile.initial);
    expect(snapshot.profile).toBe('blocks');
    expect(snapshot.doc.content?.[0]?.type).toBe('heading');
    expect(snapshot.doc.content?.[0]?.attrs?.level).toBe(2);
  },
};

export const MarkdownShortcuts: Story = {
  render: () => <markdown.Demo />,
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'Markdown post' });
    await userEvent.type(textbox, '**bold words**');
    await waitFor(() => expect(markdown.latest.current).not.toBeNull());
    const snapshot = checkedSnapshot(markdown.latest, markdown.initial);
    expect(snapshot.doc.content?.[0]?.content?.[0]?.text).toBe('bold words');
    expect(snapshot.doc.content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe('bold');
  },
};

export const PasteSanitized: Story = {
  render: () => <paste.Demo />,
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'Pasted post' });
    await userEvent.click(textbox);

    const clipboard = new DataTransfer();
    clipboard.setData(
      'text/html',
      '<p onclick="run()" style="color:red">Safe <a href="javascript:run()">unsafe link</a> <a href="https://example.com">site</a></p><script>attack()</script><style>.secret{color:red}</style>',
    );
    clipboard.setData('text/plain', 'Safe unsafe link site');
    await userEvent.paste(clipboard);

    await waitFor(() => expect(paste.latest.current).not.toBeNull());
    const snapshot = checkedSnapshot(paste.latest, paste.initial);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('attack');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('javascript:');
    expect(serialized).toContain('https://example.com');
  },
};

export const LabelledField: Story = {
  render: () => <labelled.Demo />,
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'Reply to Mira' });
    await userEvent.type(textbox, 'Thanks for sharing this.');
    await waitFor(() => expect(labelled.latest.current).not.toBeNull());
    const snapshot = checkedSnapshot(labelled.latest, labelled.initial);
    expect(snapshot.doc.content?.[0]?.content?.[0]?.text).toBe('Thanks for sharing this.');
  },
};

export const ReadOnly: Story = {
  render: () => <readOnly.Demo />,
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'Saved reply' });
    expect(textbox).toHaveAttribute('aria-readonly', 'true');
    await userEvent.click(textbox);
    await userEvent.paste(' Changed');
    expect(textbox).toHaveTextContent('A saved reply.');
    const snapshot = checkedSnapshot(readOnly.latest, readOnly.initial);
    expect(snapshot.doc.content?.[0]?.content?.[0]?.text).toBe('A saved reply.');
  },
};
