import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import discussion from '../../../../tests/qa/fixtures/outcomes/zone/attached-realm-discussion.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { aboutDiscussionMessages } from './about-discussion-messages.ts';
import { readAboutDiscussion, type AboutDiscussionRead } from './about-discussion-api.ts';
import { ZoneDiscussionRecordedPage } from './zone-discussion-recorded-page.tsx';

const record = discussion as AnswerRecord;
const persona = 'stranger';
const locale: UiLocale = 'en';
const heldRequest = 'current-discussion-route';

function sample(label: string) {
  const found = record.personas[persona].find((answer) => answer.label === label);
  if (!found) throw new Error(`Missing recorded discussion answer: ${label}`);
  return found;
}

const space = new URL(sample('space-address').path, 'https://recorded.invalid').searchParams.get(
  'key',
);
if (!space) throw new Error('Recorded space key missing');
const href = spaceHref(space, 'site', ['public']);
const copy = aboutDiscussionMessages[locale];

function RecordedZoneDiscussion({ hold, locale = 'en' }: { hold: string | null; locale?: UiLocale }) {
  const [frame, setFrame] = useState<{
    zoneName: string;
    zoneLanguage: string;
    zoneDirection: 'ltr' | 'rtl';
    realmName: string;
    realmLanguage: string;
    realmDirection: 'ltr' | 'rtl';
  } | null>(null);
  const [read, setRead] = useState<AboutDiscussionRead | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(
      record,
      persona,
      [
        { label: 'published-presentation', state: 'populated' },
        { label: 'realm-policy', state: 'populated' },
        ...['current-discussion-route', 'current-discussion-target', 'canonical-about-thread', 'joining-context', 'canonical-discussion-thread']
          .map(label => ({ label, state: label === hold ? 'loading' as const : sample(label).status >= 400 ? 'error' as const : 'populated' as const })),
      ],
      { pathPrefix: BFF_PREFIX, locale },
    );
    const main = browserMainApi('https://recorded.invalid', {
      anonymous: true,
      fetcher: replay.fetcher,
    });
    const presentationUrl = new URL(
      sample('published-presentation').path,
      'https://recorded.invalid',
    );
    const realmUrl = new URL(sample('realm-policy').path, 'https://recorded.invalid');
    const routeUrl = new URL(sample(heldRequest).path, 'https://recorded.invalid');
    const actor = routeUrl.searchParams.get('actingSubject');
    async function load() {
      const [presentation, header] = await Promise.all([
        main.v1.zones({ id: presentationUrl.pathname.split('/')[3]! }).presentation.get({
          query: { actingSubject: presentationUrl.searchParams.get('actingSubject')! },
        }),
        main.v1.realms({ realm: realmUrl.pathname.split('/')[3]! }).get({
          query: { actingSubject: realmUrl.searchParams.get('actingSubject')! },
        }),
      ]);
      if (
        presentation.error ||
        !presentation.data ||
        typeof presentation.data.name !== 'string' ||
        header.error ||
        !header.data?.name
      )
        throw new Error('Recorded discussion frame failed');
      if (presentation.data.direction !== 'ltr' && presentation.data.direction !== 'rtl') {
        throw new Error('Recorded zone direction is not a writing direction');
      }
      if (!actor || !routeUrl.searchParams.get('path'))
        throw new Error('Recorded discussion route is incomplete');
      if (active)
        setFrame({
          zoneName: presentation.data.name,
          zoneLanguage: presentation.data.language,
          zoneDirection: presentation.data.direction,
          realmName: header.data.name.value,
          realmLanguage: header.data.name.language,
          realmDirection: header.data.name.direction,
        });
      const result = await readAboutDiscussion(main, {
        zone: routeUrl.pathname.split('/')[3]!,
        path: routeUrl.searchParams.get('path')!,
        signedIn: true,
        actingSubject: actor,
        personal: true,
      });
      if (active) setRead(result);
    }
    void load().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => {
      active = false;
      replay.dispose();
    };
  }, [hold, locale]);
  if (error) throw error;
  const loading = (
    <p role="status" aria-busy="true">
      {locale === 'ja' ? shellJa.loading : shellMessages.loading}
    </p>
  );
  if (!frame) return <PageContainer>{loading}</PageContainer>;
  return (
    <PageContainer>
      <PageHeader
        title={
          <span lang={frame.zoneLanguage} dir={frame.zoneDirection}>
            {frame.zoneName}
          </span>
        }
        description={
          <span lang={frame.realmLanguage} dir={frame.realmDirection}>
            {frame.realmName}
          </span>
        }
      />
      <ZoneDiscussionRecordedPage read={read} locale={locale} href={href} />
    </PageContainer>
  );
}

const meta = {
  title: 'Zones/Attached Realm discussion',
  component: RecordedZoneDiscussion,
  render: (args, { globals }) => <RecordedZoneDiscussion {...args} locale={globals.locale as UiLocale} />,
  args: { hold: heldRequest },
  parameters: { route: { pathname: localizedPath(href, locale) } },
  globals: { locale },
} satisfies Meta<typeof RecordedZoneDiscussion>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectHeldDiscussion(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const presentation = sample('published-presentation').answer as { name: string };
  const realm = sample('realm-policy').answer as { name: { value: string } };
  const work = sample('mounted-work-header').answer as { title: { value: string } };
  const text = sample('mounted-work-text').answer as { body: string };
  await expect(await canvas.findByRole('heading', { name: presentation.name })).toBeVisible();
  await expect(canvas.getByText(realm.name.value)).toBeVisible();
  const status = canvas.getByRole('status');
  await expect(status).toHaveTextContent(shellMessages.loading);
  await expect(status).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading', { name: copy.title })).toBeNull();
  await expect(canvas.queryByText(work.title.value)).toBeNull();
  await expect(canvas.queryByText(text.body)).toBeNull();
  await expect(canvas.queryByText(copy.empty)).toBeNull();
  await expect(canvas.queryByText(copy.unavailable)).toBeNull();
  await expect(canvas.queryByRole('article')).toBeNull();
}

export const LoadingStrangerPhone: Story = {
  globals: { viewport: { value: 'phone' }, locale },
  play: ({ canvasElement }) => expectHeldDiscussion(canvasElement),
};

export const LoadingStrangerDesktop: Story = {
  globals: { viewport: { value: 'desktop' }, locale },
  play: ({ canvasElement }) => expectHeldDiscussion(canvasElement),
};

export const PopulatedStrangerDesktop: Story = { args: { hold: null } };
