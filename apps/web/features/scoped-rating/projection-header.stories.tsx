import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { FrameCandidate } from './frames.ts';
import { ProjectionHeader } from './projection-header.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';

// Who is rated and where: the subject, then the places as chips in their own language. A place the reader has not
// reached is one placeholder with no name.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const [e1, , e3] = fixture.episodes as [FrameCandidate, FrameCandidate, FrameCandidate];
const canon = fixture.continuities[0]!;

const meta = {
  title: 'Scoped rating/Projection header',
  component: ProjectionHeader,
  args: { summary: fixture.placeEpisode3.summary, locale: 'en', messages: messages.en },
  decorators: [Story => <div className="mx-auto max-w-xl p-4 sm:p-6"><Story /></div>],
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: '/en/e/elizabeth-bennet' } },
} satisfies Meta<typeof ProjectionHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One place: the subject's name links to its page, and the place is a chip with its own link. */
export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 3 })).toHaveTextContent('Elizabeth Bennet');
    await expect(canvas.getByRole('link', { name: 'Elizabeth Bennet' })).toHaveAttribute('href', expect.stringMatching(/^\/en\/e\//));
    const places = canvas.getByRole('list', { name: 'In' });
    await expect(within(places).getAllByRole('link')).toHaveLength(1);
    await expect(within(places).getByRole('link', { name: 'Episode 3 · Hunsford' })).toBeVisible();
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };

/** Several places at once, such as an episode within one continuity: every chip stays reachable on a narrow screen. */
export const SeveralPlaces: Story = {
  args: { summary: fixture.projectionRead(fixture.iri('1a80'), fixture.subject.iri, [e3.iri, canon.iri]).summary },
  async play({ canvasElement }) {
    const places = within(canvasElement).getByRole('list', { name: 'In' });
    await expect(within(places).getAllByRole('link')).toHaveLength(2);
    await expect(within(places).getByRole('link', { name: 'Austen’s novel' })).toBeVisible();
    await fits();
  },
};
export const SeveralPlacesPhone: Story = { ...SeveralPlaces, globals: phone };
export const SeveralPlacesDarkPhone: Story = { ...SeveralPlaces, globals: { ...phone, theme: 'dark' } };

/** A place later than the reader has read is not named, drawn or linked: one placeholder says why. */
export const SpoilerHidden: Story = {
  args: { summary: fixture.hiddenSummary(fixture.iri('1a81')) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Hidden until you reach it')).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByText(/Episode|Elizabeth/)).toBeNull();
    await fits();
  },
};
export const SpoilerHiddenPhone: Story = { ...SpoilerHidden, globals: phone };

/** Nothing read yet: no summary at all is the same placeholder, never a blank header. */
export const NoSummary: Story = {
  args: { summary: null },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Hidden until you reach it')).toBeVisible();
  },
};

/** Long names in their own languages wrap or truncate inside the card; none pushes the page wider. */
export const LongNames: Story = {
  args: { summary: fixture.projectionRead(fixture.iri('1a82'), fixture.subject.iri, [e1.iri, canon.iri]).summary },
  decorators: [Story => <div className="mx-auto max-w-64 p-2"><Story /></div>],
  async play() { await fits(); },
};
