import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { PeopleNamesEntry } from '../features/catalogue/people-names/entry';
import { SubjectSourcesPage } from '../features/catalogue/subject-sources-page';
import { characterRelationshipsFixture } from '../kernel/fake/character-relationships';
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
  kind = 'Person',
}: {
  state?:
    | 'overflow'
    | 'fallback'
    | 'empty'
    | 'malformed'
    | 'oversized'
    | 'retired'
    | 'filtered'
    | 'changed'
    | 'evidence-unavailable'
    | 'unsupported-context';
  kind?: 'Person' | 'Character';
  advice?: NamesAdvice;
}) {
  const locale = getLocale();
  const { names, href, read } = useMemo(() => {
    const read = kind === 'Person' ? personReaderExample().read : characterRelationshipsFixture().character;
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
    if (state === 'unsupported-context') read.subject.context = '00000000-0000-4000-8000-000000000778';
    if (state === 'changed') {
      read.subject.labels = { en: 'Current supplied spelling', ja: '現在の表記' };
      read.subject.aliases = {};
    }
    if (state === 'empty') {
      read.subject.labels = {};
      read.subject.aliases = {};
    }
    if (state === 'fallback') read.subject.labels = { ar: 'المسافر — 旅人' };
    const names =
      state === 'malformed' || state === 'oversized' ? ({ state } as const) : peopleNames(read.subject, locale);
    return { names, read, href: subjectHref({ id: read.subject.id, label: '旅の人' }, locale).href };
  }, [state, locale, kind]);
  return (
    <PatternStory>
      <AppShell>
        <main className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
          <h1 className="text-2xl font-semibold" lang="ja" dir="auto">
            旅の人・Mél—旅人
          </h1>
          {state === 'evidence-unavailable' ? (
            <SubjectSourcesPage
              result={{ kind: 'unavailable' }}
              locale={locale}
              returnTo={`${href}?context=${read.subject.context}#supplied-names`}
            />
          ) : state === 'unsupported-context' ? (
            <PeopleNamesEntry reading={{ public: read, locale }} />
          ) : (
            <PeopleNamesView
              names={names}
              locale={locale}
              retired={state === 'retired'}
              advice={advice}
              captureSourcesVisit
              returnStatus={state === 'changed' ? 'changed' : state === 'filtered' ? 'restored' : 'none'}
              restored={
                state === 'filtered'
                  ? { query: 'Mél', page: 0, expanded: true, groups: [{ index: 0, page: 1, open: true }] }
                  : undefined
              }
              sourcesHref={`${href}/sources`}
              termsHref={`${href}/terms`}
            />
          )}
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
export const UnsupportedTerms: Story = { args: { state: 'unsupported-context' } };
export const Malformed: Story = { args: { state: 'malformed' } };
export const Character: Story = { args: { kind: 'Character' } };
export const FilteredReturn: Story = { args: { state: 'filtered' } };
export const ChangedCurrentSpelling: Story = { args: { state: 'changed' } };
export const UnavailableEvidence: Story = { args: { state: 'evidence-unavailable' } };
export const OversizedResponse: Story = { args: { state: 'oversized' } };
export const Retired: Story = { args: { state: 'retired' } };
