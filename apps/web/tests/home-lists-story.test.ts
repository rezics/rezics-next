import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { slug } from '@rezics/definitions/slug';
import { createRecordedKernelFetch, type KernelRecording } from '../src/kernel/fake.ts';
import home from '../src/kernel/recorded/home-page.json';
import { loadRoutePage, RoutePage } from '../src/features/pages/route.tsx';

type Node = { type: string; props: { id: string; [key: string]: unknown } };
type Hit = { id: string; type: string; labels: Record<string, string> };
type Read = { status: number; body: { subjects?: Hit[] } };
const recorded = home as unknown as { status: number; document: { content: Node[] }; reads: Record<string, Read> };
const messages = {
  unknown: '不明',
  none: 'なし',
  unlabelled: '名称未設定',
  sources: '出典',
  aliases: '別名',
  search: '検索',
};

test('the recorded home answers every vertical list with indexed subjects', async () => {
  expect(recorded.status).toBe(200);
  const content = recorded.document.content;
  expect(content[0]).toMatchObject({ type: 'Heading', props: { id: 'heading', level: 1 } });
  expect(content).toContainEqual({ type: 'Slot', props: { id: 'personal', name: 'personal', children: [] } });
  const lists = content.filter(({ type }) => type === 'TypeList').map(({ props }) => props.types as string[]);
  expect(lists).toHaveLength(4);

  const reads = Object.values(recorded.reads);
  expect(reads).toHaveLength(4);
  const hits: Hit[] = [];
  for (const read of reads) {
    expect(read.status).toBe(200);
    const subjects = read.body.subjects ?? [];
    expect(subjects.length).toBeGreaterThanOrEqual(2);
    expect(lists.some((types) => subjects.every((hit) => types.includes(hit.type)))).toBe(true);
    hits.push(...subjects);
  }
  for (const types of lists) expect(hits.some((hit) => types.includes(hit.type))).toBe(true);
  expect(new Set(hits.map(({ id }) => id)).size).toBe(hits.length);

  const client = createKernelClient('https://kernel.invalid', {
    fetch: createRecordedKernelFetch({ 'home-page': home as KernelRecording }),
  });
  const loaded = await loadRoutePage(client, '/');
  if (loaded.kind !== 'page') throw new Error('expected the recorded home');
  const html = renderToString(
    createElement(RoutePage, { page: loaded.page, locale: 'ja', heading: 'ホーム', messages }),
  );
  expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  expect(html.match(/<h2[\s>]/g)).toHaveLength(4);
  for (const hit of hits) {
    expect(hit.labels.en?.length).toBeGreaterThan(0);
    expect(hit.labels.ja?.length).toBeGreaterThan(0);
    expect(html).toContain(`href="/ja/subjects/${hit.id}/${slug(hit.labels.ja!)}"`);
    expect(html).toContain(hit.labels.ja!);
  }
});
