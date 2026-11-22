import type { Meta, StoryObj } from '@storybook/react-vite';
import accounts from '../src/kernel/recorded/accounts.json';
import { albumId } from '../src/kernel/fake/catalogue-album-profile';
import { gameId } from '../src/kernel/fake/catalogue-game-profile';
import { prepareAlbumCorrection, prepareGameCorrection } from '../src/kernel/fake/catalogue-profile-review';
import { prepareMappedOffer, setReceiptMoneyStory } from '../src/kernel/fake/checkout';
import { deLocalizeUrl } from '../src/paraglide/runtime.js';
import { PageStory, pagePaths } from '../src/stories/page';

type RouteReviewArgs = { entry: string; visitor: 'Signed In' | 'Signed Out' };

function prepareReceiptHistory() {
  setReceiptMoneyStory(true);
  return () => setReceiptMoneyStory(false);
}

function fixtureFor(entry: string, visitor: RouteReviewArgs['visitor']) {
  const path = deLocalizeUrl(new URL(entry, 'http://rezics.local')).pathname;
  if (path === `/subjects/${albumId}/harbour-sessions/album`) return prepareAlbumCorrection;
  if (path === `/subjects/${gameId}/the-lantern-game/game`) return prepareGameCorrection;
  if (visitor === 'Signed In' && path === pagePaths['offer-cjk']) return prepareMappedOffer;
  if (visitor === 'Signed In' && (path === '/orders' || path.startsWith('/orders/'))) return prepareReceiptHistory;
}

const meta = {
  title: 'Site Shell/Navigation/Route Review',
  id: 'route-review',
  parameters: { layout: 'fullscreen' },
  args: { entry: '/', visitor: 'Signed In' },
  argTypes: { visitor: { control: 'radio', options: ['Signed In', 'Signed Out'] } },
  render({ entry, visitor }) {
    // A direct iframe link can carry a fixture URL, including nested filters and encoded cursors.
    const path = new URLSearchParams(window.location.search).get('entry') ?? entry;
    if (!path.startsWith('/') || /^[/][\\/]/.test(path)) {
      return <p role="alert">Enter a local application path beginning with a slash.</p>;
    }
    const prepareFixture = fixtureFor(path, visitor);
    return (
      <PageStory
        accountId={accounts.accounts[0]!.id}
        path={path}
        {...(prepareFixture && { prepareFixture })}
        visitor={visitor}
        credentialMode={visitor === 'Signed In' ? 'session' : 'anonymous'}
      />
    );
  },
} satisfies Meta<RouteReviewArgs>;

export default meta;
export const ApplicationRoute: StoryObj<typeof meta> = {};
