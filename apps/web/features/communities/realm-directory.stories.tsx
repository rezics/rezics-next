import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi, BFF_PREFIX } from '../api/browser.ts';
import { BrowseReadError, discoveryApi } from '../discover/api.ts';
import { browseHref } from '../discover/browse-state.ts';
import { browseMessages } from '../discover/browse-messages.ts';
import { browseCounts } from '../discover/count-messages.ts';
import { DiscoverView, type DiscoverPageProps } from '../discover/discover-view.tsx';
import { browseResourceHref } from '../discover/resource-card.tsx';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { closedDirectoryIdentity, directoryStoryInputs, type DirectoryStoryState } from './directory-story-inputs.ts';

/** Replay at the production Query reader/page boundary, with no second directory frame. */
function DirectoryStory({ persona, mode, locale }: { persona: AnswerPersona; mode: DirectoryStoryState; locale: UiLocale }) {
  const [results, setResults] = useState<DiscoverPageProps['results']>(null);
  const inputs = directoryStoryInputs(persona, mode);
  useEffect(() => {
    let current = true;
    setResults(null);
    const input = directoryStoryInputs(persona, mode);
    const transport = recordedFetch(input.record, persona, [{ label: 'directory',
      state: mode === 'loading' ? 'loading' : mode === 'error' || mode === 'moved' ? 'error' : mode === 'empty' ? 'empty' : 'populated',
    }], { pathPrefix: BFF_PREFIX });
    const api = discoveryApi(browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher: transport.fetcher }), locale);
    void api.resources(input.body).then(data => {
      if (current) setResults({ ok: true, data });
    }, (error: unknown) => {
      if (current) setResults({ ok: false, moved: error instanceof BrowseReadError && error.status === 409 });
    });
    return () => { current = false; transport.dispose(); };
  }, [persona, mode, locale]);
  return <>
    <DiscoverView state={inputs.state} locale={locale} topics={[]} sections={null} results={results}
      signedIn={persona !== 'visitor'} />
    {!results ? <p role="status" aria-busy="true" className="px-5">{browseMessages[locale].loading}</p> : null}
  </>;
}
const meta = {
  title: 'Communities/Realm directory', component: DirectoryStory,
  args: { persona: 'visitor', mode: 'populated', locale: 'en' },
  parameters: { route: { pathname: '/en/discover', search: '?tab=communities' }, constructedFromContract: true },
  globals: { viewport: { value: 'desktop' } },
  render: (args, { globals }) => <DirectoryStory {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof DirectoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

function directory(persona: AnswerPersona, mode: DirectoryStoryState = 'populated'): Story {
  const input = directoryStoryInputs(persona, mode);
  return { args: { persona, mode }, parameters: { missingRecordedStates: input.missingRecordedStates, requiredState: input.requiredState },
    async play({ canvasElement, globals }) {
      const locale = (globals.locale as UiLocale | undefined) ?? 'en';
      const canvas = within(canvasElement);
      const t = browseMessages[locale];
      const counts = materializeData(browseCounts[locale], { locale });
      await expect(canvas.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      if (mode === 'loading') await expect(canvas.getByText(t.loading)).toBeVisible();
      else if (mode === 'error' || mode === 'moved') {
        await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(mode === 'error' ? t.unavailable : t.changed);
      } else if (mode === 'empty') {
        await expect(canvas.findByText(t.empty)).resolves.toBeVisible();
        await expect(canvas.getByText(counts.results(0))).toBeVisible();
        await expect(canvas.queryByRole('link', { name: t.more })).toBeNull();
      } else {
        const item = input.page.items[0]!;
        await expect(canvas.findByRole('link', { name: new RegExp(item.name.value) })).resolves.toHaveAttribute('href', localizedPath(browseResourceHref(item), locale));
        await expect(canvas.getByText(input.page.count.kind === 'at-least'
          ? counts.atLeastResults(input.page.count.value) : counts.results(input.page.count.value))).toBeVisible();
        if (input.page.nextCursor) {
          await expect(canvas.getByRole('link', { name: t.more })).toHaveAttribute('href', localizedPath(browseHref({ ...input.state, cursor: input.page.nextCursor }), locale));
        } else await expect(canvas.queryByRole('link', { name: t.more })).toBeNull();
      }
      await expect(canvasElement.textContent).not.toContain(closedDirectoryIdentity);
      const closedHref = localizedPath(browseResourceHref({ kind: 'realm', id: closedDirectoryIdentity }), locale);
      await expect(canvasElement.querySelector(`a[href="${closedHref}"]`)).toBeNull();
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  };
}
export const Visitor: Story = directory('visitor');
export const Stranger: Story = directory('stranger');
export const Member: Story = directory('member');
export const Owner: Story = directory('owner');
export const Moderator: Story = directory('moderator');
export const Operator: Story = directory('operator');
export const Continuation: Story = directory('visitor', 'continuation');
export const Filtered: Story = directory('visitor', 'filtered');
export const Empty: Story = directory('visitor', 'empty');
export const Unavailable: Story = directory('visitor', 'error');
export const BasisChanged: Story = directory('owner', 'moved');
export const Loading: Story = directory('visitor', 'loading');
export const Phone: Story = { ...Visitor, globals: { viewport: { value: 'phone' } } };
export const PhoneEmpty: Story = { ...Empty, globals: { viewport: { value: 'phone' } } };
export const PhoneUnavailable: Story = { ...Unavailable, globals: { viewport: { value: 'phone' } } };
export const PhoneLoading: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };
export const PhoneContinuation: Story = { ...Continuation, globals: { viewport: { value: 'phone' } } };
export const Chinese: Story = { ...Visitor, globals: { locale: 'zh-Hans' } };
export const TraditionalChinese: Story = { ...Visitor, globals: { locale: 'zh-Hant' } };
export const Japanese: Story = { ...Visitor, globals: { locale: 'ja' } };
export const Korean: Story = { ...Visitor, globals: { locale: 'ko' } };
export const German: Story = { ...Visitor, globals: { locale: 'de' } };
export const French: Story = { ...Visitor, globals: { locale: 'fr' } };
export const Spanish: Story = { ...Visitor, globals: { locale: 'es' } };
