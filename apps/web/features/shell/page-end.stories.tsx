import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { SubjectSources } from '../entity-page/sources.tsx';
import { AppShell, MAIN_CONTENT_ID } from './app-shell.tsx';
import { messages } from './messages.ts';
import { PageContainer, PageHeader } from './page.tsx';

const record = 'https://example.org/catalogue/records/42';
const license = 'https://creativecommons.org/publicdomain/zero/1.0/';

// Server-selected body and page-end nodes are independent inputs to the real shell.
// Release data selection and the installed router's slot transitions have their own proof.
const meta = {
  title: 'Shell/Page-end composition',
  component: AppShell,
  args: {
    locale: 'en', messages, theme: 'light', navCollapsed: false, account: null,
    children: <PageContainer className="grid max-w-4xl gap-6">
      <PageHeader title="Publication details" description="The publication record and reading notes." />
      <section id="reading-notes" className="grid gap-3">
        <h2 className="font-semibold text-xl">Reading notes</h2>
        <p>The page body keeps its own content and keyboard destination.</p>
        <a href="#reading-notes" className="w-fit text-primary underline">Read the notes</a>
      </section>
    </PageContainer>,
    pageEnd: <PageContainer className="max-w-4xl">
      <SubjectSources locale="en">
        <p>This record includes supplied catalogue information.</p>
        <a href={record} className="block w-fit text-primary underline">Catalogue record</a>
        <a href={license} className="block w-fit text-primary underline">CC0 1.0 license</a>
      </SubjectSources>
    </PageContainer>,
  },
  globals: { viewport: { value: 'desktop1440' } },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

async function verifyPageEnd({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const mains = canvas.getAllByRole('main');
  await expect(mains).toHaveLength(1);
  const main = mains[0]!;
  await expect(main).toHaveAttribute('id', MAIN_CONTENT_ID);
  await expect(main).toHaveAttribute('tabindex', '-1');
  await expect(within(main).getByRole('heading', { level: 1, name: 'Publication details' })).toBeVisible();
  const footers = canvas.getAllByRole('contentinfo', { name: 'Sources and licenses' });
  await expect(footers).toHaveLength(1);
  const footer = footers[0]!;
  await expect(footer.closest('main')).toBeNull();
  await expect(Boolean(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  const sources = within(footer);
  const recordLink = sources.getByRole('link', { name: 'Catalogue record' });
  const licenseLink = sources.getByRole('link', { name: 'CC0 1.0 license' });
  await expect(recordLink).toHaveAttribute('href', record);
  await expect(licenseLink).toHaveAttribute('href', license);

  const skip = canvas.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`);
  await userEvent.tab();
  await expect(skip).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(main).toHaveFocus());
  await userEvent.tab();
  await expect(within(main).getByRole('link', { name: 'Read the notes' })).toHaveFocus();
  await userEvent.tab();
  await expect(recordLink).toHaveFocus();
  await userEvent.tab();
  await expect(licenseLink).toHaveFocus();

  await document.fonts.ready;
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const bottomNavigation = canvasElement.querySelector<HTMLElement>('nav.fixed');
  if (bottomNavigation && getComputedStyle(bottomNavigation).display !== 'none') {
    await expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottomNavigation.getBoundingClientRect().top);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
}

export const DesktopLight: Story = { play: verifyPageEnd };
export const DesktopDark: Story = { args: { theme: 'dark' }, globals: { theme: 'dark' }, play: verifyPageEnd };
export const PhoneLight: Story = { globals: { viewport: { value: 'phone' } }, play: verifyPageEnd };
export const PhoneDark: Story = {
  args: { theme: 'dark' }, globals: { theme: 'dark', viewport: { value: 'phone' } }, play: verifyPageEnd,
};

export const WithoutPageEnd: Story = {
  args: { pageEnd: undefined },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('main')).toHaveLength(1);
    await expect(canvas.getByRole('main')).toHaveAttribute('id', MAIN_CONTENT_ID);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Publication details' })).toBeVisible();
    await expect(canvas.queryByRole('contentinfo')).toBeNull();
  },
};
