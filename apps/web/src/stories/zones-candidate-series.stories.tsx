import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { PageStory } from "./page";
import {
  SERIES_CANDIDATE_IDS,
  SERIES_CANDIDATE_SUBJECTS,
} from "../zones/candidates/series";

const meta: Meta = {
  title: "Zones/Candidates/Series",
  parameters: {
    docs: {
      description: {
        component:
          "Gated development preview of the inert Series starter. Records are fictional; no official site or public dynamic release is claimed.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function zonePath(id: string, route = ""): string {
  if (route) return `/zones/${id}/${route}`;
  return `/zones/${id}?list=works`;
}

function seriesPage(id: string, route = "") {
  return <PageStory visitor="Signed Out" path={zonePath(id, route)} />;
}

async function visibleHeading(canvasElement: HTMLElement, name: string) {
  const canvas = within(canvasElement);
  await waitFor(() =>
    expect(canvas.getByRole("heading", { name, exact: true })).toBeVisible(),
  );
  return canvas;
}

async function returnToSeries(
  canvasElement: HTMLElement,
  routeHeading: string,
  routeCopy: string | RegExp,
) {
  const canvas = await visibleHeading(canvasElement, routeHeading);
  await expect(canvas.getByText(routeCopy)).toBeVisible();
  await userEvent.click(
    canvas.getByRole("link", { name: "Series", exact: true }),
  );
  await visibleHeading(canvasElement, "Series");
}

export const DevelopmentPreview: Story = {
  name: "Gated development preview · admitted fictional records",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.preview),
  play: async ({ canvasElement }) => {
    const canvas = await visibleHeading(canvasElement, "Series");
    await expect(
      canvas.getByRole("link", { name: SERIES_CANDIDATE_SUBJECTS[0].label }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: SERIES_CANDIDATE_SUBJECTS[1].label }),
    ).toBeVisible();
    await expect(canvas.getByText(/both records are fictional/i)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("link", { name: SERIES_CANDIDATE_SUBJECTS[0].label }),
    );
    const subject = await visibleHeading(
      canvasElement,
      SERIES_CANDIDATE_SUBJECTS[0].label,
    );
    await expect(
      subject.getByText(/no series membership or ordering facts/i),
    ).toBeVisible();
    await userEvent.click(
      subject.getByRole("link", { name: "Series", exact: true }),
    );
    await visibleHeading(canvasElement, "Series");
  },
};

export const BookSeriesRoute: Story = {
  name: "Gated development preview · static book-series route",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.preview, "book-series"),
  play: async ({ canvasElement }) =>
    returnToSeries(
      canvasElement,
      "Book series",
      /This authored route is static\./i,
    ),
};

export const CreativeWorksRoute: Story = {
  name: "Gated development preview · static creative-works route",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.preview, "creative-works"),
  play: async ({ canvasElement }) =>
    returnToSeries(
      canvasElement,
      "Creative works",
      /This authored route is static\./i,
    ),
};

export const ReadyEmpty: Story = {
  name: "Gated development preview · ready empty",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.readyEmpty),
  play: async ({ canvasElement }) => {
    const canvas = await visibleHeading(canvasElement, "Series");
    await expect(
      canvas.getByText(/source read is ready and has no matching series/i),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("link", { name: SERIES_CANDIDATE_SUBJECTS[0].label }),
    ).not.toBeInTheDocument();
  },
};

export const Sparse: Story = {
  name: "Gated development preview · sparse home",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.sparse),
  play: async ({ canvasElement }) => {
    const canvas = await visibleHeading(canvasElement, "Series");
    await expect(
      canvas.getByRole("link", { name: SERIES_CANDIDATE_SUBJECTS[0].label }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("link", { name: SERIES_CANDIDATE_SUBJECTS[1].label }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByText(/optional facts, artwork, translations/i),
    ).toBeVisible();
  },
};

export const PlatformClosed: Story = {
  name: "Gated development preview · platform closed (403)",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.platformClosed),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByText(
          /source reads are closed for this development preview/i,
        ),
      ).toBeVisible(),
    );
  },
};

export const SemanticNotReady: Story = {
  name: "Gated development preview · deferred while semantic is not ready (503)",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.semanticNotReady),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByText(
          /semantic source for this development preview is not ready yet/i,
        ),
      ).toBeVisible(),
    );
  },
};

export const ConcealedPrivate: Story = {
  name: "Gated development preview · concealed private Zone (404)",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.private),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByText(/could not be found/i)).toBeVisible(),
    );
    await expect(canvas.queryByText(/private/i)).not.toBeInTheDocument();
  },
};

export const ConcealedMissing: Story = {
  name: "Gated development preview · concealed missing Zone (404)",
  render: () => seriesPage(SERIES_CANDIDATE_IDS.missing),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByText(/could not be found/i)).toBeVisible(),
    );
  },
};
