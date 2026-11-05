import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { GameProfile } from '../features/catalogue/game-profile-view';
import { candidateContext } from '../subject/candidates';
import { gameId, gameProfileFixture } from '../kernel/fake/catalogue-game-profile';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const concept = '00000000-0000-4000-8000-00000000f105';
const inspected = '00000000-0000-4000-8000-00000000f111';
const other = '00000000-0000-4000-8000-00000000f112';

function CurrentGameVisit() {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = gameProfileFixture('ready', locale, true);
    value.publicRead.related[concept] = { type: 'skos:Concept', labels: { en: 'Adventure' } };
    const assertion = (id: string, citation: string) => ({
      id,
      property: { id: 'schema:genre', data_type: 'wikibase-item' },
      value: { type: 'value', content: concept },
      rank: 'normal',
      qualifiers: [],
      references: [
        {
          hash: citation,
          parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: citation } }],
        },
      ],
      rezics: { release: value.publicRead.subject.release, revision: value.publicRead.subject.revision },
    });
    value.publicRead.subject.statements['schema:genre'] = [
      assertion(other, 'https://example.test/first-genre-source'),
      assertion(inspected, 'https://example.test/selected-genre-source'),
    ];
    return value;
  }, [locale]);
  const visit = {
    context: candidateContext,
    source: `/en/subjects/${gameId}/the-lantern-game`,
    type: 'schema:VideoGame',
    release: fixture.publicRead.subject.release,
    reader: null,
    selection: { holder: gameId, property: 'schema:genre', statement: inspected },
  };
  return (
    <PatternStory path={`/subjects/${gameId}/the-lantern-game/game`} visitor="Signed Out">
      <AppShell>
        <GameProfile
          id={gameId}
          locale={locale}
          reader={null}
          visit={visit}
          session="signed-out"
          transport={fixture.transport}
          search={async () => []}
          onNavigate={() => {}}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Game current assertion visit',
  component: CurrentGameVisit,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The correction visit opens one exact current classification occurrence, showing its native value, rank, qualifiers and grouped source evidence with a return to the original public reading.',
      },
    },
  },
} satisfies Meta<typeof CurrentGameVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedCurrentEvidence: Story = {};
