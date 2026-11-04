import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { OrganizationReader } from '../features/catalogue/organization-reader/view';
import type { OrganizationCurrent, OrganizationFact } from '../features/catalogue/organization-reader';
import { peopleProfileFixture } from '../kernel/fake/catalogue-people-profile';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function ReaderStory({ state }: { state: 'unconfigured' | 'history' | 'withheld' }) {
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
          (id) =>
            id !== 'schema:abstract' && id !== 'wdt:P749' && id !== 'wdt:P1365' && id !== 'wdt:P1366',
        );
    } else {
      const target = '00000000-0000-4000-8000-00000000d311';
      if (state === 'history')
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
      current.subject.statements['wdt:P1365'] = [fact];
    }
    return { ok: true, public: current, release, work: null, profiles: [], credits: [] };
  }, [locale, state]);
  return (
    <PatternStory visitor="Signed Out" path="/subjects/organization/history">
      <AppShell>
        <OrganizationReader read={read} locale={locale} />
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
