import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeWorkLibraryAction, HomeWorkLibraryProvider } from '../features/feed/home-work-library/view';
import type { HomeWorkLibraryProjection, HomeWorkLibraryScope } from '../features/feed/home-work-library/contract';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const scope: HomeWorkLibraryScope = {
  reader: 'prepared-reader',
  credentialEpoch: 'prepared-credential-epoch',
  source: 'home:discovery',
  observation: 'prepared-observation',
  locale: 'en',
  route: '/',
};

function preparedProjection(locale: string): HomeWorkLibraryProjection {
  const visitScope = { ...scope, locale };
  const ready = {
    state: 'ready' as const,
    rows: [
      {
        subjectId: '00000000-0000-7000-8000-000000000101',
        entry: {
          state: 'present' as const,
          value: { subjectId: '00000000-0000-7000-8000-000000000101', state: 'reading', revision: 1 },
        },
        score: { state: 'present' as const, value: { reader: scope.reader, kind: 'ready' as const, units: 16 } },
        entryControl: () => <span className="text-sm">{m.library_entry_state_label({ title: 'Prepared work', state: m.library_other() })}</span>,
        scoreControl: () => <span className="text-sm">8 / 10</span>,
      },
      {
        subjectId: '00000000-0000-7000-8000-000000000102',
        entry: { state: 'absent' as const },
        score: { state: 'absent' as const },
        entryControl: () => <span className="text-sm">{m.library_empty_title()}</span>,
        scoreControl: () => <span className="text-sm">{m.subject_rating_control_unrated()}</span>,
      },
      {
        subjectId: '00000000-0000-7000-8000-000000000103',
        entry: { state: 'unavailable' as const },
        score: { state: 'unavailable' as const },
      },
    ],
  };
  return {
    scope: visitScope,
    pages: [ready],
    lease: { subscribe: () => () => {}, snapshot: () => 0, isCurrent: () => true },
  };
}

function PreparedHomeWorkLibrary() {
  const locale = getLocale();
  const projection = preparedProjection(locale);
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <p role="note" className="text-sm text-muted-foreground">
        Prepared projection states only. These labels do not issue Library or rating commands and do not prove native delivery.
      </p>
      <HomeWorkLibraryProvider expectedScope={{ ...scope, locale }} signedIn enabled projection={projection}>
        <section aria-label="Repeated reference to a saved work" className="space-y-2 rounded-lg border p-4">
          <h2 className="font-semibold">Prepared work — repeated reference</h2>
          <HomeWorkLibraryAction
            subjectId="00000000-0000-7000-8000-000000000101"
            href={`/${locale}/subjects/00000000-0000-7000-8000-000000000101/Prepared?slot=collections`}
            locale={locale}
          />
          <HomeWorkLibraryAction
            subjectId="00000000-0000-7000-8000-000000000101"
            href={`/${locale}/subjects/00000000-0000-7000-8000-000000000101/Prepared?slot=collections`}
            locale={locale}
          />
        </section>
        <section aria-label="Work with no Library entry" className="space-y-2 rounded-lg border p-4">
          <h2 className="font-semibold">Prepared work — no Entry</h2>
          <HomeWorkLibraryAction
            subjectId="00000000-0000-7000-8000-000000000102"
            href={`/${locale}/subjects/00000000-0000-7000-8000-000000000102/Prepared?slot=collections`}
            locale={locale}
          />
        </section>
        <section aria-label="Work with unavailable private state" className="space-y-2 rounded-lg border p-4">
          <h2 className="font-semibold">Prepared work — private state unavailable</h2>
          <HomeWorkLibraryAction
            subjectId="00000000-0000-7000-8000-000000000103"
            href={`/${locale}/subjects/00000000-0000-7000-8000-000000000103/Prepared?slot=collections`}
            locale={locale}
          />
        </section>
      </HomeWorkLibraryProvider>
    </main>
  );
}

const meta = {
  title: 'Pages/Discovery/Home work Library (prepared)',
  component: PreparedHomeWorkLibrary,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof PreparedHomeWorkLibrary>;

export default meta;
type Story = StoryObj<typeof meta>;
export const ProjectionStates: Story = {};
