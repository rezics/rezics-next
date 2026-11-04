import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Subject } from '../subject/types';
import { workNames } from '../features/catalogue/work-names/model';
import { WorkNamesView } from '../features/catalogue/work-names/view';
import { locales } from '../paraglide/runtime';
import { PatternStory } from './page';

type State = 'loading' | 'failure' | 'empty' | 'withheld' | 'unavailable' | 'unsupported';
/** Authored states for all launch locales; native and browser acceptance belong to integration. */
function Example({ state }: { state: State }) {
  const subject = {
    labels: { ja: '旅の物語'.repeat(40), 'zh-Hant': '旅人的故事'.repeat(40) },
    aliases: { ja: Array.from({ length: 30 }, (_, i) => `旅の物語・${i}`) },
    statements: {},
  } as unknown as Subject;
  if (state === 'empty') {
    subject.labels = {};
    subject.aliases = {};
  }
  return (
    <PatternStory>
      <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
        {locales.map((locale) => (
          <article key={locale} lang={locale} className="min-w-0 space-y-3 rounded-md border p-4">
            <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">旅の物語 / 旅人的故事 · {locale}</h1>
            {state !== 'unsupported' && (
              <WorkNamesView
                locale={locale}
                names={state === 'unavailable' ? { state: 'unavailable', bytes: 383_000 } : workNames(subject, locale)}
                retired={state === 'withheld'}
                advice={state === 'loading' ? 'pending' : 'unavailable'}
                retryAdvice={state === 'failure' ? () => {} : undefined}
                sourcesHref={`/${locale}/subjects/0192f3a0-6c1e-7b2a-9d4e-000000000910/title/sources`}
                termsHref={`/${locale}/subjects/0192f3a0-6c1e-7b2a-9d4e-000000000910/title/terms`}
              />
            )}
          </article>
        ))}
      </main>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Subjects/Work title return states',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = { args: { state: 'loading' } };
export const Failure: Story = { args: { state: 'failure' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Withheld: Story = { args: { state: 'withheld' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Unsupported: Story = { args: { state: 'unsupported' } };
