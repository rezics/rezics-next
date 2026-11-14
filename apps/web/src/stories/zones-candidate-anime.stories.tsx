import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory } from './page';
import { animeCandidateIds } from '../zones/candidates/anime';

const previewPath = (id: string, route = '') => `/zones/${id}${route ? `/${route}` : ''}`;

const meta = {
  title: 'Zones/Candidates/Anime',
  component: PageStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Anime candidate gated development preview with fictional admitted rows; source opening is deferred. It does not claim an adopted official Anime site or a public dynamic-release catalogue. PageStory keeps the generated route and shared theme, viewport, and locale controls.',
      },
    },
  },
  args: {
    visitor: 'Signed Out',
    path: previewPath(animeCandidateIds.admittedPreview),
  },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AdmittedPreviewDeferred: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Anime' });
    await canvas.findByText(/Anime candidate — gated development preview/);
    await userEvent.click(await canvas.findByRole('link', { name: /The Lantern on Sora Bay/ }));
    await canvas.findByRole('heading', { name: 'The Lantern on Sora Bay' });
    await userEvent.click(await canvas.findByRole('link', { name: /Anime|home/i }));
    await canvas.findByRole('heading', { name: 'Anime' });
    await userEvent.click(await canvas.findByRole('link', { name: 'Films' }));
    await canvas.findByRole('heading', { name: 'Films' });
    await userEvent.click(await canvas.findByRole('link', { name: /Anime|home/i }));
    await canvas.findByRole('heading', { name: 'Anime' });
    await expect(canvas.getByText(/Anime candidate — gated development preview/)).toBeVisible();
  },
};

export const ReadyEmptyPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.readyEmpty) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Anime' });
    await canvas.findByText(/Anime candidate — gated development preview/);
    await expect(canvas.queryByRole('link', { name: /The Lantern on Sora Bay/ })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('link', { name: /Moss and Meteors/ })).not.toBeInTheDocument();
  },
  parameters: {
    docs: {
      description: {
        story: 'The home source is ready and returns no matching works.',
      },
    },
  },
};

export const SparsePreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.sparse) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: /The Lantern on Sora Bay/ });
    await canvas.findByRole('link', { name: /Moss and Meteors/ });
    await expect(canvas.queryByRole('link', { name: /A Map for Cloud Harbour/ })).not.toBeInTheDocument();
  },
  parameters: {
    docs: {
      description: {
        story: 'The home source is ready with a small fictional sample.',
      },
    },
  },
};

export const PlatformClosedPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.platformClosed) },
  parameters: {
    docs: {
      description: {
        story: 'The configured source read is explicitly gated with platform_closed.',
      },
    },
  },
};

export const SemanticUnavailablePreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.semanticUnavailable) },
  parameters: {
    docs: {
      description: {
        story: 'The source is unavailable with semantic_not_ready and Retry-After: 1.',
      },
    },
  },
};

export const PrivatePreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.private) },
  parameters: {
    docs: {
      description: {
        story: 'An anonymous private target is concealed with a 404 response.',
      },
    },
  },
};

export const MissingPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.missing) },
  parameters: {
    docs: {
      description: {
        story: 'A missing target has the same concealed 404 response as a private target.',
      },
    },
  },
};

export const FilmsStaticPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.admittedPreview, 'films') },
  parameters: {
    docs: {
      description: {
        story: 'Authored route with no source read; use the shell links to return home or visit another route.',
      },
    },
  },
};

export const ReleasesPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.admittedPreview, 'releases') },
  parameters: {
    docs: {
      description: {
        story: 'A fictional carrier list using the distinct rezics:AnimeRelease type.',
      },
    },
  },
};

export const SeriesStaticPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.admittedPreview, 'series') },
  parameters: {
    docs: {
      description: {
        story: 'Authored route with no source read; seasons and episodes remain parts of their series.',
      },
    },
  },
};
