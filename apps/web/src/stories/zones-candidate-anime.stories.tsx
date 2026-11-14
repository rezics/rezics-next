import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PageStory } from "./page";
import { animeCandidateIds } from "../zones/candidates/anime";

const previewPath = (id: string, route = "") =>
  `/zones/${id}${route ? `/${route}` : ""}`;

const meta = {
  title: "Zones/Candidates/Anime",
  component: PageStory,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Deferred development preview with fictional sample content. It does not claim an adopted official Anime site or a public dynamic-release catalogue. PageStory keeps the generated route and shared theme, viewport, and locale controls.",
      },
    },
  },
  args: {
    visitor: "Signed Out",
    path: previewPath(animeCandidateIds.admittedPreview),
  },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PreviewDeferred: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Anime" });
    await canvas.findByText(/Development preview: this fictional sample/);
    await userEvent.click(
      await canvas.findByRole("link", { name: "The Lantern on Sora Bay" }),
    );
    await canvas.findByRole("heading", { name: "The Lantern on Sora Bay" });
    await userEvent.click(
      await canvas.findByRole("link", { name: /Anime|home/i }),
    );
    await canvas.findByRole("heading", { name: "Anime" });
    await userEvent.click(await canvas.findByRole("link", { name: "Films" }));
    await canvas.findByRole("heading", { name: "Films" });
    await userEvent.click(
      await canvas.findByRole("link", { name: /Anime|home/i }),
    );
    await canvas.findByRole("heading", { name: "Anime" });
    await expect(
      canvas.getByText(/Development preview: this fictional sample/),
    ).toBeVisible();
  },
};

export const ReadyEmptyPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.readyEmpty) },
  parameters: {
    docs: {
      description: {
        story: "The home source is ready and returns no matching works.",
      },
    },
  },
};

export const SparsePreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.sparse) },
  parameters: {
    docs: {
      description: {
        story: "The home source is ready with a small fictional sample.",
      },
    },
  },
};

export const PlatformClosedPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.platformClosed) },
  parameters: {
    docs: {
      description: {
        story:
          "The configured source read is explicitly gated with platform_closed.",
      },
    },
  },
};

export const SemanticUnavailablePreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.semanticUnavailable) },
  parameters: {
    docs: {
      description: {
        story:
          "The source is unavailable with semantic_not_ready and Retry-After: 1.",
      },
    },
  },
};

export const PrivateOrMissingPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.concealed) },
  parameters: {
    docs: {
      description: {
        story:
          "Private and missing targets share the same concealed 404 response.",
      },
    },
  },
};

export const FilmsStaticPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.admittedPreview, "films") },
  parameters: {
    docs: {
      description: {
        story:
          "Authored route with no source read; use the shell links to return home or visit another route.",
      },
    },
  },
};

export const ReleasesPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.admittedPreview, "releases") },
  parameters: {
    docs: {
      description: {
        story:
          "A fictional carrier list using the distinct rezics:AnimeRelease type.",
      },
    },
  },
};

export const SeriesStaticPreviewDeferred: Story = {
  args: { path: previewPath(animeCandidateIds.admittedPreview, "series") },
  parameters: {
    docs: {
      description: {
        story:
          "Authored route with no source read; seasons and episodes remain parts of their series.",
      },
    },
  },
};
