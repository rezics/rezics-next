import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { localeNames, uiLocales, type UiLocale } from '../../i18n/define.ts';
import { attributed, ccBySa, creditedOnly, distinctMaterials, instrumentOnly, knownCoverCredit, mixedScriptCoverCredit, sourceUrl, unassessed, unknownCoverCredit } from './fixtures.ts';
import { messages } from './messages.ts';
import { CoverCreditMark, RightsMark, RightsRunRows, type DisplayObligations } from './rights-mark.tsx';

function Pad({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-4 py-6">{children}</div>;
}

const row = (id: string, text: string, rights: DisplayObligations) => ({ id, rights, children: text });
const sameRun = [
  row('born', 'Born in 2008', attributed),
  row('also', 'Also known as the Black Swordsman', attributed),
  row('member', 'Member of the Knights', attributed),
];

const noOverflow = async () => {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

const meta = { title: 'Rights mark/Mark', component: RightsMark } satisfies Meta<typeof RightsMark>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CoverCredits: Story = {
  args: { rights: unassessed },
  render: () => <Pad><div className="grid max-w-sm gap-5">
    <div><p className="font-medium text-sm">Known holder</p><CoverCreditMark credit={knownCoverCredit} /></div>
    <div><p className="font-medium text-sm">Unknown holder</p><CoverCreditMark credit={unknownCoverCredit} /></div>
    <div><p className="font-medium text-sm">Generated cover</p><CoverCreditMark credit={null} /></div>
  </div></Pad>,
  async play({ canvasElement }) {
    await document.fonts.ready;
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelectorAll('[data-cover-credit]')).toHaveLength(2);
    await expect(canvas.getByText(knownCoverCredit.text)).toBeVisible();
    await expect(canvas.getByText(unknownCoverCredit.text)).toBeVisible();
    const sources = canvas.getAllByRole('link', { name: knownCoverCredit.source.name });
    await expect(sources).toHaveLength(2);
    for (const source of sources) {
      await expect(source).toBeVisible();
      await expect(source).toHaveAttribute('href', knownCoverCredit.source.href);
      await expect(source.closest('[aria-hidden="true"]')).toBeNull();
    }
    await expect(canvasElement.querySelector('[data-rights-mark]')).toBeNull();
  },
};

export const CoverCreditLocales: Story = {
  args: { rights: unassessed },
  render: () => <Pad><div className="grid max-w-sm gap-5">
    {uiLocales.map(locale => <div key={locale} className="min-w-0">
      <p className="font-medium text-sm">{localeNames[locale]}</p>
      <CoverCreditMark credit={knownCoverCredit} locale={locale} />
    </div>)}
  </div></Pad>,
  async play({ canvasElement }) {
    const credits = [...canvasElement.querySelectorAll('[data-cover-credit]')];
    await expect(credits).toHaveLength(uiLocales.length);
    for (const [index, locale] of uiLocales.entries()) {
      await expect(credits[index]).toHaveTextContent(messages[locale].coverCredit.trim());
      await expect(credits[index]).toHaveTextContent(messages[locale].source.trim());
    }
    for (const source of within(canvasElement).getAllByRole('link', { name: knownCoverCredit.source.name })) {
      await expect(source).toBeVisible();
    }
    for (const text of canvasElement.querySelectorAll('[data-cover-credit] bdi, [data-cover-credit] a')) {
      const bounds = text.getBoundingClientRect();
      await expect(bounds.width).toBeGreaterThan(0);
      await expect(bounds.height).toBeGreaterThan(0);
    }
    await document.fonts.ready;
  },
};

export const CoverCreditLocalesPhone: Story = {
  ...CoverCreditLocales,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await CoverCreditLocales.play!(context);
    await noOverflow();
  },
};

export const CoverCreditMixedScriptsPhone: Story = {
  args: { rights: unassessed },
  globals: { viewport: { value: 'phone' } },
  render: () => <Pad><div dir="rtl" className="w-40">
    <CoverCreditMark credit={mixedScriptCoverCredit} locale="fr" />
  </div></Pad>,
  async play({ canvasElement }) {
    await document.fonts.ready;
    const canvas = within(canvasElement);
    await expect(canvas.getByText(mixedScriptCoverCredit.text)).toBeVisible();
    await expect(canvas.getByRole('link', { name: mixedScriptCoverCredit.source.name })).toHaveAttribute('href', mixedScriptCoverCredit.source.href);
    for (const text of canvasElement.querySelectorAll('bdi')) await expect(text).toHaveAttribute('dir', 'auto');
    await noOverflow();
  },
};

export const AttributionAndShareAlike: Story = {
  args: { rights: attributed, locale: 'en' },
  render: args => <Pad><RightsMark {...args} /></Pad>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Example' })).toHaveAttribute('href', sourceUrl);
    await expect(canvas.queryByRole('link', { name: sourceUrl })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'CC BY-SA 3.0' })).toHaveAttribute('href', ccBySa);
    await expect(canvas.getByText(/Adaptations stay under the same terms/)).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
  },
};

export const AttributionAndShareAlikePhone: Story = {
  ...AttributionAndShareAlike,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await AttributionAndShareAlike.play!(context);
    await noOverflow();
  },
};

export const InstrumentOnly: Story = {
  args: { rights: instrumentOnly, locale: 'en' },
  render: args => <Pad><RightsMark {...args} /></Pad>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'CC BY-SA 3.0' })).toBeVisible();
    await expect(canvas.queryByText(/Adaptations stay/)).toBeNull();
    await expect(canvas.queryByText(/Source:/)).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
  },
};

export const InstrumentOnlyPhone: Story = {
  ...InstrumentOnly,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await InstrumentOnly.play!(context);
    await noOverflow();
  },
};

export const Unassessed: Story = {
  args: { rights: unassessed, locale: 'en' },
  render: args => <Pad>
    <p>A surveyor maps a delta that redraws itself with every tide.</p>
    <RightsMark {...args} />
  </Pad>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/surveyor maps a delta/)).toBeVisible();
    await expect(canvasElement.querySelector('[data-rights-mark]')).toBeNull();
    await expect(within(canvasElement).queryByRole('link')).toBeNull();
  },
};

export const IdenticalRightsRun: Story = {
  args: { rights: attributed },
  render: () => <Pad><RightsRunRows rows={sameRun} locale="en" /></Pad>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Born in 2008')).toBeVisible();
    await expect(canvas.getByText('Also known as the Black Swordsman')).toBeVisible();
    await expect(canvas.getByText('Member of the Knights')).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('[data-rights-run]')).toHaveLength(1);
    await expect(canvasElement.querySelector('[data-rights-mark]')).not.toHaveAttribute('data-rights-material');
    await expect(canvasElement.querySelector('[data-rights-mark]')).not.toHaveAttribute('data-source-key');
  },
};

export const IdenticalRightsRunPhone: Story = {
  ...IdenticalRightsRun,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await IdenticalRightsRun.play!(context);
    await noOverflow();
  },
};

export const RecordedSourceIdentities: Story = {
  args: { rights: unassessed },
  render: () => <Pad><div className="grid gap-5">
    <RightsRunRows rows={distinctMaterials.map((rights, index) =>
      row(`material-${index}`, ['Catalogue facts', 'Synopsis', 'Synopsis without a recorded Source'][index]!, rights))} />
    <CoverCreditMark credit={knownCoverCredit} />
    <CoverCreditMark credit={{ ...unknownCoverCredit,
      source: { name: unknownCoverCredit.source.name, href: unknownCoverCredit.source.href } }} />
  </div></Pad>,
  async play({ canvasElement }) {
    const marks = [...canvasElement.querySelectorAll<HTMLElement>('[data-rights-mark]')];
    await expect(canvasElement.querySelectorAll('[data-rights-run]')).toHaveLength(3);
    await expect(marks).toHaveLength(3);
    for (const [index, rights] of distinctMaterials.entries()) {
      const identity = rights.identity;
      await expect(marks[index]).toHaveAttribute('data-rights-assessment', identity.assessmentId);
      await expect(marks[index]).toHaveAttribute('data-rights-material', identity.materialId);
      await expect(marks[index]).toHaveAttribute('data-rights-component', identity.component);
      if (identity.sourceRecordId) {
        await expect(marks[index]).toHaveAttribute('data-source-key', `https://rezics.com/id/${identity.sourceRecordId}`);
        await expect(marks[index]).toHaveAttribute('data-source-record', identity.sourceRecordId);
      } else {
        await expect(marks[index]).not.toHaveAttribute('data-source-key');
        await expect(marks[index]).not.toHaveAttribute('data-source-record');
      }
      if (identity.wikiEvidenceId) await expect(marks[index]).toHaveAttribute('data-source-evidence', identity.wikiEvidenceId);
      else await expect(marks[index]).not.toHaveAttribute('data-source-evidence');
      await expect(within(marks[index]!).getByRole('link', { name: 'CC BY-SA 3.0' })).toBeVisible();
    }
    const credits = [...canvasElement.querySelectorAll('[data-cover-credit]')];
    await expect(credits).toHaveLength(2);
    const source = knownCoverCredit.source.identity!;
    await expect(credits[0]).toHaveAttribute('data-source-key', source.record);
    await expect(credits[0]).toHaveAttribute('data-source-record', source.record);
    await expect(credits[0]).toHaveAttribute('data-source-observation', source.observation);
    if (source.component === null) await expect(credits[0]).not.toHaveAttribute('data-source-component');
    else await expect(credits[0]).toHaveAttribute('data-source-component', source.component);
    await expect(credits[0]).toHaveAttribute('data-source-locator', source.fieldLocator);
    await expect(credits[1]).not.toHaveAttribute('data-source-key');
    await expect(credits[1]).not.toHaveAttribute('data-source-observation');
    await expect(credits[1]).not.toHaveAttribute('data-source-locator');
    await expect(canvasElement.querySelector('a[href^="https://rezics.com/id/"]')).toBeNull();
    await noOverflow();
  },
};

export const RecordedSourceIdentitiesPhone: Story = {
  ...RecordedSourceIdentities,
  globals: { viewport: { value: 'phone' } },
};

function LocaleList({ locale }: { locale?: UiLocale }) {
  const shown = locale ? [locale] : uiLocales;
  return <Pad>
    <div className="grid gap-5">
      {shown.map(item => <div key={item} className="grid min-w-0 gap-1">
        <p className="font-medium text-sm">{localeNames[item]}</p>
        <RightsMark rights={attributed} locale={item} />
      </div>)}
    </div>
  </Pad>;
}

export const Locales: Story = {
  args: { rights: attributed },
  render: () => <LocaleList />,
  async play({ canvasElement }) {
    const marks = [...canvasElement.querySelectorAll('[data-rights-mark]')];
    await expect(marks).toHaveLength(uiLocales.length);
    for (const [index, locale] of uiLocales.entries()) {
      const text = marks[index]?.textContent ?? '';
      await expect(text).toContain(messages[locale].source.trim());
      await expect(text).toContain(messages[locale].shareAlike);
    }
  },
};

export const LocalesPhone: Story = {
  ...Locales,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await Locales.play!(context);
    await noOverflow();
  },
};

/** Two runs, so a change of rights starts a new mark instead of repeating one on every row. */
export const SplitRightsRun: Story = {
  args: { rights: attributed },
  render: () => <Pad><RightsRunRows locale="en" rows={[
    ...sameRun,
    row('title', 'Original title', creditedOnly),
    row('year', 'First published in 2012', creditedOnly),
  ]} /></Pad>,
  async play({ canvasElement }) {
    await expect(canvasElement.querySelectorAll('[data-rights-run]')).toHaveLength(2);
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(2);
    await expect(within(canvasElement).getByRole('link', { name: 'Example' })).toBeVisible();
    await expect(within(canvasElement).getByRole('link', { name: 'Archive' })).toBeVisible();
    await expect(within(canvasElement).getByRole('link', { name: 'CC BY 4.0' })).toBeVisible();
  },
};
