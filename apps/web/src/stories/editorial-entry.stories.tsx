import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { SubjectFrame } from '../features/pages/subject-frame';
import { viewTabLabels } from '../features/pages/route-support';
import { SubjectTermsPage } from '../features/catalogue/subject-terms-page';
import { editorialEntryFailure, editorialSubject } from '../kernel/fake/editorial-entry';
import { pageText } from '../features/pages/data';
import { AppShell } from '../shell/shell';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { PageStory, PatternStory, pagePaths, pageReady } from './page';

type Scenario = 'ready' | 'signed-out' | 'denied' | 'unavailable';
function ContributeStory({ scenario = 'ready' }: { scenario?: Scenario }) {
  const locale = getLocale();
  const transport = useMemo(
    () => editorialEntryFailure(scenario === 'denied' ? 'denied' : 'unavailable', locale),
    [scenario, locale],
  );
  if (scenario === 'ready' || scenario === 'signed-out')
    return <PageStory visitor={scenario === 'signed-out' ? 'Signed Out' : 'Signed In'} path={pagePaths.subject} />;
  const title = pageText(editorialSubject.labels, locale);
  const href = `${subjectHref({ id: editorialSubject.id, label: title.text }, locale).href}/terms`;
  return (
    <PatternStory visitor="Signed In" path={href}>
      <AppShell>
        <section className="space-y-8">
          <SubjectFrame
            frame={{
              id: editorialSubject.id,
              type: editorialSubject.type,
              title,
              summary: null,
              context: editorialSubject.context,
            }}
            locale={locale}
            unlabelled={m.subject_value_unlabelled()}
            tabs={[]}
            tabLabels={viewTabLabels()}
            view="overview"
          />
          <SubjectTermsPage id={editorialSubject.id} locale={locale} session="signed-in" transport={transport} />
        </section>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Contribute',
  id: 'pages-catalogue-contribute',
  component: ContributeStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Existing application navigation and native refusal samples. Select locale, theme and phone390/desktop1280 through globals. Native acceptance and visual review are pending.',
      },
    },
  },
} satisfies Meta<typeof ContributeStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function open(canvasElement: HTMLElement) {
  await pageReady({ canvasElement });
  const canvas = within(canvasElement);
  const trigger = await canvas.findByRole('button', { name: m.contribute_title() });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  const body = within(canvasElement.ownerDocument.body);
  await waitFor(() =>
    expect(body.queryByRole('dialog', { name: m.contribute_title() }) ?? body.queryByRole('menu')).toBeVisible(),
  );
  return { trigger, body };
}
async function group(canvasElement: HTMLElement, label: string) {
  const { body, trigger } = await open(canvasElement);
  const sheet = body.queryByRole('dialog', { name: m.contribute_title() });
  const control = sheet
    ? within(sheet).getByRole('button', { name: label })
    : body.getByRole('menuitem', { name: label });
  control.focus();
  if (sheet) await userEvent.keyboard('{Enter}');
  else await userEvent.keyboard('{ArrowRight}');
  return { body, trigger };
}
export const Ready: Story = {};
export const Creation: Story = {
  play: async ({ canvasElement }) => {
    const { body } = await group(canvasElement, m.contribute_create());
    await waitFor(() =>
      expect(
        body.queryByRole('link', { name: m.catalogue_create_title() }) ??
          body.getByRole('menuitem', { name: m.catalogue_create_title() }),
      ).toHaveAttribute('href', `/${getLocale()}/catalogue/new`),
    );
  },
};
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const { body } = await group(canvasElement, m.contribute_edit());
    const link = await waitFor(() => {
      const entry =
        body.queryByRole('link', { name: m.catalogue_terms_title() }) ??
        body.getByRole('menuitem', { name: m.catalogue_terms_title() });
      expect(entry).toBeVisible();
      return entry;
    });
    expect(link.getAttribute('href')).toContain('/terms');
  },
};
export const Review: Story = {
  play: async ({ canvasElement }) => {
    const { body } = await group(canvasElement, m.contribute_review());
    await waitFor(() =>
      expect(
        body.queryByRole('link', { name: m.context_title() }) ??
          body.getByRole('menuitem', { name: m.context_title() }),
      ).toHaveAttribute('href', expect.stringContaining('/context-review?context=')),
    );
  },
};
export const Explanation: Story = {
  play: async ({ canvasElement }) => {
    const { body } = await group(canvasElement, m.contribute_read());
    await waitFor(() =>
      expect(
        body.queryByRole('link', { name: m.subject_sources() }) ??
          body.getByRole('menuitem', { name: m.subject_sources() }),
      ).toHaveAttribute('href', expect.stringContaining('/sources')),
    );
    await waitFor(() =>
      expect(
        body.queryByRole('link', { name: m.changes_title() }) ??
          body.getByRole('menuitem', { name: m.changes_title() }),
      ).toHaveAttribute('href', expect.stringContaining('/changes')),
    );
  },
};
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const { trigger } = await open(canvasElement);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
export const SignedOut: Story = {
  args: { scenario: 'signed-out' },
  play: async ({ canvasElement }) => {
    const { body } = await group(canvasElement, m.contribute_edit());
    await waitFor(() => {
      const entry =
        body.queryByRole('link', { name: m.catalogue_terms_title() }) ??
        body.getByRole('menuitem', { name: m.catalogue_terms_title() });
      const href = new URL(entry.getAttribute('href')!, 'https://rezics.test');
      expect(href.pathname).toBe('/auth/sign-in');
      expect(href.searchParams.get('return_to')).toContain('/terms');
    });
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.catalogue_create_language() }), 'en');
    const field = within(canvas.getByRole('group', { name: m.catalogue_create_label() }));
    await userEvent.selectOptions(field.getByRole('combobox'), 'set');
    await userEvent.clear(field.getByRole('textbox'));
    await userEvent.type(field.getByRole('textbox'), 'A retained correction');
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_terms_save() }));
    await expect(await canvas.findByText(m.catalogue_terms_denied())).toBeVisible();
    expect(field.getByRole('textbox')).toHaveValue('A retained correction');
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_unavailable())).toBeVisible();
    expect(canvas.queryByRole('button', { name: m.catalogue_terms_save() })).toBeNull();
  },
};
