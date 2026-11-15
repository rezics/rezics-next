import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { richTextEditorLabels, type RichTextEditorLabels } from './editor-labels.ts';
import { LinkEditBlock, LinkViewBlock } from './editor-upstream/reactjs-tiptap-editor/link-controls.tsx';

const meta = {
  title: 'Editor/Link controls',
  id: 'editor-links-review',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Contract-shaped synthetic https address for presentation review. */
const longHref =
  'https://knowledge.example.invalid/collections/0192f3a0-6c1e-7b2a-9d4e-000000000010/entries/reviews/very-long-resource-path?utm_source=synthetic-review&utm_medium=editor-link-controls';

/** Synthetic long interface copy. Shared product labels stay with their owner. */
const longLabels: RichTextEditorLabels = {
  ...richTextEditorLabels,
  url: 'Uniform resource locator for this hyperlink',
  apply: 'Apply the validated hyperlink address',
  cancel: 'Discard the unpublished address draft',
  unlink: 'Remove the saved hyperlink from this selection',
  editLink: 'Edit the saved hyperlink address',
  openLink: 'Open the saved hyperlink in a new browsing context',
  invalidUrl: 'Enter an http:, https: or mailto: address that this document admits.',
};

function idle() {}

/** Existing link-menu chrome, inheriting toolbar width and theme. */
function LinkMenuFixture({ children }: { children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={richTextEditorLabels.link}
      className="flex w-full min-w-0 max-w-80 flex-col gap-1 rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
    >
      {children}
    </div>
  );
}

export const LongUrl: Story = {
  name: 'Long URL',
  render: () => (
    <div className="flex min-w-0 w-full flex-col gap-8">
      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-medium">Saved link</h2>
        <LinkMenuFixture>
          <LinkViewBlock
            labels={richTextEditorLabels}
            href={longHref}
            isCurrent={() => true}
            onEdit={idle}
            onClear={idle}
          />
        </LinkMenuFixture>
      </section>
      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-medium">Address form</h2>
        <LinkMenuFixture>
          <LinkEditBlock
            labels={richTextEditorLabels}
            url={longHref}
            linked
            inputRef={null}
            onChange={idle}
            onApply={idle}
            onClear={idle}
            onCancel={idle}
          />
        </LinkMenuFixture>
      </section>
    </div>
  ),
};

export const LongTranslatedLabels: Story = {
  name: 'Long translated labels',
  render: () => (
    <div className="flex min-w-0 w-full flex-col gap-8">
      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-medium">Saved link</h2>
        <LinkMenuFixture>
          <LinkViewBlock
            labels={longLabels}
            href="https://example.invalid/resource"
            isCurrent={() => true}
            onEdit={idle}
            onClear={idle}
          />
        </LinkMenuFixture>
      </section>
      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-medium">Address form</h2>
        <LinkMenuFixture>
          <LinkEditBlock
            labels={longLabels}
            url="https://example.invalid/resource"
            linked
            inputRef={null}
            onChange={idle}
            onApply={idle}
            onClear={idle}
            onCancel={idle}
          />
        </LinkMenuFixture>
      </section>
    </div>
  ),
};

export const InvalidUrl: Story = {
  name: 'Invalid URL',
  render: () => (
    <LinkMenuFixture>
      <LinkEditBlock
        labels={richTextEditorLabels}
        url="javascript:alert(1)"
        error={richTextEditorLabels.invalidUrl}
        linked
        inputRef={null}
        onChange={idle}
        onApply={idle}
        onClear={idle}
        onCancel={idle}
      />
    </LinkMenuFixture>
  ),
};
