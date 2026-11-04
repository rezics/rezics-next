import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { PeopleNamesView } from '../features/catalogue/people-names/view';
import { peopleNames, type NamesAdvice } from '../features/catalogue/people-names/model';
import { personReaderExample } from '../features/catalogue/person-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

/** Illustrative admitted data; these stories do not claim native or visual acceptance. */
function Example({
  state = 'overflow',
  advice = 'signed-out',
}: {
  state?: 'overflow' | 'fallback' | 'empty' | 'malformed' | 'oversized' | 'retired';
  advice?: NamesAdvice;
}) {
  const locale = getLocale();
  const { names, href } = useMemo(() => {
    const { read } = personReaderExample();
    read.subject.labels = { ja: '旅の人・Mél—旅人', 'zh-Hant': '旅人', ar: 'المسافر — 旅人', he: 'הנוסע' };
    read.subject.aliases = {
      ja: Array.from({ length: 80 }, (_, index) => `旅の人 ${index} — Mél / מֵירָה`),
      ar: ['المسافر'.repeat(30)],
      'zh-Hant': ['旅人・旅の人'],
      fr: ['Mél', 'Mel'],
    };
    if (state === 'overflow') {
      for (const language of ['en', 'de', 'es', 'ko', 'it', 'pt', 'ru', 'uk', 'nl', 'sv', 'da', 'fi', 'pl', 'cs', 'tr'])
        read.subject.aliases[language] = [`旅の人 / ${language}`];
    }
    if (state === 'empty') {
      read.subject.labels = {};
      read.subject.aliases = {};
    }
    const names =
      state === 'malformed' || state === 'oversized' ? ({ state } as const) : peopleNames(read.subject, locale);
    return { names, href: subjectHref({ id: read.subject.id, label: '旅の人' }, locale).href };
  }, [state, locale]);
  return (
    <PatternStory>
      <AppShell>
        <main className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
          <h1 className="text-2xl font-semibold" lang="ja" dir="auto">
            旅の人・Mél—旅人
          </h1>
          <PeopleNamesView
            names={names}
            locale={locale}
            retired={state === 'retired'}
            advice={advice}
            sourcesHref={`${href}/sources`}
            termsHref={`${href}/terms`}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Supplied people names',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedOutOverflow: Story = {};
export const Fallback: Story = { args: { state: 'fallback' } };
export const AdviceUnavailable: Story = { args: { advice: 'unavailable' } };
export const AdviceDenied: Story = { args: { advice: 'denied' } };
export const Empty: Story = { args: { state: 'empty' } };
export const UnsupportedTerms: Story = { args: { state: 'malformed' } };
export const OversizedResponse: Story = { args: { state: 'oversized' } };
export const Retired: Story = { args: { state: 'retired' } };
