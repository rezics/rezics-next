import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { CollectionPresentationFields } from '../library/collection-editor';
import { collectionStoryMembers } from '../kernel/fake/collection-stories';
import { subjectOf } from '../library/reads';
import { pickText } from '@rezics/composition';
import { getLocale } from '../paraglide/runtime.js';
import { parseListPresentation } from '@rezics/ui/cover';
import definitions from '../kernel/recorded/definitions-release.json';
import { CollectionPreview, type CollectionBrowseRecord } from '../library/collection-browser';
import { recordedBrowseCollection } from './library-collection-row.stories';
import { PatternStory } from './page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Library/Collection Preview',
  id: 'patterns-collection-preview',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A bounded strip of the first three actual members, in source order. An unavailable preview is distinct from a proven empty Collection. The native preview transport is still unavailable in this checkout; these recorded members exercise only the presentation boundary.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function renderPreview(state: 'members' | 'empty' | 'unavailable' | 'preparing') {
  const collection: CollectionBrowseRecord = recordedBrowseCollection();
  if (state === 'empty') {
    collection.memberCount = 0;
    collection.preview = { state: 'loaded', members: [] };
  }
  if (state === 'unavailable') collection.preview = { state: 'unavailable' };
  if (state === 'preparing') collection.preview = { state: 'preparing' };
  return (
    <PatternStory>
      <div className="w-full p-4">
        <CollectionPreview collection={collection} />
      </div>
    </PatternStory>
  );
}

export const Members: Story = {
  render: () => renderPreview('members'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'Snow Country' });
    await expect(canvas.queryByRole('link', { name: 'Kokoro' })).toBeNull();
  },
};
export const Empty: Story = {
  render: () => renderPreview('empty'),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(m.library_collection_empty())).toBeVisible();
  },
};
export const Unavailable: Story = {
  render: () => renderPreview('unavailable'),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('status')).toHaveTextContent(
      m.library_collection_preview_unavailable(),
    );
  },
};

export const Preparing: Story = {
  render: () => renderPreview('preparing'),
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveTextContent(m.library_collection_preview_preparing());
    await expect(within(canvasElement).queryByText(m.library_collection_empty())).toBeNull();
  },
};

// Supplied long labels exercise wrapping; cover descriptors keep their recorded Subject associations.
function PresentationReviewExample() {
  const members = collectionStoryMembers.map((member) => ({ ...member, subject: subjectOf(member.subject) }));
  const savedCover = members[2]!.subject!.cover!;
  const replacementCover = members[3]!.subject!.cover!;
  const [kind, setKind] = useState<string | null>('schema:Movie');
  const [cover, setCover] = useState<string | null>(replacementCover.media);
  const types = (['schema:Book', 'schema:Movie'] as const).map((id) => ({
    id,
    label:
      id === 'schema:Book'
        ? 'Books with annotations · 注釈付きの本と多言語の版情報 · Livres avec annotations'
        : pickText(definitions.release.types[id].labels, getLocale()).text,
  }));
  const listPresentations = {
    'schema:Book': parseListPresentation(definitions.release.types['schema:Book'].listPresentation)!,
    'schema:Movie': parseListPresentation(definitions.release.types['schema:Movie'].listPresentation)!,
  };
  return (
    <PatternStory>
      <div className="w-full min-w-0 space-y-6 p-4 sm:p-6">
        <form id="collection-edit-form" onSubmit={(event) => event.preventDefault()}>
          <CollectionPresentationFields
            types={types}
            kind={kind}
            onKindChange={setKind}
            coverMediaId={cover}
            onCoverChange={setCover}
            savedKind="schema:Book"
            savedCoverMediaId={savedCover.media}
            savedCover={savedCover}
            savedCoverSource="owner"
            members={members}
            listPresentations={listPresentations}
          />
        </form>
        <Button type="submit" form="collection-edit-form">
          {m.library_collection_save()}
        </Button>
      </div>
    </PatternStory>
  );
}

export const PresentationReview: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Saved and draft Type and cover readings, with one deliberately long multilingual supplied label and actual recorded covers. Inspect at 320 px and wide widths; each correction belongs beside its comparison heading. This local draft uses the existing native Save handoff.',
      },
    },
  },
  render: () => <PresentationReviewExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.collection_choice_review() }));
    const heading = await canvas.findByRole('heading', { name: m.collection_choice_review_heading() });
    await expect(heading).toHaveFocus();
    for (const attribute of ['data-type-comparison', 'data-cover-comparison']) {
      const comparison = canvasElement.querySelector<HTMLElement>(`[${attribute}]`)!;
      await expect(within(comparison).getByRole('button')).toBeVisible();
      await expect(comparison.scrollWidth).toBeLessThanOrEqual(comparison.clientWidth);
      const [saved, draft] = comparison.querySelectorAll<HTMLElement>('[data-type-reading], [data-cover-reading]');
      if (window.innerWidth >= 640) {
        const savedFields = saved!.querySelector('[data-draft-type-state]') ?? saved!;
        const draftFields = draft!.querySelector('[data-draft-type-state]') ?? draft!;
        for (const [index, field] of [...savedFields.children].entries()) {
          await expect(field.getBoundingClientRect().top).toBeCloseTo(
            draftFields.children[index]!.getBoundingClientRect().top,
            0,
          );
        }
      } else {
        await expect(saved!.getBoundingClientRect().bottom).toBeLessThanOrEqual(draft!.getBoundingClientRect().top);
      }
    }
    const review = heading.closest<HTMLElement>('[data-presentation-review]')!;
    review.scrollIntoView({ block: 'start' });
  },
};
