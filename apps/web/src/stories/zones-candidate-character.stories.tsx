import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  characterCandidateCharacters,
  characterCandidateCopy,
  characterCandidateLabels,
  characterCandidateZoneIds,
} from '../zones/candidates/character';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Zones/Candidates/Characters',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Gated and deferred development previews built from fictional Storybook data. They do not establish an official Characters roster or a public dynamic release. The examples distinguish a ready preview, ready-empty and sparse homes, 403 platform_closed, 503 semantic_not_ready with Retry-After 1, and concealed private or missing 404 responses.',
      },
    },
  },
} satisfies Meta;

type Story = StoryObj<typeof meta>;

export default meta;

export const AdmittedDevelopmentPreview: Story = {
  name: 'Admitted preview — gated preview/deferred',
  render: () => <PageStory visitor="Signed Out" path={`/zones/${characterCandidateZoneIds.preview}`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const page = within(canvasElement);
    await page.findByText(characterCandidateCopy.preview);
    const character = characterCandidateCharacters[0];
    const link = await page.findByRole('link', { name: character.label });
    await expect(link.getAttribute('href')).toContain(
      `/zones/${characterCandidateZoneIds.preview}/subjects/${character.id}`,
    );

    await userEvent.click(link);
    await page.findByText(character.story);
    const returnLabel = m.zone_subject_return({ name: characterCandidateLabels[getLocale()] });
    const returnLink = await page.findByRole('link', { name: returnLabel });
    await userEvent.click(returnLink);
    await page.findByText(characterCandidateCopy.preview);
  },
};

export const ReadyEmpty: Story = {
  name: 'Ready empty — gated preview/deferred',
  render: () => <PageStory visitor="Signed Out" path={`/zones/${characterCandidateZoneIds.readyEmpty}`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const page = within(canvasElement);
    await page.findByText(characterCandidateCopy.readyEmpty);
    await page.findByRole('status');
  },
};

export const SparseHome: Story = {
  name: 'Sparse home — gated preview/deferred',
  render: () => <PageStory visitor="Signed Out" path={`/zones/${characterCandidateZoneIds.sparse}`} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await within(canvasElement).findByText(characterCandidateCopy.sparse);
  },
};

export const PlatformClosed: Story = {
  name: 'Platform closed — 403 platform_closed',
  render: () => <PageStory visitor="Signed Out" path={`/zones/${characterCandidateZoneIds.platformClosed}`} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('heading', { name: m.error_heading() });
  },
};

export const SemanticNotReady: Story = {
  name: 'Semantic not ready — 503 semantic_not_ready',
  render: () => <PageStory visitor="Signed Out" path={`/zones/${characterCandidateZoneIds.semanticNotReady}`} />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await page.findByRole('heading', { name: m.zone_unavailable_heading() });
    await page.findByText(m.zone_unavailable_message());
  },
};

export const PrivateTarget: Story = {
  name: 'Private target — concealed 404',
  render: () => <PageStory visitor="Signed Out" path={`/zones/${characterCandidateZoneIds.private}`} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('heading', { name: m.not_found_heading() });
  },
};

export const MissingTarget: Story = {
  name: 'Missing target — concealed 404',
  render: () => <PageStory visitor="Signed Out" path={`/zones/${characterCandidateZoneIds.missing}`} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('heading', { name: m.not_found_heading() });
  },
};
