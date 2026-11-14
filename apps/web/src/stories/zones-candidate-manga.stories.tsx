import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory, pageReady } from './page';
import { mangaCandidateIds } from '../zones/candidates/manga';

const meta = {
  title: 'Zones/Candidates/Manga',
  parameters: {
    docs: {
      description: {
        component:
          'Gated, deferred development preview built from the inert Manga starter. All series are fictional; no official instance or public dynamic-release claim is adopted. The Volumes route stays static and performs no catalogue read.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function zonePath(id: string) {
  return `/zones/${id}`;
}

export const AdmittedPreview = {
  name: 'Gated preview · deferred',
  render: () => <PageStory visitor="Signed Out" path={zonePath(mangaCandidateIds.preview)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(canvasElement);
    await view.findByText(/Fictional examples for a gated development preview/);
    const volumes = await view.findByRole('link', { name: 'Volumes' });
    await userEvent.click(volumes);
    await view.findByRole('heading', { name: 'Volumes' });
    await view.findByText(/This is a static guide route/);
    await userEvent.click(await view.findByRole('link', { name: 'Manga' }));
    await view.findByRole('heading', { name: 'Manga' });
    for (const subject of ['Clockwork Kites', 'Moonlit Postcards']) {
      await userEvent.click(await view.findByRole('link', { name: subject }));
      await view.findByRole('heading', { name: subject });
      await view.findByText(/Fictional subject in a gated development preview/);
      await userEvent.click(await view.findByRole('link', { name: 'Manga' }));
      await view.findByRole('heading', { name: 'Manga' });
    }
    await view.findByRole('link', { name: 'Clockwork Kites' });
    await view.findByRole('link', { name: 'Moonlit Postcards' });
  },
} satisfies Story;

export const ReadyEmpty = {
  name: 'Ready empty · development preview',
  parameters: {
    docs: {
      description: {
        story: 'The configured ComicSeries read is ready and contains no subjects.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(mangaCandidateIds.empty)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(canvasElement);
    await view.findByRole('heading', { name: 'Manga' });
    await view.findByText(/Fictional examples for a gated development preview/);
    await expect(view.queryByRole('link', { name: 'Clockwork Kites' })).not.toBeInTheDocument();
    await expect(view.queryByRole('link', { name: 'Moonlit Postcards' })).not.toBeInTheDocument();
  },
} satisfies Story;

export const Sparse = {
  name: 'Sparse home · development preview',
  parameters: {
    docs: {
      description: {
        story: 'A ready ComicSeries read with one fictional subject and no cover art.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(mangaCandidateIds.sparse)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(canvasElement);
    await view.findByRole('link', { name: 'Clockwork Kites' });
    await expect(view.queryByRole('link', { name: 'Moonlit Postcards' })).not.toBeInTheDocument();
  },
} satisfies Story;

export const PlatformClosed = {
  name: 'Platform closed · 403 · deferred',
  parameters: {
    docs: {
      description: {
        story: 'The readable public Zone is distinct from its closed source platform.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(mangaCandidateIds.closed)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await within(canvasElement).findByText(/platform_closed/i);
  },
} satisfies Story;

export const SemanticNotReady = {
  name: 'Semantic not ready · 503 · Retry-After 1',
  parameters: {
    docs: {
      description: {
        story: 'Source preparation is unavailable and offers a one-second retry hint.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(mangaCandidateIds.unavailable)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await within(canvasElement).findByText(/semantic_not_ready/i);
  },
} satisfies Story;

export const PrivateOrMissing = {
  name: 'Private or missing · concealed 404',
  parameters: {
    docs: {
      description: {
        story: 'Private and missing targets share the same concealed response.',
      },
    },
  },
  render: () => <PageStory visitor="Signed Out" path={zonePath(mangaCandidateIds.concealed)} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(canvasElement);
    await view.findByText(/not found/i);
    await expect(view.queryByText(/Clockwork Kites|Moonlit Postcards/)).not.toBeInTheDocument();
  },
} satisfies Story;
