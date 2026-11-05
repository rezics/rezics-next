import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { OrganizationOverview } from '../features/catalogue/organization-reader/overview';
import { peopleProfileFixture } from '../kernel/fake/catalogue-people-profile';
import { personReaderExample } from '../features/catalogue/person-reader/examples';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

/** Interactive admitted-response variations; no native capture or authority is manufactured. */
function ReturnStory({ state }: { state: 'changed' | 'retry' }) {
  const locale = getLocale();
  const [replacement, setReplacement] = useState(false);
  const fixture = useMemo(() => {
    const { release, organization: read } = peopleProfileFixture('ready', locale, 'organization');
    const example = personReaderExample();
    const fact = example.read.subject.statements['schema:abstract']![0]!;
    read.subject.statements['schema:abstract'] = replacement ? [] : [fact];
    const documents = structuredClone(example.documents) as Record<string, Record<string, unknown>>;
    documents[fact.id]!.subjectId = read.subject.id;
    return { release, read, documents };
  }, [locale, replacement]);
  const dependency = useMemo(() => {
    let first = true;
    return async () => {
      if (first) {
        first = false;
        throw new Error('Illustrative unavailable read');
      }
      return {
        ok: true as const,
        public: fixture.read,
        release: fixture.release,
        work: null,
        profiles: [],
        credits: [],
      };
    };
  }, [fixture]);
  const o = { locale: locale as never };
  return (
    <PatternStory visitor="Signed Out" path="/subjects/organization/history">
      <AppShell>
        <main className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
          {state === 'changed' && (
            <button
              type="button"
              className="min-h-11 min-w-11 underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => setReplacement((value) => !value)}
            >
              {m.organization_reader_refresh({}, o)}
            </button>
          )}
          <OrganizationOverview
            id={fixture.read.subject.id}
            context={fixture.read.subject.context}
            source={fixture}
            locale={locale}
            reader={null}
            documents={fixture.documents}
            read={dependency}
            {...(state === 'changed' ? { public: fixture.read, release: fixture.release } : {})}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Organization history return',
  component: ReturnStory,
  parameters: { layout: 'fullscreen' },
  args: { state: 'changed' },
} satisfies Meta<typeof ReturnStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChangedReadingRecovery: Story = {};
export const DependencyRetry: Story = { args: { state: 'retry' } };
