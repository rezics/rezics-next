import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { fromPlainText } from '@rezics/document';
import { KnowledgeReferenceAuthoring } from '../knowledge/reference-authoring';
import { KnowledgeReferenceList } from '../knowledge/reference-view';
import { writeReference, type ReferenceDraft } from '../knowledge/reference-model';
import { getLocale } from '../paraglide/runtime.js';
import { referenceCopy } from '../knowledge/reference-copy';
import { knowledgeDocumentId, knowledgeRevisionId, knowledgeViewports } from './knowledge-document-fixtures';

export function illustrativeProblem(): ReferenceDraft {
  const body = fromPlainText(
    'Problem: prove that a convergent sequence is bounded. State the theorem and definition used.',
    'blocks',
  );
  const sourceBlockId = body.doc.content![0]!.attrs!.id as string;
  const theorem = writeReference(
    { body, references: [] },
    {
      id: 'theorem-citation',
      role: 'uses',
      sourceBlockId,
      target: {
        kind: 'revision',
        documentId: knowledgeDocumentId,
        revisionId: knowledgeRevisionId,
        sha256: 'a'.repeat(64),
        blockId: 'theorem-statement',
      },
    },
    'The boundedness theorem, with its original assumptions',
  );
  return writeReference(
    theorem,
    {
      id: 'definition-citation',
      role: 'cites',
      sourceBlockId,
      target: {
        kind: 'revision',
        documentId: '0192f3a0-6c1e-7b2a-9d4e-000000000041',
        revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000042',
        sha256: 'b'.repeat(64),
      },
    },
    'Definition of convergence',
  );
}
function Authoring() {
  const [draft, setDraft] = useState(illustrativeProblem);
  return (
    <KnowledgeReferenceAuthoring
      draft={draft}
      locale={getLocale()}
      disabled={false}
      onChange={setDraft}
      onEditingChange={() => undefined}
      inspect={async () => ({ state: 'unavailable' })}
    />
  );
}
const meta = {
  title: 'Pages/Knowledge/References',
  component: Authoring,
  parameters: { viewport: { options: knowledgeViewports }, layout: 'padded' },
  decorators: [
    (Story) => (
      <main className="mx-auto min-w-0 max-w-3xl p-4">
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Authoring>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReferenceAuthoring: Story = {
  render: () => <Authoring />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const copy = referenceCopy(getLocale());
    await userEvent.click(canvas.getAllByRole('button', { name: copy.edit })[0]!);
    const kind = canvas.getByRole('combobox', { name: copy.kind });
    await userEvent.selectOptions(kind, 'document');
    await expect(canvas.getByText(copy.liveHint)).toBeVisible();
    await userEvent.selectOptions(kind, 'revision');
    await expect(canvas.getByRole('textbox', { name: copy.revisionId })).toHaveValue(knowledgeRevisionId);
    await userEvent.click(canvas.getByRole('button', { name: copy.cancel }));
  },
};
export const ExactCitation: Story = {
  render: () => {
    const draft = illustrativeProblem();
    return <KnowledgeReferenceList {...draft} locale={getLocale()} inspect={async () => ({ state: 'unavailable' })} />;
  },
};
export const TargetUnavailable: Story = {
  render: () => {
    const draft = illustrativeProblem();
    return (
      <KnowledgeReferenceList
        {...draft}
        references={draft.references.map((reference) => ({ ...reference, target: null }))}
        locale={getLocale()}
      />
    );
  },
};
