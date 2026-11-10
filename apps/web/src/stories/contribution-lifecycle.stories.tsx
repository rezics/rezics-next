import { useMemo, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import { changeContribution, readContributionAvailability } from '../features/catalogue/contribution-lifecycle';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ContributionLifecycle } from '../features/catalogue/contribution-lifecycle-view';
import { contributionFixture, type ContributionScenario } from '../kernel/fake/contribution-lifecycle';
import { CandidateValue } from '../features/pages/data';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import recording from '../kernel/recorded/subject-page.json';
import { AppShell } from '../shell/shell';
import { pagePaths, PatternStory } from './page';

function ContributionStory({ scenario = 'ready' }: { scenario?: ContributionScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => contributionFixture(scenario, locale), [scenario, locale]);
  const [clearedFor, setClearedFor] = useState<string>();
  const identity = `${scenario}:${locale}`;
  const cleared = clearedFor === identity;
  const page = structuredClone(recording) as unknown as SubjectPageData;
  return (
    <SubjectPage
      page={page}
      locale={locale}
      messages={subjectPageMessages()}
      tabs={subjectTabs(page)}
      tabLabels={viewTabLabels()}
      curation={
        scenario === 'empty' ? (
          <p>{m.contribution_empty()}</p>
        ) : (
          <div className="space-y-4">
            {!cleared && (
              <div data-testid="contribution-private-value">
                <CandidateValue
                  snak={fixture.candidate.statement}
                  related={fixture.publicRead.related}
                  locale={locale}
                />
              </div>
            )}
            <ContributionLifecycle
              key={`${scenario}:${locale}`}
              address={fixture.address}
              locale={locale}
              transport={fixture.transport}
              onClear={() => setClearedFor(identity)}
            />
          </div>
        )
      }
    />
  );
}

const meta = {
  title: 'Catalogue/Contribution lifecycle',
  id: 'pages-catalogue-contribution-lifecycle',
  component: ContributionStory,
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={pagePaths.subject}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Generated-client lifecycle examples on the existing subject page. Native outcome proof and Web/Root visual review remain pending. Use phone390/desktop1280, light/dark and locale globals.',
      },
    },
  },
} satisfies Meta<typeof ContributionStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function withdraw(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const region = within(await canvas.findByRole('region', { name: m.contribution_title() }));
  const button = region.getByRole('button', { name: m.contribution_withdraw() });
  await expect(button).toBeVisible();
  await userEvent.click(button);
  const dialog = await confirmationDialog(canvasElement);
  expect(dialog.getByText(m.contribution_confirm_delete())).toBeTruthy();
  // Intent is confirmed explicitly; opening the confirmation sends no mutation.
  await userEvent.click(dialog.getByRole('button', { name: m.contribution_confirm() }));
  return { canvas, region };
}
async function confirmationDialog(canvasElement: HTMLElement) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('alertdialog');
  await waitFor(async () => {
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-open');
  });
  return within(dialog);
}
async function restore(canvasElement: HTMLElement, region: ReturnType<typeof within>) {
  const button = await region.findByRole('button', { name: m.contribution_restore() });
  await waitFor(async () => {
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });
  await userEvent.click(button);
  const dialog = await confirmationDialog(canvasElement);
  await expect(dialog.getByText(m.contribution_confirm_restore())).toBeVisible();
  await userEvent.click(dialog.getByRole('button', { name: m.contribution_confirm() }));
}

export const Ready: Story = {};
export const WithdrawAndRestore: Story = {
  play: async ({ canvasElement }) => {
    const { canvas, region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_deleted())).toBeTruthy();
    expect(canvas.queryByTestId('contribution-private-value')).toBeNull();
    expect(region.getByText(m.contribution_subject_available())).toBeTruthy();
    await restore(canvasElement, region);
    expect(await region.findByText(m.contribution_restored())).toBeTruthy();
    expect(region.getByText(m.contribution_unselected())).toBeTruthy();
    expect(canvas.queryByTestId('contribution-private-value')).toBeNull();
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const { canvas, region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_denied())).toBeTruthy();
    expect(canvas.queryByTestId('contribution-private-value')).toBeNull();
    expect(region.queryByRole('button', { name: m.contribution_restore() })).toBeNull();
  },
};
export const Expired: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    await restore(canvasElement, region);
    expect((await region.findAllByText(m.contribution_expired())).length).toBeGreaterThan(0);
    expect(region.queryByRole('button', { name: m.contribution_restore() })).toBeNull();
    expect(region.queryByRole('button', { name: m.contribution_retry() })).toBeNull();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_invalid())).toBeTruthy();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_unavailable())).toBeTruthy();
    expect(region.queryByText(m.contribution_deleted())).toBeNull();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    await userEvent.click(await region.findByRole('button', { name: m.contribution_retry() }));
    expect(await region.findByText(m.contribution_deleted())).toBeTruthy();
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    expect(region.getByText(m.contribution_loading())).toBeTruthy();
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const CurrentWithholding: Story = {
  args: { scenario: 'withheld' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    await restore(canvasElement, region);
    expect(await region.findByText(m.contribution_restored())).toBeTruthy();
    expect(region.getByText(m.contribution_candidate_unconfirmed())).toBeTruthy();
  },
};

// Additional constructed interface examples. All plays, native and geometry assertions are UNRUN.
// Bounded absence and withholding deliberately share the same honest unconfirmed presentation.
type FamilyScenario = ContributionScenario | 'bounded-absence';
function FamilyPanel({ scenario }: { scenario: FamilyScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const base = contributionFixture(scenario === 'bounded-absence' ? 'ready' : scenario, locale);
    if (scenario !== 'bounded-absence') return base;
    const client = createKernelClient('https://contribution.test', {
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/candidates'))
          return Response.json({ candidates: [], adoption: null, next: null });
        return base.fetcher(request);
      }) as typeof fetch,
    });
    return {
      ...base,
      transport: {
        change: (command: Parameters<typeof changeContribution>[2]) =>
          changeContribution(client, 'Bearer fixture', command),
        read: (address: Parameters<typeof readContributionAvailability>[2]) =>
          readContributionAvailability(client, 'Bearer fixture', address),
      },
    };
  }, [scenario, locale]);
  const [cleared, setCleared] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`family-${scenario}`}>
      {!cleared && (
        <div data-testid="contribution-private-value">
          <CandidateValue snak={fixture.candidate.statement} related={fixture.publicRead.related} locale={locale} />
        </div>
      )}
      <ContributionLifecycle
        address={fixture.address}
        locale={locale}
        transport={fixture.transport}
        onClear={() => setCleared(true)}
      />
    </div>
  );
}
function ContributionFamilyStory({ scenarios }: { scenarios: FamilyScenario[] }) {
  const page = structuredClone(recording) as unknown as SubjectPageData;
  return (
    <SubjectPage
      page={page}
      locale={getLocale()}
      messages={subjectPageMessages()}
      tabs={subjectTabs(page)}
      tabLabels={viewTabLabels()}
      curation={
        <div className="grid min-w-0 gap-6">
          {scenarios.map((scenario) => (
            <FamilyPanel key={`${scenario}:${getLocale()}`} scenario={scenario} />
          ))}
        </div>
      }
    />
  );
}

export const IndependentPanels: Story = {
  render: () => <ContributionFamilyStory scenarios={['uncertain', 'ready']} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = canvas.getByTestId('family-uncertain');
    const second = canvas.getByTestId('family-ready');
    await userEvent.click(within(first).getByRole('button', { name: m.contribution_withdraw() }));
    await userEvent.click(
      (await confirmationDialog(canvasElement)).getByRole('button', { name: m.candidate_cancel() }),
    );
    expect(within(second).getByTestId('contribution-private-value')).toBeTruthy();
    const { region } = await withdraw(first);
    expect(await region.findByText(m.contribution_unavailable())).toBeTruthy();
    await expect(within(second).getByRole('button', { name: m.contribution_withdraw() })).toBeEnabled();
    await userEvent.click(region.getByRole('button', { name: m.contribution_retry() }));
    expect(await region.findByText(m.contribution_deleted())).toBeTruthy();
    expect(within(first).queryByTestId('contribution-private-value')).toBeNull();
    expect(within(second).getByTestId('contribution-private-value')).toBeTruthy();
    await restore(first, region);
    expect(await region.findByText(m.contribution_unselected())).toBeTruthy();
    expect(within(second).queryByText(m.contribution_restored())).toBeNull();
  },
};

export const LongLocalizedRecoveryAndConfirmation: Story = {
  globals: { locale: 'de' },
  render: () => <ContributionFamilyStory scenarios={['unavailable', 'ready']} />,
  parameters: {
    docs: {
      description: {
        story:
          'Existing German recovery and confirmation copy, full wrapping at phone390 and desktop1280. Constructed source only; layout and interaction UNRUN. Locale and theme globals remain available.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const { region: recovery } = await withdraw(canvas.getByTestId('family-unavailable'));
    expect(await recovery.findByText(m.contribution_unavailable())).toBeTruthy();
    const { region } = await withdraw(canvas.getByTestId('family-ready'));
    expect(await region.findByText(m.contribution_window())).toBeTruthy();
    await userEvent.click(region.getByRole('button', { name: m.contribution_restore() }));
    const dialog = await confirmationDialog(canvasElement);
    expect(dialog.getByText(m.contribution_confirm_restore())).toBeTruthy();
    await expect(dialog.getByRole('button', { name: m.candidate_cancel() })).toBeVisible();
    await expect(dialog.getByRole('button', { name: m.contribution_confirm() })).toBeVisible();
  },
};

export const DistinctAvailabilityOutcomes: Story = {
  render: () => <ContributionFamilyStory scenarios={['ready', 'bounded-absence', 'withheld', 'expired']} />,
  parameters: {
    docs: {
      description: {
        story:
          'Available, bounded-page absence, current withholding and expired restoration use independent native-shaped fixture seams. Absence and withholding disclose no private value and neither asserts deletion. All assertions UNRUN.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const scenario of ['ready', 'bounded-absence', 'withheld', 'expired']) {
      const panel = canvas.getByTestId(`family-${scenario}`);
      const { region } = await withdraw(panel);
      await restore(panel, region);
      if (scenario === 'expired') {
        expect((await region.findAllByText(m.contribution_expired())).length).toBeGreaterThan(0);
        expect(region.queryByRole('button', { name: m.contribution_restore() })).toBeNull();
      } else {
        expect(await region.findByText(m.contribution_restored())).toBeTruthy();
        expect(region.getByText(m.contribution_subject_available())).toBeTruthy();
        expect(
          region.getByText(
            scenario === 'ready' ? m.contribution_candidate_available() : m.contribution_candidate_unconfirmed(),
          ),
        ).toBeTruthy();
        expect(region.getByText(m.contribution_unselected())).toBeTruthy();
      }
      expect(within(panel).queryByTestId('contribution-private-value')).toBeNull();
    }
  },
};
