import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { AddonProfile } from '../features/catalogue/addon-profile-view';
import {
  addonProfileFixture,
  addonProfileId,
  addonWorkId,
  addonCreatedId,
  type AddonScenario,
} from '../kernel/fake/catalogue-addon-profile';
import { pageText } from '../features/pages/data';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';

const longAddon = `Harbor: Northern lights 港：北の光 항구：북극광 ${'ExtensionSansEspaces'.repeat(12)}`;
const longBase = `Harbor 港 항구 港灣 المرفأ ${'GrundspielOhneLeerzeichen'.repeat(12)}`;

function Example({
  scenario = 'ready',
  existing = false,
  work = false,
  reference,
  session,
}: {
  scenario?: AddonScenario;
  existing?: boolean;
  work?: boolean;
  reference?: 'long' | 'reload-failure';
  session?: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = addonProfileFixture(scenario, locale);
    if (reference === 'long') {
      fixture.current.subject.labels = { en: longAddon, ja: longAddon, ko: longAddon, 'zh-Hant': longAddon };
      fixture.work.subject.labels = { en: longBase, ja: longBase, ko: longBase, 'zh-Hant': longBase };
    }
    // Illustrative failure injection retains the original production reader and fixture request seams.
    const load = fixture.transport.load;
    let reads = 0;
    fixture.props = {
      ...fixture.props,
      transport: {
        ...fixture.transport,
        load: async (address) =>
          reference === 'reload-failure' && reads++ > 0 ? { ok: false, reason: 'unavailable' } : load(address),
      },
    };
    return fixture;
  }, [scenario, locale, reference]);
  return (
    <PatternStory visitor={scenario === 'signed-out' || session === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <AddonProfile
          key={`${scenario}:${existing}:${work}:${locale}`}
          locale={locale}
          {...fixture.props}
          {...(session ? { session } : {})}
          {...(existing ? { id: addonProfileId } : {})}
          {...(work ? { work: addonWorkId } : {})}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Add-on and expansion editor',
  component: Example,
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
          'Synthetic native-shaped responses through current production adapters. Locale, viewport and theme use globals. Web owns captures and visible acceptance; these stories do not establish native execution.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RouteEntry: Story = { render: () => <PageStory visitor="Signed In" path="/catalogue/addon" /> };
export const Create: Story = {};
export const BaseWork: Story = { args: { work: true } };
export const CurrentProfile: Story = { args: { existing: true } };
async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Northern lights');
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
export const Created: Story = {
  args: { work: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.addon_use_base() }));
    await create(canvasElement);
    const correction = await canvas.findByRole('link', { name: m.addon_correct() });
    expect(correction.getAttribute('href')).toContain(`/subjects/${addonCreatedId}/northern-lights/addon`);
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    expect(await canvas.findByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(await canvas.findByRole('button', { name: m.catalogue_create_retry() }));
    await expect(canvas.findByRole('link', { name: m.addon_correct() })).resolves.toBeVisible();
  },
};
export const Proposed: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = within(
      await canvas.findByRole('region', {
        name: pageText(addonProfileFixture().release.properties['schema:inLanguage']!.labels, getLocale()).text,
      }),
    );
    await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
    const value = field.getByRole('textbox', { name: m.correction_value() });
    await userEvent.clear(value);
    await userEvent.type(value, 'ko');
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(field.findByText(m.correction_proposed())).resolves.toBeVisible();
    expect(field.getByRole('link', { name: m.correction_review() }).getAttribute('href')).toContain('candidate=');
  },
};
export const Partial: Story = {
  args: { existing: true, scenario: 'partial' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const [property, value] of [
      ['schema:inLanguage', 'fr'],
      ['schema:url', 'https://example.org/addon'],
    ] as const) {
      const field = within(
        await canvas.findByRole('region', {
          name: pageText(addonProfileFixture().release.properties[property]!.labels, getLocale()).text,
        }),
      );
      await userEvent.click(field.getByRole('button', { name: m.facts_edit_field() }));
      const input = field.getByRole('textbox', { name: m.correction_value() });
      await userEvent.clear(input);
      await userEvent.type(input, value);
    }
    await userEvent.click(canvas.getByRole('button', { name: m.facts_submit() }));
    await expect(canvas.findByText(m.correction_denied())).resolves.toBeVisible();
    await expect(canvas.findByText(m.correction_proposed())).resolves.toBeVisible();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const CurrentLoading: Story = { args: { existing: true, scenario: 'loading' } };
export const SignedOut: Story = { args: { scenario: 'signed-out' } };
export const Denied: Story = { args: { scenario: 'denied', existing: true } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_invalid())).resolves.toBeVisible();
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_reader_unavailable())).resolves.toBeVisible();
  },
};
export const ConcealedReader: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_concealed())).resolves.toBeVisible();
  },
};

// UNRUN: these production-composed fixtures do not establish native, browser or layout acceptance.
export const LongWorkReferences: Story = {
  args: { existing: true, work: true, reference: 'long' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: longAddon, level: 2 });
    const title = await canvas.findByRole('heading', { name: longBase, level: 3 });
    const link = within(title).getByRole('link', { name: longBase });
    const frame = title.closest<HTMLElement>('[data-slot="profile-work-reference"]')!;
    const view = canvasElement.ownerDocument.defaultView!;
    const touch = view.innerWidth < 768 || view.matchMedia('(pointer: coarse)').matches;
    for (const action of [link, canvas.getByRole('link', { name: m.candidate_view_public() })]) {
      const rect = action.getBoundingClientRect();
      await expect(rect.height).toBeGreaterThanOrEqual(touch ? 44 : 32);
      if (touch) await expect(rect.width).toBeGreaterThanOrEqual(44);
      else if (action !== link) await expect(rect.height).toBeLessThan(44);
      await expect(action.scrollWidth).toBeLessThanOrEqual(action.clientWidth + 1);
    }
    await expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(frame.getBoundingClientRect().right + 1);
    await expect(link.querySelector('a, button, input, details')).toBeNull();
    link.focus();
    await userEvent.tab();
    const details = canvasElement.querySelector<HTMLDetailsElement>('details[aria-label]')!;
    await expect(details.querySelector('summary')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    for (const code of details.querySelectorAll('code')) {
      await expect(code).toBeVisible();
      await expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth + 1);
    }
    await expect(details.textContent).toContain(addonWorkId);
    await expect(canvas.getByRole('main').scrollWidth).toBeLessThanOrEqual(canvas.getByRole('main').clientWidth + 1);
  },
};
export const CurrentWithBaseWork: Story = { args: { existing: true, work: true } };
export const CurrentWithoutSuppliedWork: Story = { args: { existing: true } };
export const CurrentSignedOut: Story = { args: { existing: true, work: true, session: 'signed-out' } };
export const CurrentSessionUnknown: Story = { args: { existing: true, work: true, session: 'unknown' } };
export const CurrentSessionUnavailable: Story = { args: { existing: true, work: true, session: 'unavailable' } };
export const ReferenceReloadFailure: Story = {
  args: { existing: true, work: true, reference: 'reload-failure' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Harbor: Northern lights' });
    const root = canvasElement.querySelector('[data-slot="view-heading"]')!.closest('article')!;
    await userEvent.click(within(root).getAllByRole('button', { name: m.correction_reload() }).at(-1)!);
    await expect(canvas.findByText(m.correction_unavailable())).resolves.toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Harbor: Northern lights' })).toBeNull();
    await expect(root.querySelector('div[hidden]')).not.toBeNull();
  },
};

function RetiringReference() {
  const [retired, setRetired] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setRetired(true)}>
        {m.account_sign_out()}
      </button>
      <CandidateReaderBoundary
        observed={
          retired
            ? { state: 'signed-out', csrfToken: null }
            : { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', csrfToken: 'story-csrf-token' }
        }
        address="addon-reference-story"
      >
        <Example
          existing
          work
          scenario={retired ? 'unavailable' : 'ready'}
          session={retired ? 'signed-out' : 'signed-in'}
        />
      </CandidateReaderBoundary>
    </>
  );
}
export const CurrentReadRetirement: Story = {
  render: () => <RetiringReference />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Harbor: Northern lights' });
    await userEvent.click(canvas.getByRole('button', { name: m.account_sign_out() }));
    await expect(canvas.findByText(m.correction_unavailable())).resolves.toBeVisible();
    for (const value of ['Harbor: Northern lights', addonProfileId, addonWorkId])
      await expect(canvasElement.innerHTML).not.toContain(value);
  },
};
