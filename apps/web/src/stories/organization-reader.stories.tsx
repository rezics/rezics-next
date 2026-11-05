import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { fromPlainText } from '@rezics/document';
import { OrganizationOverview } from '../features/catalogue/organization-reader/overview';
import type { OrganizationCurrent, OrganizationFact } from '../features/catalogue/organization-reader';
import { peopleProfileFixture } from '../kernel/fake/catalogue-people-profile';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function ReaderStory({ state }: { state: 'unconfigured' | 'history' | 'withheld' | 'bounded' }) {
  const locale = getLocale();
  const read = useMemo((): OrganizationCurrent => {
    const fixture = peopleProfileFixture('ready', locale, 'organization');
    const { release, organization: current } = fixture;
    current.subject.descriptions = { en: 'An independent animation studio.', ja: '独立系アニメーション制作会社。' };
    // Illustrative admitted-release variation, not a claim of native configuration or a rendered pass.
    if (state === 'unconfigured') {
      delete release.properties['wdt:P749'];
      delete release.properties['wdt:P1365'];
      delete release.properties['wdt:P1366'];
      const type = release.types['schema:Organization'];
      if (type)
        type.properties = type.properties.filter(
          (id) => id !== 'schema:abstract' && id !== 'wdt:P749' && id !== 'wdt:P1365' && id !== 'wdt:P1366',
        );
    } else {
      const target = '00000000-0000-4000-8000-00000000d311';
      if (state !== 'withheld')
        current.related[target] = {
          type: 'schema:Organization',
          labels: { en: 'Original Lantern Studio', ja: '旧ランタンスタジオ' },
        };
      const fact: OrganizationFact = {
        id: '00000000-0000-4000-8000-00000000d312',
        rank: 'normal',
        property: { id: 'wdt:P1365', data_type: 'wikibase-item' },
        value: { type: 'value', content: target },
        qualifiers: [
          {
            property: { id: 'schema:startDate', data_type: 'time' },
            value: {
              type: 'value',
              content: {
                time: '+1999-00-00T00:00:00Z',
                precision: 9,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              },
            },
          },
        ],
        references: [
          {
            hash: 'studio-source',
            parts: [
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: 'https://example.org/studio-history' },
              },
            ],
          },
        ],
        rezics: { release: current.subject.release, revision: 1 },
      };
      if (state === 'bounded') fact.qualifiers = Array.from({ length: 33 }, () => fact.qualifiers[0]!);
      current.subject.statements['wdt:P1365'] = [fact];
    }
    return { ok: true, public: current, release, work: null, profiles: [], credits: [] };
  }, [locale, state]);
  const documents = useMemo(() => {
    if (state === 'unconfigured') return {};
    const id = '00000000-0000-4000-8000-00000000d313';
    const document = '00000000-0000-4000-8000-00000000d314';
    const digest = 'a'.repeat(64);
    read.public.subject.statements['schema:abstract'] = [
      {
        id,
        rank: 'normal',
        property: { id: 'schema:abstract', data_type: 'document' },
        value: { type: 'value', content: { document, digest, language: 'en' } },
        qualifiers: [],
        references: [
          {
            hash: 'history-document-source',
            parts: [
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: {
                  type: 'value',
                  content:
                    'https://example.org/studio-history/independent-production-and-the-original-archive-catalogue',
                },
              },
            ],
          },
        ],
        rezics: { release: read.public.subject.release, revision: 3 },
      },
    ];
    return state === 'withheld'
      ? {}
      : {
          [id]: {
            id: document,
            subjectId: read.public.subject.id,
            candidateId: id,
            digest,
            language: 'en',
            availability: 'available',
            body: fromPlainText(
              'Lantern Studio began as an independent animation workshop. The archive credits its early films to the original studio name. The directed predecessor assertion below retains the original source and its stated year; it does not establish a merger or a subsidiary relationship.',
            ),
          },
        };
  }, [read, state]);
  return (
    <PatternStory visitor="Signed Out" path="/subjects/organization/history">
      <AppShell>
        <main className="mx-auto w-full max-w-4xl p-4 sm:p-6">
          <OrganizationOverview
            id={read.public.subject.id}
            context={read.public.subject.context}
            source={read}
            public={read.public}
            release={read.release}
            documents={documents}
            locale={locale}
            reader={null}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Catalogue/Organization reader',
  component: ReaderStory,
  parameters: { layout: 'fullscreen' },
  args: { state: 'history' },
} satisfies Meta<typeof ReaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DirectedHistory: Story = {};
export const UnsupportedConfiguration: Story = { args: { state: 'unconfigured' } };
export const WithheldDestination: Story = { args: { state: 'withheld' } };

export const AuthorizedHistoricalContent: Story = {};
export const BoundedEvidence: Story = { args: { state: 'bounded' } };
