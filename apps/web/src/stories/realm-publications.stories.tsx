import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import { RealmShelf, type RealmShelfTransport } from '../community/space-page';
import type { PublishedSubject, RealmBoard, RealmHome } from '../community/space';
import boardsRecording from '../kernel/recorded/realm-boards.json';
import publicationsRecording from '../kernel/recorded/realm-publications.json';
import subjectsRecording from '../kernel/recorded/realm-subjects.json';
import realmRecording from '../kernel/recorded/realm.json';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Community/Realm Publications',
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The Space and Realm page shelf uses separate native board and publication continuations. Curation selects existing subjects and changes only this Realm shelf. These recorded-content interaction examples exercise UI states; native commands remain the authority for permission, replay and head conflicts. Subject links use the existing Global fallback until Semantic delivers the Realm page binding. Review these same IDs with phone 390 and desktop 1280 viewport globals, locale and theme globals.',
      },
    },
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Mode = 'ready' | 'empty' | 'denied' | 'unavailable' | 'stale' | 'loading' | 'conflict' | 'uncertain' | 'authority';

const boards: RealmBoard[] = boardsRecording.items.map((board) => ({
  id: board.id,
  title: board.title,
  purpose: board.purpose === 'reviews' ? 'reviews' : 'discussion',
  visibility: 'published',
}));
const subjects: PublishedSubject[] = Object.entries(subjectsRecording.subjects).map(([id, read]) => {
  const publicationId = publicationsRecording.items.find((item) => item.subjectId === id)?.publicationId;
  return {
    id,
    labels: read.subject.labels,
    types: read.summary.types,
    label: read.summary.label.value,
    cover: read.summary.cover
      ? {
          ...read.summary.cover,
          variants: read.summary.cover.variants.map(({ format, width }) => {
            if (format !== 'avif' && format !== 'webp') throw new Error(`Unsupported recorded cover format: ${format}`);
            return { format, width };
          }),
        }
      : null,
    ...(publicationId ? { publicationId } : {}),
  };
});
function Example({ mode = 'ready', signedOut = false }: { mode?: Mode; signedOut?: boolean }) {
  let decisions = 0;
  let originalKey: string | undefined;
  const transport: RealmShelfTransport = {
    boards: async () => {
      if (mode === 'loading') return new Promise(() => {});
      if (mode === 'denied' || mode === 'unavailable' || mode === 'stale') return { kind: mode };
      return { kind: 'page', items: boards.slice(1), next: null, unavailable: 0 };
    },
    publications: async () => {
      if (mode === 'denied' || mode === 'unavailable' || mode === 'stale') return { kind: mode };
      return { kind: 'page', items: subjects.slice(1), next: null, unavailable: 0 };
    },
    change: async (input) => {
      decisions += 1;
      if (mode === 'authority') return { kind: 'denied' };
      if (mode === 'conflict' && decisions === 1)
        return { kind: 'conflict', currentHead: publicationsRecording.items[1]!.publicationId };
      if (mode === 'uncertain' && decisions === 1) {
        originalKey = input.idempotencyKey;
        return { kind: 'unavailable' };
      }
      if (originalKey) await expect(input.idempotencyKey).toBe(originalKey);
      return { kind: 'saved', head: publicationsRecording.items[2]!.publicationId };
    },
  };
  const realm: RealmHome = {
    id: realmRecording.realm.realmId,
    title: realmRecording.realm.title,
    visibility: 'public',
    viewer: null,
    boards: mode === 'empty' ? [] : boards.slice(0, 1),
    published: mode === 'empty' ? [] : subjects.slice(0, 1),
    boardNext: mode === 'empty' ? null : 'boards-next',
    publicationNext: mode === 'empty' ? null : 'publications-next',
  };
  return (
    <PatternStory visitor={signedOut ? 'Signed Out' : 'Signed In'}>
      <div className="mx-auto max-w-5xl space-y-8 p-4 sm:p-8">
        <RealmShelf realm={realm} transport={transport} />
      </div>
    </PatternStory>
  );
}
async function withdraw(canvasElement: HTMLElement) {
  const subject = subjects[0]!;
  const title = subject.labels[getLocale()] ?? subject.label ?? '';
  const trigger = await within(canvasElement).findByRole('button', { name: m.realm_publication_actions({ title }) });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(await screen.findByText(m.realm_publication_withdraw()));
}
export const Rest: Story = { render: () => <Example signedOut /> };
export const LaterItems: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_boards_more() }));
    await view.findByRole('link', { name: boards[1]!.title ?? '' });
    await expect(view.getByRole('button', { name: m.realm_publications_more() })).toBeEnabled();
    await userEvent.click(view.getByRole('button', { name: m.realm_publications_more() }));
    await view.findByRole('link', { name: subjects[1]!.labels[getLocale()] ?? subjects[1]!.label ?? '' });
  },
};
export const Empty: Story = { render: () => <Example mode="empty" /> };
export const Loading: Story = {
  render: () => <Example mode="loading" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_boards_more() }));
    await expect(view.getByRole('button', { name: m.realm_shelf_loading() })).toBeDisabled();
  },
};
export const Denied: Story = {
  render: () => <Example mode="denied" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_publications_more() }));
    await view.findByText(m.realm_shelf_denied());
    await expect(view.queryByText(m.realm_published_empty())).toBeNull();
  },
};
export const Unavailable: Story = {
  render: () => <Example mode="unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_boards_more() }));
    await view.findByText(m.realm_shelf_unavailable());
    await expect(view.queryByText(m.realm_boards_empty())).toBeNull();
  },
};
export const CursorExpired: Story = {
  render: () => <Example mode="stale" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_boards_more() }));
    await view.findByText(m.realm_shelf_stale());
    await userEvent.click(view.getByRole('button', { name: m.realm_shelf_restart() }));
    await view.findByText(m.realm_shelf_stale());
  },
};
export const WithdrawAndRepublish: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await withdraw(canvasElement);
    await view.findByText(m.realm_publication_removed());
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_curate() }));
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_publish() }));
    await view.findByText(m.realm_publication_saved());
    await expect(
      view.getByRole('link', { name: subjects[0]!.labels[getLocale()] ?? subjects[0]!.label ?? '' }),
    ).toHaveAttribute('href', expect.not.stringContaining('?realm'));
  },
};
export const Conflict: Story = {
  render: () => <Example mode="conflict" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await withdraw(canvasElement);
    await view.findByText(m.realm_publication_conflict());
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_review() }));
    await view.findByText(m.realm_publication_removed());
  },
};
export const Uncertain: Story = {
  render: () => <Example mode="uncertain" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await withdraw(canvasElement);
    await view.findByText(m.realm_publication_uncertain());
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_retry() }));
    await view.findByText(m.realm_publication_removed());
  },
};
export const CurrentAuthorityDenied: Story = {
  render: () => <Example mode="authority" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await withdraw(canvasElement);
    await view.findByText(m.realm_publication_denied());
    await expect(
      view.getByRole('link', { name: subjects[0]!.labels[getLocale()] ?? subjects[0]!.label ?? '' }),
    ).toBeVisible();
  },
};
