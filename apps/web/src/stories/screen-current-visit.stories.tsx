import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ScreenCurrentVisitRecovery } from '../features/catalogue/screen-profile-session';
import { ScreenProfileReader } from '../features/catalogue/screen-profile-reader';
import {
  screenCurrentInspectionId,
  screenCurrentReturnHref,
  screenCurrentSourceAddress,
  type ScreenCurrentVisit,
} from '../features/catalogue/screen-current-visit';
import { screenProfileFixture } from '../kernel/fake/catalogue-screen-profile';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';
import type { Release } from '@rezics/definitions';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';

type ScreenVisitStoryState =
  | 'selected-reading'
  | 'duplicate-evidence'
  | 'unsupported-context'
  | 'classification-handoff'
  | 'recorded-success-read-recovery'
  | 'cancelled-return-focus';

const subjectId = '00000000-0000-4000-8000-000000000901';
const realmId = '00000000-0000-4000-8000-000000000902';
const editorialContext = '00000000-0000-4000-8000-000000000903';

function ScreenCurrentVisitStory({ state = 'selected-reading' }: { state?: ScreenVisitStoryState }) {
  const locale = getLocale();
  const fixture = useMemo(() => screenProfileFixture('partial', locale, true), [locale]);
  const reading = fixture.facts.date.publicRead;
  const release = definitions.release as Release;
  const property = 'schema:datePublished';
  const statements = reading.subject.statements[property] ?? [];
  const selected = statements[0];
  const duplicateId = '00000000-0000-4000-8000-000000000904';
  if (state === 'duplicate-evidence' && selected && !statements.some((statement) => statement.id === duplicateId)) {
    reading.subject.statements[property] = [...statements, { ...structuredClone(selected), id: duplicateId }];
  }
  reading.subject.id = subjectId;
  reading.subject.context = state === 'unsupported-context' ? editorialContext : PAGE_GLOBAL_CONTEXT;
  const occurrence =
    state === 'duplicate-evidence' && selected
      ? { holder: subjectId, property, statement: duplicateId }
      : selected
        ? { holder: subjectId, property, statement: selected.id }
        : undefined;
  const visit: ScreenCurrentVisit = {
    version: 1,
    subject: subjectId,
    type: 'schema:Movie',
    context: reading.subject.context,
    realm: realmId,
    locale,
    definition: definitions.digest,
    source: `/${locale}/subjects/${subjectId}/the-observatory?realm=${realmId}`,
    ...(occurrence ? { occurrence } : {}),
  };
  const inspection = occurrence;
  const returnHref = screenCurrentReturnHref(visit);
  const sourceAddress = screenCurrentSourceAddress(
    `/${locale}/subjects/${subjectId}/the-observatory`,
    `?realm=${realmId}`,
    '',
    locale,
    subjectId,
  );
  const currentVisit = { ...visit, ...(sourceAddress ? { source: sourceAddress } : {}) };

  return (
    <PatternStory path={`/subjects/${subjectId}/the-observatory/screen`} visitor="Signed In">
      <AppShell>
        {state === 'recorded-success-read-recovery' ? (
          <ScreenCurrentVisitRecovery
            locale={locale}
            message="unavailable"
            globalHref={`/${locale}/subjects/${subjectId}/the-observatory/screen`}
          />
        ) : (
          <main className="mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-8 sm:px-6">
            {state === 'classification-handoff' ? (
              <p role="status">{m.classification_create_created_identity({ label: 'Night', type: 'Concept' })}</p>
            ) : null}
            {state === 'cancelled-return-focus' ? (
              <p className="text-sm text-muted-foreground">
                Pointer or keyboard interaction cancels the pending return focus.
              </p>
            ) : null}
            <ScreenProfileReader
              locale={locale}
              public={reading}
              release={release}
              currentVisit={currentVisit}
              {...(inspection ? { inspection } : {})}
              {...(state === 'unsupported-context'
                ? {
                    unsupportedCorrection: true,
                    globalHref: `/${locale}/subjects/${subjectId}/the-observatory/screen`,
                  }
                : {})}
              {...(returnHref ? { returnHref } : {})}
              visitIdentity={`screen-current-visit:${state}`}
              returnNotice={
                state === 'duplicate-evidence' &&
                !reading.subject.statements[property]?.some((item) => item.id === occurrence?.statement)
              }
            />
            {state === 'duplicate-evidence' && occurrence ? (
              <p id={screenCurrentInspectionId(occurrence.statement)} className="sr-only">
                {m.screen_visit_inspect()}
              </p>
            ) : null}
          </main>
        )}
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Screen correction visit',
  component: ScreenCurrentVisitStory,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Typed Screen visit states for the selected native reading, exact duplicate-value evidence, unsupported correction Context, classification handoff coexistence, recorded success followed by read recovery, and cancelled return focus. Use locale, viewport and theme globals.',
      },
    },
  },
} satisfies Meta<typeof ScreenCurrentVisitStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SelectedReading: Story = { args: { state: 'selected-reading' } };
export const DuplicateValueEvidence: Story = { args: { state: 'duplicate-evidence' } };
export const UnsupportedCorrectionContext: Story = { args: { state: 'unsupported-context' } };
export const ClassificationHandoffCoexistence: Story = { args: { state: 'classification-handoff' } };
export const RecordedSuccessReadRecovery: Story = { args: { state: 'recorded-success-read-recovery' } };
export const CancelledReturnFocus: Story = { args: { state: 'cancelled-return-focus' } };
