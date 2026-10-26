import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from '@rezics/ui/shadcn/code-block';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/CodeBlock',
  component: CodeBlock,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof CodeBlock>;
export default meta;
type Story = StoryObj<typeof meta>;

const request = `curl https://api.rezics.com/works/dune \\
  -H "Accept: application/json"`;

export const Default: Story = {
  render: () => (
    <CodeBlock className="max-w-md">
      <CodeBlockHeader>
        <CodeBlockTitle>Fetch a Work</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={request} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent aria-label="Fetch a Work">{request}</CodeBlockContent>
    </CodeBlock>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Fetch a Work', { selector: '[data-slot="code-block-title"]' })).toBeVisible();
    await expect(canvas.getByLabelText('Fetch a Work', { selector: 'pre' })).toHaveTextContent(
      'api.rezics.com/works/dune',
    );
  },
};

export const CopyAndLineStates: Story = {
  render: () => (
    <CodeBlock size="sm" className="max-w-md">
      <CodeBlockHeader>
        <CodeBlockTitle>edition.json</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={'{ "edition": "2019" }'} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent aria-label="edition.json" lineNumbers={false}>
        <CodeBlockLine>{'{'}</CodeBlockLine>
        <CodeBlockLine variant="removed">{'  "edition": "1990",'}</CodeBlockLine>
        <CodeBlockLine variant="added">{'  "edition": "2019",'}</CodeBlockLine>
        <CodeBlockLine variant="highlighted">{'  "language": "en"'}</CodeBlockLine>
        <CodeBlockLine>{'}'}</CodeBlockLine>
      </CodeBlockContent>
      <CodeBlockFooter>Changed 1 line</CodeBlockFooter>
    </CodeBlock>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await user.click(canvas.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Copied' })).toBeVisible());
    const lines = [...canvasElement.querySelectorAll('[data-slot="code-block-line"]')];
    await expect(lines.map((line) => line.getAttribute('data-variant'))).toEqual([
      'default',
      'removed',
      'added',
      'highlighted',
      'default',
    ]);
  },
};

export const Destructive: Story = {
  render: () => (
    <CodeBlock variant="destructive" className="max-w-md">
      <CodeBlockHeader>
        <CodeBlockTitle>Import failed</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent aria-label="Import error" lineNumbers>
        {'Error: no match for ISBN 978-0-441-17271-9\n  at matchEdition (import.ts:42)'}
      </CodeBlockContent>
    </CodeBlock>
  ),
  async play({ canvasElement }) {
    const block = canvasElement.querySelector('[data-slot="code-block"]')!;
    await expect(block).toHaveAttribute('data-variant', 'destructive');
    await expect(within(canvasElement).getByLabelText('Import error', { selector: 'pre' })).toHaveTextContent(
      'no match for ISBN',
    );
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-4">
      <CodeBlock>
        <CodeBlockContent aria-label="Scrolling line">
          {'const title = "A very long line of code that scrolls horizontally instead of wrapping inside the block";'}
        </CodeBlockContent>
      </CodeBlock>
      <CodeBlock>
        <CodeBlockContent aria-label="Wrapped line" wrap lineNumbers>
          {'# 三體：地球往事\n作者：劉慈欣。この行は日本語を含み、折り返されます。'}
        </CodeBlockContent>
      </CodeBlock>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const scrolling = canvas.getByLabelText('Scrolling line', { selector: 'pre' });
    await expect(scrolling.scrollWidth).toBeGreaterThan(scrolling.clientWidth);
    await expect(scrolling).toHaveAttribute('tabindex', '0');
    await expect(canvas.getByText(/作者：劉慈欣/)).toBeVisible();
  },
};
