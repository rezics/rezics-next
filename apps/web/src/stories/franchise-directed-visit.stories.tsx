import type { Meta, StoryObj } from '@storybook/react-vite';
import { pickText } from '@rezics/composition';
import release from '../../../../packages/definitions/release/rezics.json';
import { OverviewContext, type OverviewValue } from '../features/pages/overview';
import { SubjectConnections } from '../features/pages/subject-connections-view';
import type { ConnectionRead } from '../features/pages/subject-connections-window';
import { qualifiedRelationsPage } from '../kernel/fake/qualified-relations';
import { PlainLink } from '../features/pages/shared';

const source = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const statement = '00000000-0000-4000-8000-000000000003';
const page = { ...qualifiedRelationsPage(), subject: source };
type Props = { state: 'ready' | 'loading' | 'failure' | 'empty' | 'withheld' | 'unavailable' | 'unsupported' | 'spoiler'; locale: 'en' | 'ja' | 'zh-Hant'; inverse: boolean };

/** Native-shaped boundary examples; these do not claim a mounted seed or native engine result. */
function DirectedVisit({ state, locale, inverse }: Props) {
  const property = 'wdt:P144';
  const descriptor = release.properties[property];
  const direction: 'in' | 'out' = inverse ? 'in' : 'out';
  const label = pickText(inverse ? descriptor.relation.inverseLabels : descriptor.labels, locale).text;
  const stream = { key: `${direction}:${property}`, property, direction, group: 'relations' as const, label, forwardLabel: pickText(descriptor.labels, locale).text, language: locale };
  const original = { id: statement, rank: 'normal', property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: inverse ? source : target },
    qualifiers: [
      { property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: '2' } },
      ...(state === 'spoiler' ? [{ property: { id: 'rezics:spoilerLevel', data_type: 'quantity' }, value: { type: 'value', content: { amount: '1', unit: '1' } } }] : []),
    ], references: [], rezics: { release: `sha256:${'a'.repeat(64)}`, revision: 7 } };
  const summary = state === 'withheld' ? null : { id: target, type: 'schema:Book', types: ['schema:Book'],
    label: { value: '海の物語と原作・改編作品の長い題名／跨媒體原作與相關作品的繁體中文長標題', language: locale }, cover: null };
  const row = inverse ? { subject: target, statement, property, assertion: original, summary, related: {} }
    : { target, statement: original, summary, related: {} };
  const read: ConnectionRead = async () => state === 'loading' ? new Promise(() => {}) : ({
    ok: true, id: source, release: `sha256:${'a'.repeat(64)}`, streams: state === 'unsupported' ? [] : [stream],
    sections: state === 'unsupported' ? {} : { relations: {
      stream, reading: 'b'.repeat(64), section: state === 'failure' ? { ok: false, status: 503 }
        : { ok: true, read: { kind: inverse ? 'links' : 'relations', id: source, property, limit: 12 },
          body: { [inverse ? 'links' : 'relations']: state === 'empty' ? [] : [row], next: null } },
    } },
  });
  const value = { subject: source, subjectLabel: '原作ビジュアルノベル／原作視覺小說', locale, link: PlainLink,
    reader: { spoilerLevel: 0, suitability: 'show' }, labels: { spoilerHide: 'Hide', cover: {} },
    unlabelled: 'Unlabelled', spoilerShow: 'Reveal', relations: {}, sections: {},
  } as unknown as OverviewValue;
  return <main className="mx-auto max-w-5xl p-4 text-foreground bg-background">
    <h1 className="mb-6 text-3xl font-semibold">原作ビジュアルノベル／原作視覺小說</h1>
    <OverviewContext.Provider value={value}>
      <SubjectConnections page={page} viewer={{ state: state === 'unavailable' ? 'unavailable' : 'signed-out', csrfToken: null }} read={read} />
    </OverviewContext.Provider>
  </main>;
}

const meta = { title: 'Pages/Work/Directed relations', component: DirectedVisit,
  args: { state: 'ready', locale: 'en', inverse: false },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DirectedVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentOriginal: Story = {};
export const Inverse: Story = { args: { inverse: true } };
export const Loading: Story = { args: { state: 'loading' } };
export const FailedSection: Story = { args: { state: 'failure' } };
export const SupportedEmpty: Story = { args: { state: 'empty' } };
export const Withheld: Story = { args: { state: 'withheld' } };
export const UnavailableCurrentness: Story = { args: { state: 'unavailable' } };
export const Unsupported: Story = { args: { state: 'unsupported' } };
export const Spoiler: Story = { args: { state: 'spoiler' } };
export const LongJapanese: Story = { args: { locale: 'ja' } };
export const LongTraditionalChinese: Story = { args: { locale: 'zh-Hant' } };
