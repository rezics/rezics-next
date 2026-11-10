import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { AddonProfile } from '../features/catalogue/addon-profile-view';
import type { AddonPublicOrigin, AddonPublicVisit } from '../features/catalogue/addon-public-visit';
import { addonProfileFixture, addonProfileId, addonWorkId } from '../kernel/fake/catalogue-addon-profile';
import { subjectHref } from '../subject/subject-href';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function Example({
  state = 'observed-global',
}: {
  state?: 'observed-global' | 'selected-context' | 'changed-definition' | 'fresh-global' | 'invalid';
}) {
  const locale = getLocale();
  const fixture = useMemo(() => addonProfileFixture('ready', locale), [locale]);
  const origin: AddonPublicOrigin = {
    subject: addonProfileId,
    type: 'wd:Q209163',
    context: state === 'selected-context' ? addonWorkId : fixture.current.subject.context,
    definition: state === 'changed-definition' ? 'sha256:' + '0'.repeat(64) : fixture.current.subject.release,
    returnHref: subjectHref({ id: addonProfileId, label: 'Northern lights' }, locale).href,
  };
  const visit: AddonPublicVisit =
    state === 'invalid'
      ? { kind: 'invalid' }
      : state === 'fresh-global'
        ? { kind: 'global', returnHref: origin.returnHref }
        : { kind: 'origin', origin };
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <AddonProfile {...fixture.props} id={addonProfileId} locale={locale} visit={visit} />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Catalogue/Add-on public correction origin',
  id: 'pages-catalogue-add-on-public-correction-origin',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Current Addon native-shaped fixture through the existing profile. Review the five outer admission/return states in all eight locale globals, light/dark themes, phone390 and desktop1440. Native and browser execution belongs to integration.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ObservedGlobal: Story = {};
export const UnsupportedSelectedContext: Story = { args: { state: 'selected-context' } };
export const ChangedDefinition: Story = { args: { state: 'changed-definition' } };
export const DeliberateFreshGlobal: Story = { args: { state: 'fresh-global' } };
export const InvalidOrigin: Story = { args: { state: 'invalid' } };
