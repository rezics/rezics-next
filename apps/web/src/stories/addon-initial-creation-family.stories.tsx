import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { AddonProfile } from '../features/catalogue/addon-profile-view';
import { AddonProfileCreate } from '../features/catalogue/addon-profile-create';
import { addonType, type AddonTransport } from '../features/catalogue/addon-profile';
import {
  addonProfileFixture,
  addonWorkId,
  addonCreatedId,
  type AddonScenario,
} from '../kernel/fake/catalogue-addon-profile';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { PatternStory } from './page';

const longName = `Northern lights 北の光 북극광 أضواء الشمال ${'ExtensionSansEspaces'.repeat(7)}`;
const longDescription = '追加作品の説明 — 설명 — وصف يحافظ على المعنى الكامل. '.repeat(4);
const evidence = `https://example.org/evidence/${'NorthernLights'.repeat(40)}?language=ja`;
const longBase = `Harbor 港 항구 المرفأ ${'GrundspielOhneLeerzeichen'.repeat(15)}`;
const longProperty = `منصة اللعبة — 遊戲平台 — ${'PlatformOhneLeerzeichen'.repeat(12)}`;
const longMeaning = '説明を省略せず保持します。 وصف كامل للمنصة والأدلة المرتبطة بها. '.repeat(8).trim();

function Example({
  scenario = 'ready',
  supplied = true,
  pair = false,
  long = false,
  rtl = false,
  empty = false,
  session = 'signed-in',
  refreshFailure = false,
}: {
  scenario?: AddonScenario;
  supplied?: boolean;
  pair?: boolean;
  long?: boolean;
  rtl?: boolean;
  empty?: boolean;
  refreshFailure?: boolean;
  session?: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
}) {
  const locale = getLocale();
  const fixtures = useMemo(
    () => [addonProfileFixture(scenario, locale), addonProfileFixture(scenario, locale)],
    [scenario, locale],
  );
  const fixture = fixtures[0]!;
  const release = useMemo(() => {
    const release = structuredClone(fixture.release);
    if (empty) release.types[addonType]!.labels = {};
    if (long) {
      // Supplied metadata language is independent of the interface and term languages.
      release.properties['schema:gamePlatform']!.labels = { ar: longProperty };
      release.properties['schema:gamePlatform']!.descriptions = { ar: longMeaning };
    }
    return release;
  }, [fixture, empty, long]);
  const transport = useMemo<AddonTransport>(() => {
    let refreshing = false;
    return {
      ...fixture.transport,
      create: refreshFailure
        ? async () => {
            refreshing = true;
            return {
              ok: false,
              reason: 'invalid',
              refreshDefinitions: true,
              errors: [{ pointer: '/statements/schema:inLanguage/0/value/content', code: 'invalid_format' }],
            };
          }
        : fixture.transport.create,
      load: async (address) => {
        if (refreshing) return { ok: false, reason: 'denied' };
        const read = await fixture.transport.load(address);
        if (!read.ok) return read;
        return {
          ...read,
          release,
          work:
            read.work && long
              ? { ...read.work, subject: { ...read.work.subject, labels: { ar: longBase } } }
              : read.work,
        };
      },
    };
  }, [fixture, release, long, refreshFailure]);
  return (
    <PatternStory visitor={session === 'signed-out' ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <div dir={rtl ? 'rtl' : undefined} className="min-w-0 max-w-full">
          {pair ? (
            <>
              <h1 className="text-2xl font-semibold">{m.addon_title()}</h1>
              {fixtures.map((value, index) => (
                <section key={index} data-addon-form={index} className="min-w-0 py-6">
                  <AddonProfileCreate
                    read={{ ok: true, release, public: null, work: index === 0 ? value.work : null }}
                    locale={locale}
                    session={session}
                    transport={value.transport}
                    search={value.props.search}
                    onCreated={() => undefined}
                  />
                </section>
              ))}
            </>
          ) : (
            <AddonProfile
              key={`${scenario}:${locale}:${supplied}:${long}:${empty}:${session}`}
              {...fixture.props}
              locale={locale}
              session={session}
              transport={transport}
              {...(supplied ? { work: addonWorkId } : {})}
            />
          )}
        </div>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Add-on initial creation family',
  id: 'pages-catalogue-add-on-initial-creation-family',
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
          'UNRUN connected production components and canonical native-shaped HTTP fixtures. Review at phone390 and desktop1280 using locale/theme globals. Plays are authored browser oracles, not measured layout, native authorization, SSR or physical growth evidence. Creation and later reader disclosure remain separate. No extra presentation IO or population traversal is introduced.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(scope: HTMLElement, long = false) {
  const canvas = within(scope);
  const name = await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.type(name, long ? longName : 'Northern lights');
  return canvas;
}
async function add(scope: HTMLElement, property: string) {
  const group = scope.querySelector<HTMLElement>('[data-slot="addon-initial-facts"]')!;
  await userEvent.selectOptions(within(group).getByRole('combobox', { name: m.character_add_fact() }), property);
  await userEvent.click(within(group).getAllByRole('button', { name: m.correction_add() })[0]!);
  return [...group.querySelectorAll<HTMLElement>(':scope > fieldset > section')].at(-1)!;
}
async function addPart(row: HTMLElement, label: string, property: string) {
  const select = within(row).getByRole('combobox', { name: label });
  await userEvent.selectOptions(select, property);
  await userEvent.click(
    within(select.closest('[data-slot="field"]')!.parentElement!).getByRole('button', { name: m.correction_add() }),
  );
}
async function submit(scope: HTMLElement) {
  const canvas = await fill(scope);
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
  return canvas;
}
async function inspect(scope: HTMLElement) {
  const group = scope.querySelector<HTMLElement>('[data-slot="addon-initial-facts"]')!;
  const action = within(group).getByRole('button', { name: m.addon_use_base() });
  action.focus();
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  await expect(action).toHaveFocus();
  const view = scope.ownerDocument.defaultView!;
  await expect(view.getComputedStyle(action).outlineWidth).not.toBe('0px');
  if (view.innerWidth < 768 || view.matchMedia('(pointer: coarse)').matches) {
    await expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(action.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  }
  for (const element of [group, action, ...group.querySelectorAll<HTMLElement>('fieldset, section, h2, legend')]) {
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  }
}

export const SuppliedWork: Story = { play: ({ canvasElement }) => inspect(canvasElement) };
export const AbsentWork: Story = {
  args: { supplied: false },
  play: async ({ canvasElement }) => {
    await fill(canvasElement);
    await expect(within(canvasElement).queryByRole('button', { name: m.addon_use_base() })).toBeNull();
  },
};
export const ExplicitBaseAndEvidence: Story = {
  args: { long: true },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement, true);
    await inspect(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_description() }), longDescription);
    await userEvent.type(
      canvas.getByRole('textbox', { name: m.catalogue_create_aliases() }),
      'Northern lights alternate\n北の光',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
    await userEvent.type(canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!, 'ja');
    await userEvent.type(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!, '北の光');
    await userEvent.click(canvas.getByRole('button', { name: m.addon_use_base() }));
    await expect(canvas.queryByRole('button', { name: m.addon_use_base() })).toBeNull();
    const row = await add(canvasElement, 'schema:gamePlatform');
    const heading = within(row).getByRole('heading', { name: longProperty });
    await expect(heading).toHaveAttribute('lang', 'ar');
    await expect(within(row).getByText(longMeaning)).toHaveAttribute('lang', 'ar');
    await expect(within(row).getByText(longMeaning)).toBeVisible();
    await userEvent.type(within(row).getByRole('combobox', { name: longProperty }), 'platform');
    const options = within(await within(canvasElement.ownerDocument.body).findByRole('listbox')).getAllByRole('option');
    await expect(options).toHaveLength(1);
    await userEvent.click(options[0]!);
    await addPart(row, m.correction_add_qualifier(), 'schema:inLanguage');
    await userEvent.type(within(row).getByRole('textbox', { name: m.correction_value() }), 'ja');
    await userEvent.click(within(row).getByRole('button', { name: m.correction_add_reference() }));
    await addPart(row, m.correction_add_part(), 'schema:url');
    await userEvent.type(within(row).getByRole('textbox', { name: m.correction_url() }), evidence);
    await expect(within(row).getByRole('textbox', { name: m.correction_url() })).toHaveValue(evidence);
    for (const element of [row, heading, within(row).getByText(longMeaning)])
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(canvas.findByRole('link', { name: m.catalogue_create_open() })).resolves.toBeVisible();
    const correction = await canvas.findByRole('link', { name: m.addon_correct() });
    await expect(correction.getAttribute('href')).toContain(`/subjects/${addonCreatedId}/`);
    await expect(correction.getAttribute('href')?.endsWith('/addon')).toBe(true);
  },
};
export const LongFallbackRTL: Story = {
  args: { long: true, rtl: true },
  play: async ({ canvasElement }) => {
    await fill(canvasElement);
    const row = await add(canvasElement, 'schema:gamePlatform');
    await expect(within(row).getByRole('heading', { name: longProperty })).toHaveAttribute('lang', 'ar');
    await expect(within(row).getByText(longMeaning)).toHaveAttribute('lang', 'ar');
    await expect(row.closest('[dir="rtl"]')).not.toBeNull();
    await inspect(canvasElement);
  },
};
export const IndependentErrorTargets: Story = {
  args: { pair: true },
  play: async ({ canvasElement }) => {
    const sections = [...canvasElement.querySelectorAll<HTMLElement>('[data-addon-form]')];
    for (const section of sections) {
      // Scope native shared terms by form; their public identities remain unchanged.
      await userEvent.type(
        section.querySelector<HTMLInputElement>('input[id="create-label-0"]')!,
        'Independent add-on',
      );
      const row = await add(section, 'schema:inLanguage');
      await userEvent.type(within(row).getByRole('textbox', { name: m.correction_value() }), 'invalid language');
      await userEvent.click(within(section).getByRole('button', { name: m.catalogue_create_submit() }));
      const alert = await within(section).findByRole('alert');
      const correction = await within(alert).findByRole('link', { name: m.game_profile_initial() });
      const group = section.querySelector<HTMLElement>('[data-slot="addon-initial-facts"]')!;
      await expect(decodeURIComponent(correction.getAttribute('href')!.slice(1))).toBe(group.id);
      correction.focus();
      await userEvent.keyboard('{Enter}');
      await expect(group).toHaveFocus();
      await expect(group.closest('form')).toBe(section.querySelector('form'));
    }
    const ids = sections.map((section) => section.querySelector('[data-slot="addon-initial-facts"]')!.id);
    await expect(new Set(ids).size).toBe(2);
  },
};
export const UncertainExactRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_uncertain())).resolves.toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(canvas.findByRole('link', { name: m.addon_correct() })).resolves.toBeVisible();
  },
};
export const CreatedReady: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(canvas.findByRole('link', { name: m.catalogue_create_open() })).resolves.toHaveAttribute(
      'href',
      `/${getLocale()}/subjects/${addonCreatedId}/northern-lights`,
    );
  },
};
async function unreadable(scope: HTMLElement, message: string) {
  const canvas = await submit(scope);
  await expect(canvas.findByText(message)).resolves.toBeVisible();
  await expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  await expect(canvas.queryByRole('link', { name: m.addon_correct() })).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
  await expect(canvas.findByText(message)).resolves.toBeVisible();
}
export const CreatedConcealed: Story = {
  args: { scenario: 'concealed' },
  play: ({ canvasElement }) => unreadable(canvasElement, m.catalogue_create_concealed()),
};
export const CreatedUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: ({ canvasElement }) => unreadable(canvasElement, m.catalogue_create_reader_unavailable()),
};
export const InvalidMetadataRefresh: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_invalid())).resolves.toBeVisible();
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Northern lights');
  },
};
export const RefreshFailureRetainsDraft: Story = {
  args: { refreshFailure: true },
  play: async ({ canvasElement }) => {
    const canvas = await fill(canvasElement);
    const row = await add(canvasElement, 'schema:inLanguage');
    await userEvent.type(within(row).getByRole('textbox', { name: m.correction_value() }), 'ja');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    await expect(canvas.findByText(m.catalogue_create_unavailable())).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    await expect(canvas.findByRole('textbox', { name: m.catalogue_create_label() })).resolves.toHaveValue(
      'Northern lights',
    );
    await expect(canvas.getByRole('textbox', { name: m.correction_value() })).toHaveValue('ja');
  },
};
export const ReleasedMultiplicity: Story = {
  play: async ({ canvasElement }) => {
    await fill(canvasElement);
    await add(canvasElement, 'schema:url');
    const group = canvasElement.querySelector<HTMLElement>('[data-slot="addon-initial-facts"]')!;
    const select = within(group).getByRole('combobox', { name: m.character_add_fact() });
    await expect([...select.querySelectorAll('option')].some((option) => option.value === 'schema:url')).toBe(false);
    await add(canvasElement, 'schema:sameAs');
    await add(canvasElement, 'schema:sameAs');
    await expect(group.querySelectorAll(':scope > fieldset > section')).toHaveLength(3);
  },
};
export const DeniedCreation: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(canvas.findByText(m.catalogue_create_denied())).resolves.toBeVisible();
  },
};
export const StaleMetadata: Story = { args: { scenario: 'stale' } };
export const UnavailableMetadata: Story = { args: { scenario: 'unavailable' } };
export const EmptyMetadata: Story = { args: { empty: true } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const SignedOut: Story = { args: { session: 'signed-out' } };
export const SessionUnknown: Story = { args: { session: 'unknown' } };
export const SessionUnavailable: Story = { args: { session: 'unavailable' } };

// A held delivery belongs to the old boundary. Resolving it after sign-out cannot publish its result.
function RetiringCreation() {
  const locale = getLocale();
  const fixture = useMemo(() => addonProfileFixture('ready', locale), [locale]);
  const [retired, setRetired] = useState(false);
  const held = useMemo(() => {
    let finish!: (result: Awaited<ReturnType<typeof fixture.transport.create>>) => void;
    const result = new Promise<Awaited<ReturnType<typeof fixture.transport.create>>>((resolve) => {
      finish = resolve;
    });
    return { result, finish };
  }, [fixture]);
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <button
          type="button"
          onClick={() => {
            setRetired(true);
            held.finish({
              ok: true,
              id: addonCreatedId,
              reader: { state: 'ready', href: `/en/subjects/${addonCreatedId}/retired` },
            });
          }}
        >
          {m.account_sign_out()}
        </button>
        <CandidateReaderBoundary
          address="addon-creation-retirement-story"
          observed={
            retired
              ? { state: 'signed-out', csrfToken: null }
              : { state: 'signed-in', subject: 'original-story-reader', csrfToken: 'original-story-csrf' }
          }
        >
          <AddonProfileCreate
            read={{ ok: true, release: fixture.release, public: null, work: fixture.work }}
            locale={locale}
            session={retired ? 'signed-out' : 'signed-in'}
            transport={{ ...fixture.transport, create: () => held.result }}
            search={fixture.props.search}
            onCreated={() => undefined}
          />
        </CandidateReaderBoundary>
      </AppShell>
    </PatternStory>
  );
}
export const RetiredCreationDelivery: Story = {
  render: () => <RetiringCreation />,
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await expect(canvas.findByRole('button', { name: m.catalogue_create_saving() })).resolves.toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.account_sign_out() }));
    await expect(canvas.findByText(m.catalogue_create_signed_out())).resolves.toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    await expect(canvasElement.innerHTML).not.toContain(addonCreatedId);
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('');
  },
};
