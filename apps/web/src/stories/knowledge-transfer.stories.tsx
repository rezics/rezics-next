import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useMemo } from 'react';
import { KnowledgeTransferEntry } from '../knowledge/transfer-panel';
import type { KnowledgeTransferOperations } from '../knowledge/transfer-visit';
import { m } from '../paraglide/messages.js';
import { locales, setLocale, type Locale } from '../paraglide/runtime.js';
import { knowledgeReadyDocument, knowledgeViewports } from './knowledge-document-fixtures';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const notebook = {
  notebookId: id(10),
  subjectId: id(4),
  title: 'Character studies · Reading and source notes',
  structureRevisionId: id(20),
  createdAt: '2026-11-10T00:00:00Z',
};
const receipt = {
  notebookId: id(10),
  documentId: id(11),
  revisionId: id(12),
  placementId: id(13),
  structureRevisionId: id(14),
};
type Scenario = 'PublicExport' | 'OwnExport' | 'CopyReview' | 'Copied' | 'StructureChanged' | 'Unavailable';
function TransferExample({ scenario, locale }: { scenario: Scenario; locale: Locale }) {
  useEffect(() => {
    setLocale(locale, { reload: false });
  }, [locale]);
  const operations = useMemo<KnowledgeTransferOperations>(
    () => ({
      current: () => true,
      subscribeRetirement: () => () => {},
      export: async () =>
        scenario === 'Unavailable'
          ? { state: 'unavailable' }
          : { state: 'ready', bytes: 'Illustrative native-envelope placeholder; this story does not download a file.' },
      prepare: async () =>
        scenario === 'Unavailable'
          ? { state: 'unavailable' }
          : {
              state: 'ready',
              viewer: id(99),
              csrfToken: 'illustrative',
              credential: 'illustrative-original-credential',
            },
      navigate: async (request) => ({
        state: 'ready',
        page:
          request.kind === 'owned'
            ? { kind: 'owned', notebooks: [notebook], next: null }
            : {
                kind: 'outline',
                notebookId: id(10),
                structureRevisionId: id(20),
                parentPlacementId: request.parentPlacementId,
                placements: [],
                next: null,
              },
      }),
      copy: async () => (scenario === 'StructureChanged' ? { state: 'conflict' } : { state: 'acknowledged', receipt }),
      readback: async () => ({
        state: 'ready',
        head: {
          ...knowledgeReadyDocument,
          accountId: id(99),
          notebookId: id(10),
          documentId: id(11),
          revisionId: id(12),
          publicationId: null,
          subjectIds: [id(4)],
        },
        provenance: {
          representation: 'public',
          documentId: id(1),
          revisionId: id(2),
          publicationId: id(3),
          sha256: 'a'.repeat(64),
        },
      }),
    }),
    [scenario],
  );
  const source =
    scenario === 'OwnExport'
      ? {
          representation: 'authoring' as const,
          accountId: id(99),
          notebookId: id(10),
          documentId: id(1),
          revisionId: id(2),
        }
      : { representation: 'public' as const, documentId: id(1), revisionId: id(2) };
  return (
    <main className="mx-auto min-w-0 max-w-3xl px-4 py-8 text-foreground sm:px-8">
      <KnowledgeTransferEntry
        key={`${scenario}:${locale}`}
        source={source}
        title="How a character changes across a scene: exact selected source"
        locale={locale}
        operations={operations}
        canCopy={scenario !== 'PublicExport'}
        saver={() => ({ save() {}, dispose() {} })}
      />
    </main>
  );
}
const meta = {
  title: 'Pages/Knowledge/Transfer',
  component: TransferExample,
  args: { scenario: 'PublicExport', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { options: locales, control: 'select' } },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: {
      description: {
        component:
          'Illustrative transfer states, not native recordings. Review phone390 and desktop1280 in both themes and all eight locales. Export saver is illustrative; no file is written.',
      },
    },
  },
} satisfies Meta<typeof TransferExample>;
export default meta;
type Story = StoryObj<typeof meta>;
async function review(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_transfer_copy() }));
  await userEvent.click(await canvas.findByRole('button', { name: notebook.title }));
  await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_transfer_review() }));
  return canvas;
}
export const PublicExport: Story = {
  args: { scenario: 'PublicExport' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_transfer_export() }));
    await expect(await canvas.findByRole('button', { name: m.knowledge_transfer_save_again() })).toBeVisible();
  },
};
export const OwnExport: Story = { ...PublicExport, args: { scenario: 'OwnExport' } };
export const CopyReview: Story = {
  args: { scenario: 'CopyReview' },
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    const button = canvas.getByRole('button', { name: m.knowledge_transfer_confirm() });
    button.focus();
    await expect(button).toHaveFocus();
  },
};
export const Copied: Story = {
  args: { scenario: 'Copied' },
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_transfer_confirm() }));
    await expect(await canvas.findByRole('link', { name: m.knowledge_transfer_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/documents/${id(11)}`),
    );
  },
};
export const StructureChanged: Story = {
  args: { scenario: 'StructureChanged' },
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_transfer_confirm() }));
    await expect(await canvas.findByRole('button', { name: m.knowledge_transfer_refresh() })).toBeVisible();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'Unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_transfer_export() }));
    await expect(await canvas.findByText(m.knowledge_unavailable())).toBeVisible();
  },
};
