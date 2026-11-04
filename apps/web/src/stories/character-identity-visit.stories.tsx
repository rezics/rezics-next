import type { Meta, StoryObj } from '@storybook/react-vite';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import definitions from '../../../../packages/definitions/release/rezics.json';
import { OverviewContext, type OverviewValue } from '../features/pages/overview';
import { SubjectConnections } from '../features/pages/subject-connections-view';
import type { ConnectionRead } from '../features/pages/subject-connections-window';
import { identityProperty } from '../features/catalogue/character-relationships/reading';
import type { GuideRelease } from '../features/catalogue/definition-guide';
import { qualifiedRelationsPage } from '../kernel/fake/qualified-relations';
import { subjectBody, type SubjectPageData } from '../features/pages/subject';
import { PlainLink } from '../features/pages/shared';
import { connectionStreams } from '../features/pages/subject-connections';

const source = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const parent = '00000000-0000-4000-8000-000000000004';
const release = { ...definitions, digest: `sha256:${'a'.repeat(64)}` } as unknown as GuideRelease;
type Props = { state: 'identity' | 'parent' | 'spoiler' | 'withheld'; locale: 'en' | 'ja' | 'zh-Hant' };

function pageForCharacter(): SubjectPageData {
  const page = qualifiedRelationsPage();
  const reading = subjectBody(page)!;
  page.subject = source;
  Object.assign(reading.subject, { id: source, type: 'wd:Q95074', labels: { en: 'Mina' }, relationCounts: {} });
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'SubjectHeader', props: { id: 'identity' } }],
  };
  page.document = document;
  const plan = planReads(platformRegistry, document, { subject: source, context: page.context! });
  page.reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: reading }]));
  return page;
}

function assertion(id: string, property: string, value: string, spoiler = false) {
  return {
    id,
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: value },
    qualifiers: spoiler
      ? [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: '1', unit: '1' } },
          },
        ]
      : [],
    references: [],
    rezics: { release: release.digest, revision: 7 },
  };
}

const summary = (id: string, label: string) => ({
  id,
  type: 'wd:Q95074',
  types: ['wd:Q95074'],
  label: { value: label, language: 'en' },
  creativeWork: false,
  cover: null,
});

function Visit({ state, locale }: Props) {
  const streams = connectionStreams(release, 'wd:Q95074', source, locale);
  const identity = streams.find((stream) => stream.property === identityProperty && stream.direction === 'out')!;
  const father = streams.find((stream) => stream.property === 'wdt:P22' && stream.direction === 'in')!;
  const selected = state === 'parent' ? father : identity;
  const rows =
    state === 'parent'
      ? [
          {
            subject: parent,
            property: father.property,
            statement: '00000000-0000-4000-8000-000000000005',
            assertion: assertion('00000000-0000-4000-8000-000000000005', father.property, source),
            type: 'wd:Q95074',
            label: 'Mina’s father',
            summary: summary(parent, 'Mina’s father'),
            related: {},
          },
        ]
      : state === 'withheld'
        ? [
            {
              target,
              statement: assertion('00000000-0000-4000-8000-000000000003', identity.property, target),
              summary: null,
              related: {},
            },
          ]
        : [
            {
              target,
              statement: assertion('00000000-0000-4000-8000-000000000003', identity.property, target),
              type: 'wd:Q95074',
              label: 'The long-named traveller / 物語の旅人',
              summary: summary(target, 'The long-named traveller / 物語の旅人'),
              related: { [target]: summary(target, 'The long-named traveller / 物語の旅人') },
            },
            {
              target,
              statement: assertion('00000000-0000-4000-8000-000000000007', identity.property, target),
              type: 'wd:Q95074',
              label: 'The long-named traveller / 物語の旅人',
              summary: summary(target, 'The long-named traveller / 物語の旅人'),
              related: { [target]: summary(target, 'The long-named traveller / 物語の旅人') },
            },
            ...(state === 'spoiler'
              ? [
                  {
                    target: parent,
                    statement: assertion('00000000-0000-4000-8000-000000000006', identity.property, parent, true),
                    type: 'wd:Q95074',
                    label: 'Spoiler-only identity',
                    summary: summary(parent, 'Spoiler-only identity'),
                    related: { [parent]: summary(parent, 'Spoiler-only identity') },
                  },
                ]
              : []),
          ];
  const read: ConnectionRead = async (address) => {
    const stream = state === 'parent' ? father : selected;
    const kind = stream.direction === 'in' ? 'links' : 'relations';
    return {
      ok: true,
      id: source,
      release: release.digest,
      streams,
      sections: {
        relations: {
          stream,
          reading: 'b'.repeat(64),
          section: {
            ok: true,
            read: { kind, id: source, property: stream.property, limit: 12, cursor: 'current-page' },
            body: { [kind]: rows, next: null },
          },
        },
      },
    } as unknown as Awaited<ReturnType<ConnectionRead>>;
  };
  const value = {
    subject: source,
    subjectLabel: 'Mina',
    locale,
    link: PlainLink,
    reader: { spoilerLevel: 0, suitability: 'show' },
    labels: { spoilerHide: 'Hide', cover: {} },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal',
    relations: {},
    sections: {},
  } as unknown as OverviewValue;
  return (
    <main className="mx-auto max-w-5xl bg-background p-4 text-foreground">
      <h1 className="mb-6 text-3xl font-semibold">Mina</h1>
      <OverviewContext.Provider value={value}>
        <SubjectConnections page={pageForCharacter()} viewer={{ state: 'signed-out', csrfToken: null }} read={read} />
      </OverviewContext.Provider>
    </main>
  );
}

const meta = {
  title: 'Pages/Character/Identity and relationships',
  component: Visit,
  args: { state: 'identity', locale: 'en' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Visit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DirectedIdentity: Story = {};
export const IncomingFather: Story = { args: { state: 'parent' } };
export const SpoilerAssociation: Story = { args: { state: 'spoiler' } };
export const WithheldTarget: Story = { args: { state: 'withheld' } };
export const LongJapanese: Story = { args: { locale: 'ja' } };
export const LongTraditionalChinese: Story = { args: { locale: 'zh-Hant' } };
