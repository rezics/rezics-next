import type { Meta, StoryObj } from '@storybook/react-vite';
import { pickText, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import release from '../../../../packages/definitions/release/rezics.json';
import { OverviewContext, type OverviewValue } from '../features/pages/overview';
import { SubjectConnections } from '../features/pages/subject-connections-view';
import type { ConnectionRead } from '../features/pages/subject-connections-window';
import { qualifiedRelationsPage } from '../kernel/fake/qualified-relations';
import { PlainLink } from '../features/pages/shared';
import { subjectBody } from '../features/pages/subject';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const page = qualifiedRelationsPage();
const reading = subjectBody(page)!;
page.subject = id(1);
Object.assign(reading.subject, { id: id(1), type: 'wd:Q95074' });
page.document = { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'identity' } }] };
const plan = planReads(platformRegistry, page.document as CompositionDocument, {
  subject: id(1),
  ...(page.context ? { context: page.context } : {}),
});
page.reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: reading }]));
const title = '海の物語と忘れられた街の長い作品名／跨媒體角色登場與原始來源的繁體中文長標題';
const summary = (n: number, label: string, type = 'schema:Book') => ({
  id: id(n),
  label: { value: label, language: 'ja' },
  type,
  types: [type],
  cover: null,
});
const snak = (property: string, content: string) => ({
  property: { id: property, data_type: 'wikibase-item' },
  value: { type: 'value', content },
});
function CharacterVisit({ locale, failed, paged }: { locale: 'en' | 'ja' | 'zh-Hant'; failed: boolean; paged: boolean }) {
  const streams = (['schema:character', 'wdt:P725'] as const).map((property, index) => ({
    key: `in:${property}${index ? ':qualified' : ''}`,
    property,
    direction: 'in' as const,
    group: index ? ('credits' as const) : ('characters' as const),
    label: pickText(release.properties[property].relation.inverseLabels, locale).text,
    forwardLabel: pickText(release.properties[property].labels, locale).text,
    language: locale,
    ...(index ? { filter: id(1) } : {}),
  }));
  const read: ConnectionRead = async (address) => {
    const allSections = Object.fromEntries(
      streams.map((stream, index) => [
        stream.group,
        {
          stream,
          reading: 'a'.repeat(64),
          section:
            failed && index
              ? { ok: false, status: 503 }
              : {
                  ok: true,
                  read: { kind: 'links', id: id(1), property: stream.property, limit: 12 },
                  body: {
                    links: (paged && stream.group === 'characters'
                      ? address.selection?.characters?.cursor === 'appearance-page-3'
                        ? []
                        : address.selection?.characters?.cursor === 'appearance-page-2'
                          ? [3]
                          : [0, 1, 2]
                      : [0, 1, 2]).map((row) => ({
                      subject: id(2),
                      property: stream.property,
                      statement: id(10 + index * 10 + row),
                      summary: row === 2 ? null : summary(2, title),
                      assertion: {
                        ...snak(stream.property, index ? id(4) : id(1)),
                        id: id(10 + index * 10 + row),
                        rank: 'normal',
                        qualifiers: [
                          snak(index ? 'schema:character' : 'wdt:P3831', index ? id(1) : id(3)),
                          ...(row
                            ? [
                                {
                                  property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
                                  value: { type: 'value', content: { amount: '1', unit: '1' } },
                                },
                              ]
                            : []),
                        ],
                        references: [
                          {
                            parts: [
                              {
                                property: { id: 'schema:url', data_type: 'url' },
                                value: { type: 'value', content: 'https://example.org/original' },
                              },
                            ],
                          },
                        ],
                        rezics: { revision: 1, release: 'example' },
                      },
                      related: {
                        [id(3)]: summary(3, '主人公／主角'),
                        [id(4)]: summary(4, '声の出演者／配音演員', 'schema:Person'),
                      },
                    })),
                    next:
                      paged && stream.group === 'characters'
                        ? address.selection?.characters?.cursor === 'appearance-page-3'
                          ? null
                          : address.selection?.characters?.cursor === 'appearance-page-2'
                            ? 'appearance-page-3'
                            : 'appearance-page-2'
                        : 'opaque-next',
                  },
                },
        },
      ]),
    );
    return {
      ok: true,
      id: id(1),
      release: 'example',
      streams,
      sections: address.only ? { [address.only]: allSections[address.only] } : allSections,
    };
  };
  const value = {
    subject: id(1),
    subjectLabel: '長い名前の登場人物／角色的長名字',
    locale,
    link: PlainLink,
    reader: { spoilerLevel: 0, suitability: 'show' },
    labels: { cover: {}, spoilerHide: 'Hide' },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal',
    relations: {},
    sections: {},
  } as unknown as OverviewValue;
  return (
    <main className="mx-auto max-w-5xl space-y-6 bg-background p-4 text-foreground">
      <h1 className="text-3xl font-semibold">{value.subjectLabel}</h1>
      <OverviewContext.Provider value={value}>
        <SubjectConnections page={page} viewer={{ state: 'signed-out', csrfToken: null }} read={read} />
      </OverviewContext.Provider>
    </main>
  );
}
const meta = {
  title: 'Pages/Character/Work appearances',
  component: CharacterVisit,
  args: { locale: 'en', failed: false, paged: false },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CharacterVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Current rows, distinct assertions to one work, withheld association and per-assertion spoiler. */
export const CurrentWindow: Story = {};
export const IndependentCreditFailure: Story = { args: { failed: true } };
/** The selected appearance stream exposes Previous, Next, page status and an empty terminal page. */
export const BoundedPages: Story = { args: { paged: true } };
export const LongJapanese: Story = { args: { locale: 'ja' } };
export const LongChinese: Story = { args: { locale: 'zh-Hant' } };
