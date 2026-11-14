import { admittedReleaseSearchControls, admittedReleaseSearchTypes, type FilterRelease } from '@rezics/filter';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { m } from '../paraglide/messages.js';
import { parseReleaseSearch, releaseSearchHref, type ReleaseSearchType } from '../search/release-search';
import { ReleaseSearchFormView } from '../search/release-criteria-form';
import { PatternStory } from './page';

const locale = 'ja';
const releaseType = 'wd:Q20631656';
const platformId = '018f0000-0000-7000-8000-000000000002';

function releaseTypes(release: FilterRelease): ReleaseSearchType[] {
  return admittedReleaseSearchTypes(release).map((id) => {
    const controls = admittedReleaseSearchControls(release, id)!;
    return {
      id,
      label: id,
      controls: {
        platform: controls.platform,
        language: controls.language,
        date: controls.date,
        ageRating: controls.ageRating,
        producers: controls.producers,
      },
    };
  });
}

const types = releaseTypes(bundledRelease);
const parsed = parseReleaseSearch(
  {
    subtype: releaseType,
    q: '作品集',
    platform: platformId,
    language: ['ja'],
    gte: '2024-02',
    lte: '2024-03',
    sort: 'relevance',
  },
  bundledRelease,
  locale,
);
const selections = {
  platform: { id: platformId, label: 'Nintendo Switch', type: 'schema:GamePlatform' },
};

const meta = {
  title: 'Search/Release Criteria Input',
  id: 'patterns-search-release-criteria-input',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Decision: composition text stays pending until selection; explicit Apply submits, and correction keeps field focus.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const JapaneseReleaseCriteria: Story = {
  render: () => (
    <PatternStory path={releaseSearchHref(locale, parsed.form)}>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <h1 className="text-2xl font-semibold">{m.release_search_heading({}, { locale })}</h1>
        <p className="text-muted-foreground">{m.release_search_intro({}, { locale })}</p>
        <ReleaseSearchFormView parsed={parsed} types={types} locale={locale} selections={selections} />
      </main>
    </PatternStory>
  ),
};
