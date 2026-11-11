import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { CreateZone } from '../features/zones/manage/create';
import { OwnerLifetime } from '../features/zones/editor/owner-lifetime';
import { fixtureZoneId, zonesFixture, type Scenario } from '../features/zones/manage/fixtures';
import { zonesNavigation } from '../features/zones/manage/navigation';
import { starterChoices } from '../features/zones/manage/starters';
import { pickText } from '@rezics/composition';
import { sessionQuery } from '../session/query';
import type { NavigationSession } from '../shell/navigation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function CreationFamily({
  scenario = 'list',
  session = 'signed-in',
  independent = false,
  rtl = false,
}: {
  scenario?: Scenario;
  session?: NavigationSession;
  independent?: boolean;
  rtl?: boolean;
}) {
  const locale = getLocale();
  const first = useMemo(() => zonesFixture(scenario), [scenario]);
  const second = useMemo(() => zonesFixture(scenario), [scenario]);
  return (
    <PatternStory path="/my/zones/new" visitor={session === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell navigation={zonesNavigation}>
        <div className="min-w-0 space-y-12" dir={rtl ? 'rtl' : undefined}>
          <div data-visit="first">
            <CreateZone
              locale={locale}
              session={session}
              onCreate={first.create}
              onNavigate={() => {
                /* Keep the saved Configure and Open destinations reviewable. */
              }}
            />
          </div>
          {independent ? (
            <div data-visit="second">
              <CreateZone
                locale={locale}
                session={session}
                onCreate={second.create}
                onNavigate={() => {
                  /* This visit owns its own synthetic native command and receipt. */
                }}
              />
            </div>
          ) : null}
        </div>
      </AppShell>
    </PatternStory>
  );
}

function RetiringCreation() {
  const locale = getLocale();
  const [native] = useState(() => zonesFixture('uncertain'));
  const [client] = useState(() => {
    const value = new QueryClient();
    value.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'synthetic-owner',
      csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    return value;
  });
  const [owner] = useState(() => new OwnerLifetime(client, `/${locale}/my/zones/new`));
  const [session, setSession] = useState<NavigationSession>('signed-in');
  return (
    <PatternStory path="/my/zones/new" visitor="Signed In">
      <AppShell navigation={zonesNavigation}>
        <div className="min-w-0 space-y-6">
          <Button
            variant="outline"
            onClick={() => {
              client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
              setSession('signed-out');
            }}
          >
            {m.account_sign_out()}
          </Button>
          <CreateZone
            locale={locale}
            session={session}
            owner={owner}
            onCreate={async (command, capture) => {
              const result = await native.create(command);
              return capture ? { ...result, ownerObservation: capture.observation } : result;
            }}
            onNavigate={() => {
              /* Saved destination remains in the actual component. */
            }}
          />
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Zones/Starter creation family',
  id: 'pages-zones-starter-creation-family',
  component: CreationFamily,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'UNRUN actual CreateZone with the canonical zonesFixture native-shaped API. Review the complete journey at 390 and 1280, light/dark and all locale globals. The long-help example uses supplied German copy and the longest supplied starter name; no starter or help text is truncated or substituted. RTL is an inherited layout stress case, not a new supported UI language. DOM/play assertions do not establish geometry, native authorization, physical growth or browser acceptance. Creation adds zero reads, one POST per deliberate submit/retry and no whole-population traversal; the mounted regression authors 1/8/32-character and 1/4/8-language growth (the actual eight-language maximum).',
      },
    },
  },
} satisfies Meta<typeof CreationFamily>;
export default meta;
type Story = StoryObj<typeof meta>;

async function prepare(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const locale = getLocale();
  await userEvent.selectOptions(await canvas.findByLabelText(m.zones_create_starter()), 'book');
  await expect(canvas.getByLabelText(m.zone_name_primary())).toHaveValue('');
  await userEvent.selectOptions(canvas.getByLabelText(m.zone_name_language()), 'ja');
  await userEvent.type(
    canvas.getByLabelText(m.zone_name_primary()),
    '長い名前の本棚と読書の記録、旅先で出会った物語と大切な思い出',
  );
  await expect(canvas.getByLabelText(m.zone_name_primary())).toHaveAttribute('lang', 'ja');
  await expect(canvas.getByText(m.zones_create_names_help({}, { locale: locale as never }))).toBeVisible();
  return canvas;
}
async function save(canvasElement: HTMLElement) {
  const canvas = await prepare(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.zones_create_submit() }));
  return canvas;
}
export const Starter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByLabelText(m.zones_create_starter());
    await expect(select.tagName).toBe('SELECT');
    await expect(select).toHaveAccessibleDescription(m.zones_create_starter_help());
    await expect(canvas.getByText(m.zones_create_visibility())).toBeVisible();
    select.focus();
    await expect(select).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: m.zones_create_submit() })).toHaveFocus();
  },
};

export const IndependentVisits: Story = {
  args: { independent: true },
  play: async ({ canvasElement }) => {
    const firstHost = canvasElement.querySelector<HTMLElement>('[data-visit="first"]')!;
    const secondHost = canvasElement.querySelector<HTMLElement>('[data-visit="second"]')!;
    const first = within(firstHost);
    const second = within(secondHost);
    const a = await first.findByLabelText(m.zones_create_starter());
    const b = await second.findByLabelText(m.zones_create_starter());
    await expect(a.id).not.toBe(b.id);
    await expect(a.getAttribute('aria-describedby')).not.toBe(b.getAttribute('aria-describedby'));
    for (const [host, select] of [
      [firstHost, a],
      [secondHost, b],
    ] as const) {
      const label = [...host.querySelectorAll('label')].find((node) => node.htmlFor === select.id)!;
      await expect(label.control).toBe(select);
      await expect(host.contains(document.getElementById(select.getAttribute('aria-describedby')!))).toBe(true);
      await expect(select).toHaveAccessibleDescription(m.zones_create_starter_help());
    }
    await userEvent.click(second.getByRole('button', { name: m.zones_create_submit() }));
    await expect(b).toHaveFocus();
    await expect(a).toHaveAttribute('aria-invalid', 'false');
    await userEvent.selectOptions(a, 'book');
    await userEvent.type(first.getByRole('textbox'), '私の本棚');
    await userEvent.selectOptions(b, 'game');
    await userEvent.type(second.getByRole('textbox'), '独立したゲームの記録');
    await userEvent.selectOptions(a, 'manga');
    await expect(first.getByRole('textbox')).toHaveValue('私の本棚');
    await expect(second.getByRole('textbox')).toHaveValue('独立したゲームの記録');
  },
};
export const AuthoredNaming: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await prepare(canvasElement);
    await userEvent.click(canvas.getByText(m.zone_name_translations()));
    await userEvent.selectOptions(canvas.getByLabelText(m.zone_name_add()), 'de');
    const german = new Intl.DisplayNames([getLocale()], { type: 'language' }).of('de')!;
    await userEvent.type(canvas.getByLabelText(german), 'Meine Bücher und Geschichten von langen Reisen');
    await userEvent.selectOptions(canvas.getByLabelText(m.zones_create_starter()), 'visual-novel');
    await expect(canvas.getByLabelText(m.zone_name_primary())).toHaveValue(
      '長い名前の本棚と読書の記録、旅先で出会った物語と大切な思い出',
    );
    await expect(canvas.getByLabelText(german)).toHaveValue('Meine Bücher und Geschichten von langen Reisen');
    await userEvent.selectOptions(canvas.getByLabelText(m.zone_name_language()), 'en');
    await expect(canvas.getByLabelText(m.zone_name_primary())).toHaveValue('');
    await userEvent.selectOptions(canvas.getByLabelText(m.zone_name_language()), 'ja');
    await expect(canvas.getByLabelText(m.zone_name_primary())).not.toHaveValue('');
  },
};
export const LongLocalizedHelp: Story = {
  globals: { locale: 'de' },
  play: async ({ canvasElement }) => {
    const canvas = await prepare(canvasElement);
    const longest = [...starterChoices].sort(
      (a, b) => pickText(b.labels, 'de').text.length - pickText(a.labels, 'de').text.length,
    )[0]!;
    await userEvent.selectOptions(canvas.getByLabelText(m.zones_create_starter()), longest.id);
    await expect(canvas.getByLabelText(m.zones_create_starter())).toHaveAccessibleDescription(
      m.zones_create_starter_help(),
    );
    await expect(canvas.getByText(m.zones_create_visibility())).toBeVisible();
  },
};
export const RtlAuthoredNames: Story = { ...AuthoredNaming, args: { rtl: true } };
export const RequiredSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = await canvas.findByRole('button', { name: m.zones_create_submit() });
    submit.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.zones_owner_invalid());
    await expect(canvas.getByLabelText(m.zones_create_starter())).toHaveFocus();
  },
};
export const InvalidTranslation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await prepare(canvasElement);
    await userEvent.click(canvas.getByText(m.zone_name_translations()));
    await userEvent.selectOptions(canvas.getByLabelText(m.zone_name_add()), 'de');
    await userEvent.click(canvas.getByText(m.zone_name_translations()));
    await userEvent.click(canvas.getByRole('button', { name: m.zones_create_submit() }));
    const german = new Intl.DisplayNames([getLocale()], { type: 'language' }).of('de')!;
    await expect(canvas.getByLabelText(german)).toBeVisible();
    await expect(canvas.getByLabelText(german)).toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(canvas.getByRole('button', { name: m.zone_name_remove({ language: german }) }));
    await userEvent.click(canvas.getByRole('button', { name: m.zones_create_submit() }));
    await expect(await canvas.findByText(m.zones_create_saved())).toBeVisible();
  },
};
export const ConflictReview: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_conflict());
    await expect(canvas.getByLabelText(m.zones_create_starter())).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.zones_create_review() }));
    await expect(canvas.getByLabelText(m.zones_create_starter())).toHaveFocus();
    await expect(canvas.getByLabelText(m.zone_name_primary())).not.toHaveValue('');
    await expect(canvas.getByRole('button', { name: m.zones_create_submit() })).toBeEnabled();
  },
};
export const SavedDestinations: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    const configure = await canvas.findByRole('link', { name: m.zones_owner_configure() });
    const open = canvas.getByRole('link', { name: m.zones_owner_open() });
    await expect(configure).toHaveAttribute('href', `/${getLocale()}/my/zones/${fixtureZoneId}/edit`);
    await expect(open).toHaveAttribute('href', `/${getLocale()}/zones/${fixtureZoneId}`);
    await expect(canvas.getByText(m.zones_create_reader_help())).toBeVisible();
    configure.focus();
    await userEvent.tab();
    await expect(open).toHaveFocus();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await expect(await canvas.findByText(m.zones_create_uncertain())).toBeVisible();
    await expect(canvas.getByLabelText(m.zones_create_starter())).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.zones_create_submit() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.zones_owner_retry() }));
    await expect(await canvas.findByRole('link', { name: m.zones_owner_configure() })).toHaveAttribute(
      'href',
      `/${getLocale()}/my/zones/${fixtureZoneId}/edit`,
    );
  },
};
export const RetiredOwner: Story = {
  render: () => <RetiringCreation />,
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await canvas.findByText(m.zones_create_uncertain());
    await userEvent.click(canvas.getByRole('button', { name: m.account_sign_out() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_signed_out());
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: m.zones_owner_retry() })).not.toBeInTheDocument();
  },
};
export const Loading: Story = { args: { session: 'unknown' } };
export const SignedOut: Story = { args: { session: 'signed-out' } };
export const SessionUnavailable: Story = { args: { session: 'unavailable' } };
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await expect(canvas.getByRole('button', { name: m.zones_owner_working() })).toBeDisabled();
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_denied());
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_unavailable());
    await expect(canvas.getByText(m.zones_create_uncertain())).toBeVisible();
  },
};
export const ActorDenied: Story = {
  args: { scenario: 'actor' },
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_actor());
  },
};
export const FeatureClosed: Story = {
  args: { scenario: 'closed' },
  play: async ({ canvasElement }) => {
    const canvas = await save(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_closed());
  },
};
