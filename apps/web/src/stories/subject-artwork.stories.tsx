import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { SubjectArtwork, SubjectArtworkBoundary } from '../features/catalogue/subject-artwork/view';
import { ArtworkReaderContext } from '../features/catalogue/subject-artwork/session';
import { SpoilerGate } from '../features/pages/values';
import type { Stmt } from '../features/pages/shared';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { preparedPostReading } from './post-reading-fixtures';

function ArtworkStory({
  state = 'ready',
  suitability = 'show',
  spoiler = false,
}: {
  state?: 'ready' | 'loading' | 'unavailable' | 'unsupported' | 'empty';
  suitability?: 'show' | 'blur';
  spoiler?: boolean;
}) {
  const locale = getLocale();
  const { image } = useMemo(() => preparedPostReading(5), []);
  const source = useMemo(() => ({}), []);
  const statement: Stmt = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
    rank: 'normal',
    property: { id: 'schema:image', data_type: 'media' },
    value: { type: 'value', content: state === 'unsupported' ? 'unsupported-media' : image.id },
    qualifiers: [],
    references: [],
  };
  const title =
    locale === 'ja'
      ? '夕暮れの村を描いた作品の長い原題'.repeat(5)
      : locale === 'zh-Hant'
        ? '描繪黃昏村落的作品原始長標題'.repeat(5)
        : 'Evening in the village';
  const role =
    locale === 'ja'
      ? '原画と挿絵の役割を示す長い説明'.repeat(4)
      : locale === 'zh-Hant'
        ? '原始插畫的用途與角色說明'.repeat(4)
        : 'Illustration';
  const artwork = (
    <SubjectArtwork
      subject={image.containerId}
      statement={statement}
      title={title}
      propertyLabel={role}
      locale={locale}
      suitability={suitability}
    />
  );
  return (
    <ArtworkReaderContext.Provider
      value={{
        incarnation: 1,
        read: async () => {
          if (state === 'loading') return new Promise(() => {});
          return state === 'unavailable' ? { kind: 'unavailable' } : { kind: 'ready', image };
        },
      }}
    >
      <main className="mx-auto min-w-0 max-w-4xl space-y-5 px-4 py-8">
        <h1 className="break-words text-2xl font-semibold">{title}</h1>
        <p>Original subject facts remain readable.</p>
        <SubjectArtworkBoundary source={source} identity={locale} label={title}>
          {state !== 'empty' ? (
            <dl className="min-w-0 space-y-3">
              <dt className="break-words font-medium">{role}</dt>
              <dd>{spoiler ? <SpoilerGate label={m.subject_spoiler_show()}>{artwork}</SpoilerGate> : artwork}</dd>
            </dl>
          ) : null}
        </SubjectArtworkBoundary>
      </main>
    </ArtworkReaderContext.Provider>
  );
}
const meta = {
  title: 'Pages/Catalogue/Subject artwork',
  component: ArtworkStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ArtworkStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const view: Story['play'] = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: m.subject_artwork_view() }));
};
const inspect: Story['play'] = async (context) => {
  await view(context);
  const trigger = await within(context.canvasElement).findByRole('button', { name: m.document_image_inspect() });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  await expect(within(context.canvasElement.ownerDocument.body).getByRole('dialog')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await expect(trigger).toHaveFocus();
};
export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: inspect };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: inspect };
export const DesktopLight: Story = { globals: { viewport: { value: 'desktop1440' }, theme: 'light' }, play: inspect };
export const DesktopDark: Story = { globals: { viewport: { value: 'desktop1440' }, theme: 'dark' }, play: inspect };
export const Japanese: Story = { globals: { locale: 'ja', viewport: { value: 'phone390' } }, play: view };
export const TraditionalChinese: Story = {
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' }, theme: 'dark' },
  play: view,
};
export const Loading: Story = { args: { state: 'loading' }, play: view };
export const Unavailable: Story = { args: { state: 'unavailable' }, play: view };
export const Withheld: Story = { args: { suitability: 'blur', spoiler: true } };
export const Unsupported: Story = { args: { state: 'unsupported' } };
export const Empty: Story = { args: { state: 'empty' } };
