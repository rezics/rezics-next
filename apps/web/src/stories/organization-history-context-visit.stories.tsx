import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import type { OrganizationFact } from '../features/catalogue/organization-reader';
import { OrganizationOverview } from '../features/catalogue/organization-reader/overview';
import { subjectHref } from '../subject/subject-href';
import { peopleOrganizationId, peopleProfileFixture } from '../kernel/fake/catalogue-people-profile';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const context = '00000000-0000-4000-8000-00000000d801';
const realm = '00000000-0000-4000-8000-00000000d802';
const parent = '00000000-0000-4000-8000-00000000d803';

function ContextualOrganizationHistory() {
  const locale = getLocale();
  const current = useMemo(() => {
    const { release, organization } = peopleProfileFixture('ready', locale, 'organization');
    organization.subject.context = context;
    organization.subject.labels = {
      en: 'Paper Lantern International Film and Publishing Cooperative',
      'zh-Hant': '紙燈國際電影與出版合作社',
      ja: 'ペーパーランタン国際映画・出版協同組合',
    };
    organization.subject.resolution['schema:abstract'] = 'unresolved';
    organization.subject.descriptions = {
      en: 'A studio history with two dated statements about the same parent.',
      'zh-Hant': '同一上級組織有兩筆帶日期的工作室沿革。',
      ja: '同じ親組織について、日付の異なる二つの沿革があります。',
    };
    organization.related[parent] = {
      type: 'schema:Organization',
      labels: { en: 'North Lantern Group', 'zh-Hant': '北燈集團', ja: '北灯グループ' },
    };
    const fact = (id: string, year: string, revision: number): OrganizationFact => ({
      id,
      rank: 'normal',
      property: { id: 'wdt:P749', data_type: 'wikibase-item' },
      value: { type: 'value', content: parent },
      qualifiers: [
        {
          property: { id: 'schema:startDate', data_type: 'time' },
          value: {
            type: 'value',
            content: {
              time: `+${year}-00-00T00:00:00Z`,
              precision: 9,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            },
          },
        },
      ],
      references: [
        {
          hash: `history-${year}`,
          parts: [
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value', content: `https://example.org/history/${year}` },
            },
          ],
        },
      ],
      rezics: { release: organization.subject.release, revision },
    });
    organization.subject.statements['wdt:P749'] = [
      fact('00000000-0000-4000-8000-00000000d804', '1999', 1),
      fact('00000000-0000-4000-8000-00000000d805', '2021', 2),
    ];
    return { release, organization };
  }, [locale]);
  const currentHref = subjectHref({ id: peopleOrganizationId, label: 'Paper Lantern Studio' }, locale).href;

  return (
    <PatternStory visitor="Signed Out" path="/subjects/organization/history">
      <AppShell>
        <main className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
          <OrganizationOverview
            id={peopleOrganizationId}
            context={context}
            source={current}
            locale={locale}
            reader={null}
            realm={realm}
            public={current.organization}
            release={current.release}
            currentHref={currentHref}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Catalogue/Organization history Context visit',
  component: ContextualOrganizationHistory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ContextualOrganizationHistory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ContextualHistoryAndReturn: Story = {};
