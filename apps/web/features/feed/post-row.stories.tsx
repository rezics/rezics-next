import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { resourceHref } from '../address/path.ts';
import { FeedProvider } from './feed-context.tsx';
import { memoryFeed, NOW, people, realms, storyId } from './fixtures.ts';
import { messages } from './messages.ts';
import { MetaLine, PostRow, useIdentity } from './post-row.tsx';

const communityName = 'A garden community with a long name that must keep its own keyboard and pointer target';
const title = 'The independent garden original';

function Metadata() {
  const realm = { ...realms.fiction, name: { ...realms.fiction.name, value: communityName } };
  const identity = useIdentity({ lead: 'realm', realm, people: [people.mei] });
  return <MetaLine icon={identity.icon} parts={identity.parts} />;
}

function KeyboardPost() {
  return <FeedProvider locale="en" messages={messages} now={NOW} signedIn actingSubject={people.mei.id}
    signInHref="/auth/start?next=%2Fen" avatarQuery="" tab="all" followedRealms={null} api={memoryFeed()}>
    <div className="mx-auto max-w-[46rem] py-6 sm:px-6">
      <PostRow kind="work" href={resourceHref('/w/', storyId(9193))} meta={<Metadata />} title={title}
        preview="The title opens this Work. The community and author above it keep their own destinations."
        vote={null} />
    </div>
  </FeedProvider>;
}

const meta = {
  title: 'Feed/Post row keyboard targets',
  component: KeyboardPost,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const community = await canvas.findByRole('link', { name: communityName });
    const original = canvas.getByRole('link', { name: title });
    // Truncation must preserve the metadata link's pointer target.
    const communityRect = community.getBoundingClientRect();
    await expect(communityRect.height).toBeGreaterThanOrEqual(24);
    await expect(communityRect.width).toBeGreaterThanOrEqual(24);
    for (const link of [community, original]) {
      for (let count = 0; document.activeElement !== link && count < 20; count++) await userEvent.tab();
      await expect(link).toHaveFocus();
      const rect = link.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      await expect(hit === link || (hit !== null && link.contains(hit))).toBe(true);
      const indicator = getComputedStyle(link, link === original ? '::after' : null);
      await expect(indicator.boxShadow).not.toBe('none');
    }
  },
} satisfies Meta<typeof KeyboardPost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop: Story = {};
export const Phone: Story = { globals: { viewport: { value: 'phone' } } };
