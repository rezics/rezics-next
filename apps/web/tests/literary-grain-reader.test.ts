import { expect, test } from 'bun:test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import {
  literaryGrainExample,
  literaryDefinitions,
  literaryIds,
} from '../src/features/catalogue/literary-reader/examples';
import {
  literaryCompositionCost,
  literaryGrain,
  literaryWindow,
  literaryWindows,
} from '../src/features/catalogue/literary-reader/model';
import { literaryAddress, literaryDestination } from '../src/features/catalogue/literary-reader/navigation';
import { profileRelationWindows } from '../src/features/pages/views';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { defaultReader } from '../src/subject/reader';

const input = literaryGrainExample();
const native = input.windows[0]!;
test('released ancestry and one exact native window retain direction, strings, sources and opaque continuation', () => {
  expect(literaryGrain('bf:Instance', literaryDefinitions)).toBe('edition');
  expect(literaryGrain('schema:BookSeries', literaryDefinitions)).toBe('series');
  expect(literaryGrain('unreleased:Book', literaryDefinitions)).toBeUndefined();
  expect(
    literaryWindows([native, { ...native, node: 'second' }], literaryDefinitions, 'second').map((w) => w.node),
  ).toEqual(['second']);
  const page = literaryWindow(native, literaryIds.series, 'ja', defaultReader);
  expect(page.state).toBe('ready');
  expect(page.rows.map((row) => row.id)).toEqual([literaryIds.member]);
  expect(page.rows[0]!.statement.qualifiers[0]!.value.content).toBe('上巻・02a');
  expect(page.rows[0]!.statement.references[0]!.parts[0]!.value.content).toBe('https://bgm.tv/subject/1');
  const back = literaryAddress({
    id: literaryIds.series,
    label: 'Series',
    locale: 'ja',
    view: 'contents',
    realm: literaryIds.author,
    continuation: { node: native.node, cursor: native.next! },
  });
  expect(subjectVisitReturn(back, 'ja')).toBe(back);
  const destination = new URL(
    literaryDestination(literaryIds.member, 'Member', 'ja', back, literaryIds.author),
    'https://site.test',
  );
  expect(destination.searchParams.get('via')).toBe(back);
  expect(destination.searchParams.get('realm')).toBe(literaryIds.author);
  expect(new URL(back, 'https://site.test').searchParams.get('cursor')).toBe(native.next!);
});

test('preparation, sparse continuation, terminal empty, withholding and currentness failure remain separate', () => {
  const project = (overrides: Partial<typeof native>) =>
    literaryWindow({ ...native, ...overrides }, literaryIds.series, 'en', defaultReader);
  expect(project({ status: 202 }).state).toBe('preparing');
  expect(project({ rows: [], caughtUp: false }).state).toBe('preparing');
  expect(project({ rows: [] }).state).toBe('sparse');
  const { next: _next, ...terminal } = native;
  expect(literaryWindow({ ...terminal, rows: [], complete: true }, literaryIds.series, 'en', defaultReader).state).toBe(
    'empty',
  );
  for (const status of [401, 403]) expect(project({ status }).state).toBe('withheld');
  for (const status of [409, 410, 503]) expect(project({ status }).state).toBe('unavailable');
  expect(project({ limit: 0 }).state).toBe('unavailable');
  expect(project({ limit: 1, rows: [...native.rows, ...native.rows] }).rows).toEqual([]);
  expect(project({ rows: [{ ...(native.rows[0] as object), summary: null }] }).state).toBe('withheld');
  expect(
    project({
      rows: [
        {
          ...(native.rows[0] as object),
          assertion: { ...(native.rows[0] as any).assertion, value: { type: 'value', content: literaryIds.edition } },
        },
      ],
    }).state,
  ).toBe('unavailable');
});

test('64/512/4096 unrelated Subjects and obsolete readings do not enlarge native page composition', () => {
  const document: CompositionDocument = {
    format: 'rezics.composition.v1',
    content: [{ type: 'SubjectList', props: { id: 'members', title: 'Members', property: 'wdt:P179', limit: 12 } }],
  };
  let baseline: ReturnType<typeof literaryCompositionCost> | undefined;
  for (const scale of [64, 512, 4096]) {
    const plan = planReads(platformRegistry, document, { subject: literaryIds.series, account: null });
    const reads: Record<string, { status: number; body: unknown }> = {};
    for (let i = 0; i < scale; i++)
      reads[`unrelated-and-obsolete-${i}`] = { status: 200, body: { links: native.rows } };
    reads[plan.nodes.members!] = {
      status: 200,
      body: { links: native.rows, next: native.next, freshness: { caught_up: true } },
    };
    const selected = literaryWindows(
      profileRelationWindows({ subject: literaryIds.series, document, reads }),
      literaryDefinitions,
    );
    expect(selected[0]!.limit).toBe(12);
    const cost = literaryCompositionCost(
      selected.map((window) => literaryWindow(window, literaryIds.series, 'en', defaultReader)),
    );
    baseline ??= cost;
    expect(cost).toEqual(baseline);
    expect(cost.requests).toBe(0);
    expect(cost.decodedBytes).toBe(0);
    expect(cost.windows).toBe(1);
    expect(cost.rows).toBe(1);
    expect(cost.retainedBytes).toBeGreaterThan(0);
  }
});
