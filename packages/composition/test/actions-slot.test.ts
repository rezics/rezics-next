import { expect, test } from 'bun:test';
import {
  SLOT_NAMES,
  platformRegistry,
  templateViews,
  validateProfile,
  type PresentationProfile,
} from '../src/index.ts';

type Node = { type: string; props: Record<string, unknown> };
const isNodes = (value: unknown): value is Node[] =>
  Array.isArray(value) && value.every((item) => typeof item?.type === 'string' && item.props);
function* walk(nodes: readonly Node[]): Generator<Node> {
  for (const node of nodes) {
    yield node;
    for (const value of Object.values(node.props)) if (isNodes(value)) yield* walk(value);
  }
}
const slots = (nodes: readonly Node[], name: string) =>
  [...walk(nodes)].filter((node) => node.type === 'Slot' && node.props.name === name);

test('the site fills one actions slot in every subject page header', async () => {
  expect(SLOT_NAMES).toContain('actions');
  const platform = (await Bun.file(
    new URL('../profiles/platform.json', import.meta.url),
  ).json()) as PresentationProfile;
  expect(validateProfile(platformRegistry, platform)).toEqual([]);
  const subjectPages = [platform.generic, ...platform.bases, ...platform.types].map(
    (entry) => templateViews(entry).overview!,
  );
  expect(subjectPages.length).toBeGreaterThanOrEqual(2);
  for (const document of subjectPages) {
    const content = document.content as Node[];
    expect(slots(content, 'actions')).toHaveLength(1);
    const [header] = slots(content, 'header');
    const inHeader = header!.props.children as Node[];
    expect(inHeader[0]?.type).toBe('SubjectHeader');
    expect(inHeader).toContainEqual({ type: 'Slot', props: { id: 'actions', name: 'actions', children: [] } });
  }
  for (const entry of platform.routes)
    expect(slots(templateViews(entry).overview!.content as Node[], 'actions')).toEqual([]);
});
