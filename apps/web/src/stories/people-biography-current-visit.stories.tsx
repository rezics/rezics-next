import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { PeopleProfileEditor } from '../features/catalogue/people-profile-view';
import { peopleProfileFixture } from '../kernel/fake/catalogue-people-profile';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const longName = `Mira 佐藤 미라 佐藤米拉 ${'LongPersonName'.repeat(12)}`;

function CurrentVisit({ concealed = false, long = false }: { concealed?: boolean; long?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = peopleProfileFixture('ready', locale, 'person');
    const person = fixture.person;
    if (long) person.subject.labels = { 'zh-Hant': longName, ja: longName, en: longName };
    const abstract = '00000000-0000-4000-8000-00000000d211';
    const occupation = '00000000-0000-4000-8000-00000000d221';
    const language = '00000000-0000-4000-8000-00000000d231';
    const organization = '00000000-0000-4000-8000-00000000d102';
    person.subject.statements['schema:abstract'] = [
      {
        id: abstract,
        rank: 'normal',
        property: { id: 'schema:abstract', data_type: 'document' },
        value: { type: 'value', content: { language: 'zh-Hant', document: { id: 'person-biography' } } },
        qualifiers: [],
        references: [],
        rezics: { release: 'sha256:story', revision: 1 },
      },
    ];
    person.subject.statements['wdt:P106'] = [
      {
        id: occupation,
        rank: 'normal',
        property: { id: 'wdt:P106', data_type: 'wikibase-item' },
        value: { type: 'value', content: '00000000-0000-4000-8000-00000000d201' },
        qualifiers: [],
        references: [],
        rezics: { release: 'sha256:story', revision: 1 },
      },
    ];
    person.subject.statements['schema:knowsLanguage'] = [
      {
        id: language,
        rank: 'normal',
        property: { id: 'schema:knowsLanguage', data_type: 'wikibase-item' },
        value: { type: 'value', content: '00000000-0000-4000-8000-00000000d202' },
        qualifiers: [],
        references: [],
        rezics: { release: 'sha256:story', revision: 1 },
      },
    ];
    const affiliation = fixture.release.types['schema:Person']?.properties.find((id) => {
      const property = fixture.release.properties[id];
      return property?.datatype === 'wikibase-item' && property.targets?.includes('schema:Organization');
    });
    if (affiliation)
      person.subject.statements[affiliation] = [
        {
          id: '00000000-0000-4000-8000-00000000d241',
          rank: 'normal',
          property: { id: affiliation, data_type: 'wikibase-item' },
          value: { type: 'value', content: organization },
          qualifiers: [],
          references: [],
          rezics: { release: 'sha256:story', revision: 1 },
        },
      ];
    person.related = {
      '00000000-0000-4000-8000-00000000d201': { type: 'skos:Concept', labels: { en: 'Director', ja: '監督', 'zh-Hant': '導演' } },
      '00000000-0000-4000-8000-00000000d202': { type: 'schema:Language', labels: { en: 'Japanese', ja: '日本語', 'zh-Hant': '日語' } },
      ...(concealed ? {} : { [organization]: { type: 'schema:Organization', labels: { en: 'Paper Lantern Studio' } } }),
    };
    return fixture;
  }, [concealed, locale, long]);
  return (
    <PatternStory visitor="Signed In" path="/subjects/person/mira/people">
      <AppShell>
        <PeopleProfileEditor
          id={fixture.id}
          locale={locale}
          session="signed-in"
          transport={fixture.transport}
          propose={fixture.propose}
          review={fixture.review}
          search={async () => []}
          onNavigate={() => {}}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Person biography current visit',
  component: CurrentVisit,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' } },
      },
    },
    docs: {
      description: {
        component:
          'Fixture-backed Person correction visit with biography, occupation, language and admitted affiliation assertions. Evidence and target labels stay within the current disclosed Subject projection; the story is not native or browser acceptance.',
      },
    },
  },
} satisfies Meta<typeof CurrentVisit>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Person: Story = {};
export const LongNames: Story = { args: { long: true } };
export const UnavailableAffiliationTarget: Story = { args: { concealed: true } };
