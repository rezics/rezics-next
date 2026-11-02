import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreatorOfferEditor } from '../checkout/creator-offer-editor';
import type { CreatorEditorPageData, CreatorOfferGuard } from '../checkout/creator-offers';
import { configuredPriceExample } from '../kernel/fake/creator-offers';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const meta = {
  title: 'Patterns/Commerce/Creator edition disclosure',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Authored UNRUN supplied-data presentation cases. Edition metadata has no human title. Configured price rules are illustrative; no native sale authority or publication is claimed. The supplied guard permits local editing but has no CSRF token, so creation cannot dispatch. Authority retirement is an explicit denied read. Browser, native and integration verification remain deferred.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ready = {
  selling: true,
  csrfToken: '',
  createKey: id(6),
  editor: {
    kind: 'ready',
    edition: {
      editionId: id(1),
      editionRevision: id(2),
      state: 'published',
      targetSubjectId: id(3),
      creatorAccountId: id(4),
      revisionId: id(5),
      sha256: 'abcdef0123456789'.repeat(4),
      licence: 'CC-BY-4.0',
    },
    schema: configuredPriceExample,
  },
} satisfies CreatorEditorPageData;
const localEditingGuard: CreatorOfferGuard = { isCurrent: () => true, csrfToken: () => null };
const retiredGuard: CreatorOfferGuard = { isCurrent: () => false, csrfToken: () => null };

function SuppliedEditor({
  data = ready,
  narrow = false,
  retired = false,
}: {
  data?: CreatorEditorPageData;
  narrow?: boolean;
  retired?: boolean;
}) {
  return (
    <div className={narrow ? 'w-full max-w-xs p-4' : 'w-full p-4 md:p-6'}>
      <CreatorOfferEditor data={data} locale={getLocale()} guard={retired ? retiredGuard : localEditingGuard} />
    </div>
  );
}

export const Normal: Story = {
  render: () => <SuppliedEditor />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const fact of [m.creator_fixed_version(), ready.editor.edition.licence, m.creator_current_rights()])
      await expect(canvas.getByText(fact)).toBeVisible();
    const digest = canvas.getByText(ready.editor.edition.sha256);
    await expect(digest).not.toBeVisible();
    const title = canvas.getByRole('textbox', { name: m.creator_title() });
    await expect(title).toHaveValue('');
    await userEvent.click(title);
    await userEvent.type(title, 'My offer title');
    await userEvent.tab();
    await expect(canvas.getByRole('combobox', { name: m.creator_currency() })).toHaveFocus();
    await userEvent.selectOptions(canvas.getByRole('combobox'), 'usd');
    await userEvent.tab();
    await expect(canvas.getByRole('textbox', { name: m.creator_amount() })).toHaveFocus();
    await userEvent.type(canvas.getByRole('textbox', { name: m.creator_amount() }), '12.99');
    await userEvent.tab();
    await expect(canvas.getByRole('textbox', { name: m.creator_tax_code() })).toHaveFocus();
    await userEvent.type(canvas.getByRole('textbox', { name: m.creator_tax_code() }), 'txcd_10000000');
    await expect(canvas.getByRole('button', { name: m.creator_create() })).toBeDisabled();
    // The disabled write action is skipped; the next target is the native disclosure.
    await userEvent.tab();
    const summary = canvas.getByText(m.creator_edition_details_summary());
    await expect(summary).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(digest).toBeVisible();
    await expect(canvas.getByText(m.creator_edition_details_edition_id())).toBeVisible();
    await expect(canvas.getByText(ready.editor.edition.editionId)).toBeVisible();
    await expect(canvas.getByText(m.creator_edition_details_revision_id())).toBeVisible();
    await expect(canvas.getByText(ready.editor.edition.revisionId)).toBeVisible();
    await userEvent.keyboard(' ');
    await expect(digest).not.toBeVisible();
    await expect(summary).toHaveFocus();
    await expect(title).toHaveValue('My offer title');
  },
};

export const NarrowLongText: Story = {
  render: () => (
    <SuppliedEditor
      narrow
      data={{
        ...ready,
        editor: {
          ...ready.editor,
          edition: {
            ...ready.editor.edition,
            licence: 'https://creativecommons.org/licenses/by/4.0/legalcode.en',
          },
        },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.creator_title() }),
      'Offer title with long text 閱讀用の長いタイトル '.repeat(8),
    );
    await userEvent.click(canvas.getByText(m.creator_edition_details_summary()));
    await expect(canvas.getByText(ready.editor.edition.sha256)).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.creator_tax_code() })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
    const details = canvasElement.querySelector('details')!;
    await expect(details.scrollWidth).toBeLessThanOrEqual(details.clientWidth);
  },
};

export const Unavailable: Story = {
  render: () => <SuppliedEditor data={{ ...ready, editor: { kind: 'unavailable' } }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.creator_unavailable());
    await expect(canvas.queryByRole('textbox', { name: m.creator_title() })).toBeNull();
    await expect(canvas.queryByText(m.creator_edition_details_summary())).toBeNull();
  },
};

export const ChooseEdition: Story = {
  render: () => <SuppliedEditor data={{ ...ready, editor: { kind: 'choose-edition' } }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.creator_choose_edition());
    await expect(canvas.getByRole('link', { name: m.creator_publish_edition() })).toHaveAttribute(
      'href',
      `/${getLocale()}/editions/new`,
    );
    await expect(canvas.queryByText(ready.editor.edition.licence)).toBeNull();
  },
};

function RetirementExample() {
  const [retired, setRetired] = useState(false);
  return (
    <>
      <button type="button" className="m-4 min-h-11 underline" onClick={() => setRetired(true)}>
        Retire supplied authority
      </button>
      <SuppliedEditor
        retired={retired}
        data={retired ? { ...ready, selling: false, editor: { kind: 'denied' } } : ready}
      />
    </>
  );
}

export const AuthorityRetired: Story = {
  render: () => <RetirementExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(m.creator_edition_details_summary()));
    await expect(canvas.getByText(ready.editor.edition.sha256)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retire supplied authority' }));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.creator_denied());
    await expect(canvas.queryByText(ready.editor.edition.sha256)).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.creator_create() })).toBeNull();
    await expect(canvas.queryByText(m.creator_fixed_version())).toBeNull();
  },
};
