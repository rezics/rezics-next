import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import anime from '../../../../tests/qa/fixtures/outcomes/anime/catalogue-browse-and-search-in-its-zone.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { messages as relationshipMessages } from '../relationships/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { AnimeBrowseRecordedPage } from './anime-browse-recorded-page.tsx';
import { animeBrowseSample, animeBrowseSiteKey } from './anime-browse-recorded-page.ts';
import { zoneMessagesFor } from './fixtures.ts';

const record = anime as AnswerRecord;
const meta = {
  title: 'Zones/Recorded Anime browse', component: AnimeBrowseRecordedPage,
  args: { persona: 'visitor', label: 'page-browse-default', state: 'populated', locale: 'en' },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
  parameters: { route: { pathname: localizedPath(spaceHref(animeBrowseSiteKey(record), 'site', ['browse']), 'en') } },
} satisfies Meta<typeof AnimeBrowseRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const verify: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const persona = args.persona ?? 'visitor', label = args.label ?? 'page-browse-default';
  const locale = args.locale ?? 'en', messages = zoneMessagesFor(locale);
  const page = animeBrowseSample(record, persona, label).answer as ZoneBrowsePage;
  if (args.state === 'loading') {
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
    await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.queryByRole('link', { name: page.items[0]!.title.value })).toBeNull();
    return;
  }
  const header = animeBrowseSample(record, persona, 'frame-realm-header').answer as { name: { value: string } };
  await expect(canvas.findByRole('heading', { level: 1, name: header.name.value })).resolves.toBeVisible();
  if (page.items.length) {
    await expect(canvas.findByRole('link', { name: page.items[0]!.title.value })).resolves.toBeVisible();
    await expect(canvas.getByRole('link', { name: page.items.at(-1)!.title.value })).toBeVisible();
    const credit = page.items[0]!.primaryCredits.find(item => item.displayName)?.displayName;
    if (!credit) throw new Error('The recorded Anime catalogue has no original author credit');
    await expect(canvas.getAllByText(credit).some(element => element.closest('p.truncate'))).toBe(true);
  } else {
    await expect(canvas.findByRole('heading', { name: messages.browseEmptyTitle })).resolves.toBeVisible();
    await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
  }
  const t = materializeData(messages, { locale });
  await expect(canvas.getByRole('status')).toHaveTextContent(page.matches.kind === 'exact'
    ? t.results(page.matches.value) : t.resultsAtLeast({ count: String(page.matches.value) }));
  await expect(canvas.getByRole('searchbox')).toHaveValue(page.query.text ?? '');
  const next = canvas.queryByRole('link', { name: messages.next });
  if (page.nextCursor) {
    await expect(next).toBeVisible();
    await expect(new URL(next!.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor')).toBe(page.nextCursor);
  } else await expect(next).toBeNull();
  if (label === 'page-combined') {
    await expect(canvasElement.querySelector('input[type="hidden"][name="year"]')).toHaveValue('2004');
    const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
    await expect(sorts.getByRole('link', { name: messages.sortUpdated })).toHaveAttribute('aria-current', 'true');
  }
  // Give the header's relationship hydration time to settle; the replay also fails every missing request.
  let relationshipFailed = false;
  try {
    await canvas.findByText(relationshipMessages[locale].unavailable, {}, { timeout: 400 });
    relationshipFailed = true;
  } catch { /* The settled relationship control stayed available. */ }
  await expect(relationshipFailed).toBe(false);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

function story(persona: NonNullable<Story['args']>['persona'], viewport: 'phone' | 'desktop',
  label = 'page-browse-default', state: 'populated' | 'empty' | 'loading' = 'populated'): Story {
  return { args: { persona, label, state }, globals: { viewport: { value: viewport } }, play: verify };
}

export const VisitorPhone = story('visitor', 'phone');
export const VisitorDesktop = story('visitor', 'desktop');
export const StrangerPhone = story('stranger', 'phone');
export const StrangerDesktop = story('stranger', 'desktop');
export const MemberPhone = story('member', 'phone');
export const MemberDesktop = story('member', 'desktop');
export const OwnerPhone = story('owner', 'phone');
export const OwnerDesktop = story('owner', 'desktop');
export const ModeratorPhone = story('moderator', 'phone');
export const ModeratorDesktop = story('moderator', 'desktop');
export const OperatorPhone = story('operator', 'phone');
export const OperatorDesktop = story('operator', 'desktop');
export const SearchPhone = story('visitor', 'phone', 'page-search-default');
export const SearchDesktop = story('visitor', 'desktop', 'page-search-default');
export const ContinuationPhone = story('visitor', 'phone', 'page-search-default-continuation-1');
export const ContinuationDesktop = story('visitor', 'desktop', 'page-search-default-continuation-1');
export const CombinedPhone = story('owner', 'phone', 'page-combined');
export const CombinedDesktop = story('owner', 'desktop', 'page-combined');
export const EmptyPhone = story('visitor', 'phone', 'page-search-no-match', 'empty');
export const EmptyDesktop = story('visitor', 'desktop', 'page-search-no-match', 'empty');
export const LoadingPhone = story('visitor', 'phone', 'page-browse-default', 'loading');
export const LoadingDesktop = story('visitor', 'desktop', 'page-browse-default', 'loading');
export const JapanesePhone: Story = {
  ...story('visitor', 'phone', 'page-search-default'), args: { persona: 'visitor', label: 'page-search-default',
    state: 'populated', locale: 'ja' }, globals: { locale: 'ja', viewport: { value: 'phone' } },
};
