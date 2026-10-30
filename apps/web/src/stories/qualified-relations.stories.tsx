import type { Meta, StoryObj } from '@storybook/react-vite';
import { SubjectPage } from '../features/pages/subject';
import { subjectPageMessages } from '../features/pages/route-support';
import { qualifiedRelationsPage, qualifiedRealm } from '../kernel/fake/qualified-relations';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
const meta = { title: 'Pages/Subjects/Qualified Relations', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function QualifiedRelationsReader({ error = false }: { error?: boolean }) {
  const page = qualifiedRelationsPage(
    error ? { realm: qualifiedRealm, continuation: { node: 'cast', cursor: 'refuse' }, error: 409 } : {},
  );
  return (
    <PatternStory>
      <AppShell>
        <SubjectPage page={page} locale={getLocale()} messages={subjectPageMessages()} renderJsonLd={false} />
      </AppShell>
    </PatternStory>
  );
}
export const Reader: Story = { render: () => <QualifiedRelationsReader /> };
export const ContextConflict: Story = { render: () => <QualifiedRelationsReader error /> };
