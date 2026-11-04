import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { characterRelationshipsFixture } from '../kernel/fake/character-relationships';
import { personReaderExample } from '../features/catalogue/person-reader/examples';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages } from '../features/pages/route-support';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

/** Illustrative current page responses. The controller's seeded walkthrough owns the real-data proof. */
function Example({ person = false }: { person?: boolean }) {
  const locale = getLocale();
  const page = useMemo<SubjectPageData>(() => {
    const character = characterRelationshipsFixture('appearances', locale);
    const biography = personReaderExample();
    const read = person ? biography.read : character.character;
    if (!person) {
      read.subject.labels.ja = '星を渡る旅人たちの物語に登場する、遠い街からの旅人';
      read.subject.labels['zh-Hant'] = '跨越星空的旅人';
      read.subject.aliases.ja = ['旅の人'];
      read.subject.statements['schema:height'] = [
        biography.statement('schema:height', { amount: '+170', unit: '1' }, 'quantity'),
      ];
    }
    const document: CompositionDocument = {
      root: { props: {} },
      content: [{ type: 'SubjectHeader', props: { id: 'header' } }],
    };
    const plan = planReads(platformRegistry, document, { subject: read.subject.id });
    return {
      subject: read.subject.id,
      profile: 'illustrative',
      template: { scope: 'generic', key: null },
      document,
      catalogue: {
        state: 'released',
        type: read.subject.type,
        definitions: person ? biography.release : character.release,
      },
      reads: Object.fromEntries(
        Object.keys(plan.reads).map((key) => [
          key,
          { status: 200, body: { ...read, ...(person ? { documents: biography.documents } : {}) } },
        ]),
      ),
    };
  }, [person, locale]);
  return (
    <PatternStory>
      <AppShell>
        <main className="mx-auto w-full min-w-0 max-w-5xl p-4 sm:p-6">
          <SubjectPage page={page} locale={locale} messages={subjectPageMessages(locale)} renderJsonLd={false} />
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Subjects/Character and person composition',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Character: Story = {};
export const Person: Story = { args: { person: true } };
