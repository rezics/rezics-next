import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLocation } from '@tanstack/react-router';
import { expect, userEvent, within } from 'storybook/test';
import { creatorEditionSearch } from '../checkout/creator-offer-address';
import { CreatorOfferEditor } from '../checkout/creator-offer-editor';
import type { CreatorEditorPageData, CreatorOfferGuard } from '../checkout/creator-offers';
import { configuredPriceExample } from '../kernel/fake/creator-offers';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Commerce/Creator edition disclosure',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Authored UNRUN supplied-data PatternStory plus AppShell cases at the installed creator editor path. Ready and retired-from-ready keep ?editionId= of the supplied edition; ChooseEdition and Unavailable omit it because those states have no selected edition. Edition metadata has no human title. Configured price rules are illustrative; no native sale authority or publication is claimed. The supplied guard permits local editing but has no CSRF token, so creation cannot dispatch. Authority retirement is an explicit denied read. Browser, native and integration verification remain deferred.',
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
const longLicence = 'https://creativecommons.org/licenses/by/4.0/legalcode.en';

function creatorEditorPath(editionId?: string) {
  return editionId ? `/creator/offers/new?editionId=${encodeURIComponent(editionId)}` : '/creator/offers/new';
}

function selectedEditionId(data: CreatorEditorPageData) {
  return data.editor.kind === 'ready' ? data.editor.edition.editionId : undefined;
}

function RouteBoundEditor({ data, retired = false }: { data: CreatorEditorPageData; retired?: boolean }) {
  const selected = creatorEditionSearch(
    useLocation({ select: (location) => location.search as Record<string, unknown> }),
  ).contentEditionId;
  const readyEdition = data.editor.kind === 'ready' ? data.editor.edition : undefined;
  const bound =
    readyEdition && selected !== readyEdition.editionId
      ? { ...data, editor: { kind: 'choose-edition' as const } }
      : data;
  return <CreatorOfferEditor data={bound} locale={getLocale()} guard={retired ? retiredGuard : localEditingGuard} />;
}

function SuppliedEditor({
  data = ready,
  retired = false,
  editionId = selectedEditionId(data),
  children,
}: {
  data?: CreatorEditorPageData;
  retired?: boolean;
  editionId?: string;
  children?: ReactNode;
}) {
  return (
    <PatternStory visitor="Signed In" path={creatorEditorPath(editionId)}>
      <AppShell>
        {children}
        <RouteBoundEditor data={data} retired={retired} />
      </AppShell>
    </PatternStory>
  );
}

async function editorMain(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole('main'));
}

export const Normal: Story = {
  render: () => <SuppliedEditor />,
  play: async ({ canvasElement }) => {
    const canvas = await editorMain(canvasElement);
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
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => (
    <SuppliedEditor
      data={{
        ...ready,
        editor: {
          ...ready.editor,
          edition: {
            ...ready.editor.edition,
            licence: longLicence,
          },
        },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = await editorMain(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.creator_title() }),
      'Offer title with long text 閱讀用の長いタイトル '.repeat(8),
    );
    await userEvent.click(canvas.getByText(m.creator_edition_details_summary()));
    await expect(canvas.getByText(ready.editor.edition.sha256)).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.creator_tax_code() })).toBeVisible();
    const details = canvas.getByText(m.creator_edition_details_summary()).closest('details')!;
    await expect(details.scrollWidth).toBeLessThanOrEqual(details.clientWidth);
  },
};

export const Unavailable: Story = {
  render: () => <SuppliedEditor data={{ ...ready, editor: { kind: 'unavailable' } }} />,
  play: async ({ canvasElement }) => {
    const canvas = await editorMain(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.creator_unavailable());
    await expect(canvas.queryByRole('textbox', { name: m.creator_title() })).toBeNull();
    await expect(canvas.queryByText(m.creator_edition_details_summary())).toBeNull();
  },
};

export const ChooseEdition: Story = {
  render: () => <SuppliedEditor data={{ ...ready, editor: { kind: 'choose-edition' } }} />,
  play: async ({ canvasElement }) => {
    const canvas = await editorMain(canvasElement);
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
    <SuppliedEditor
      editionId={ready.editor.edition.editionId}
      retired={retired}
      data={retired ? { ...ready, selling: false, editor: { kind: 'denied' } } : ready}
    >
      <button type="button" className="mb-4 min-h-11 underline" onClick={() => setRetired(true)}>
        Retire supplied authority
      </button>
    </SuppliedEditor>
  );
}

export const AuthorityRetired: Story = {
  render: () => <RetirementExample />,
  play: async ({ canvasElement }) => {
    const canvas = await editorMain(canvasElement);
    await userEvent.click(canvas.getByText(m.creator_edition_details_summary()));
    await expect(canvas.getByText(ready.editor.edition.sha256)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retire supplied authority' }));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.creator_denied());
    await expect(canvas.queryByText(ready.editor.edition.sha256)).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.creator_create() })).toBeNull();
    await expect(canvas.queryByText(m.creator_fixed_version())).toBeNull();
  },
};
