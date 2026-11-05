import { expect, test } from 'bun:test';
import type {
  ConnectionAddress,
  ConnectionGroup,
  ConnectionSection,
  ConnectionVisit,
  ConnectionStream,
} from '../src/features/pages/subject-connections';
import {
  createConnectionWindow,
  CONNECTION_HISTORY_LIMIT,
  type ConnectionRead,
} from '../src/features/pages/subject-connections-window';

const id = '00000000-0000-4000-8000-000000000001';
const streams: ConnectionStream[] = [
  {
    key: 'out:wdt:P144',
    property: 'wdt:P144',
    direction: 'out',
    group: 'relations',
    label: 'Part of',
    forwardLabel: 'Part of',
    language: 'en',
  },
  {
    key: 'out:wdt:P50',
    property: 'wdt:P50',
    direction: 'out',
    group: 'credits',
    label: 'Author',
    forwardLabel: 'Author',
    language: 'en',
  },
  {
    key: 'out:wdt:P136',
    property: 'wdt:P136',
    direction: 'out',
    group: 'relations',
    label: 'Genre',
    forwardLabel: 'Genre',
    language: 'en',
  },
];
const address = { id, locale: 'en' };
const hash = (page: number) => page.toString(16).padStart(2, '0').repeat(32);

function makeSection(
  stream: ConnectionStream,
  page: number,
  fetch: number,
  next?: string,
  status?: number,
): ConnectionSection {
  return {
    stream,
    ...(!status ? { reading: hash(page) } : {}),
    section: status
      ? { ok: false, status }
      : {
          ok: true,
          read: {
            kind: stream.direction === 'in' ? 'links' : 'relations',
            id,
            property: stream.property,
            limit: 12,
            ...(page > 1 ? { cursor: `${stream.key}-page-${page}` } : {}),
          },
          body: {
            [stream.direction === 'in' ? 'links' : 'relations']:
              page === 3 ? [] : [{ marker: `${stream.key}-page-${page}-fetch-${fetch}` }],
            ...(next ? { next } : {}),
          },
        },
  } as ConnectionSection;
}

test('Previous refetches under the retained reading, retries the failed address, and preserves sibling groups', async () => {
  const calls: ConnectionAddress[] = [];
  let failPrevious = true;
  const read: ConnectionRead = async (request) => {
    calls.push(request);
    const groups = request.only ? [request.only] : (['relations', 'credits'] as ConnectionGroup[]);
    const sections = Object.fromEntries(
      groups.map((group) => {
        const selection = request.selection?.[group];
        const stream =
          streams.find((choice) => choice.key === selection?.stream) ??
          streams.find((choice) => choice.group === group)!;
        const page = selection?.cursor?.endsWith('page-2') ? 2 : selection?.cursor?.endsWith('page-3') ? 3 : 1;
        const next =
          (group === 'relations' && page < 3) || (group === 'credits' && page === 1)
            ? `${stream.key}-page-${page + 1}`
            : undefined;
        const status =
          failPrevious && calls.length > 3 && group === 'relations' && selection?.cursor?.endsWith('page-2')
            ? 403
            : undefined;
        if (status) failPrevious = false;
        return [group, makeSection(stream, page, calls.length, next, status)];
      }),
    ) as Partial<Record<ConnectionGroup, ConnectionSection>>;
    return { ok: true, id, release: 'release', streams, sections };
  };
  const window = createConnectionWindow(address, read);
  await window.load();
  const creditBefore = window.snapshot().visit?.sections.credits;
  await window.next('relations');
  await window.next('relations');
  expect(window.snapshot().visit?.sections.relations?.section).toMatchObject({ ok: true, body: { relations: [] } });
  expect(window.snapshot().pages?.relations).toMatchObject({ page: 3, index: 2 });
  const attempted = window.previous('relations');
  expect(window.snapshot().visit?.sections.relations).toBeUndefined();
  await attempted;
  expect(window.snapshot().pages?.relations).toMatchObject({ page: 3, index: 2 });
  expect(window.snapshot().visit?.sections.relations?.section).toMatchObject({ ok: false, status: 403 });
  expect(window.snapshot().visit?.sections.credits).toBe(creditBefore);
  await window.retry('relations');
  expect(calls.at(-1)?.selection?.relations).toEqual({
    stream: streams[0]!.key,
    cursor: `${streams[0]!.key}-page-2`,
    reading: hash(2),
  });
  expect(window.snapshot().pages?.relations).toMatchObject({ page: 2, index: 1 });
  expect(window.snapshot().visit?.sections.relations?.section).toMatchObject({
    ok: true,
    body: { relations: [{ marker: `${streams[0]!.key}-page-2-fetch-${calls.length}` }] },
  });
  await window.next('credits');
  expect(calls.at(-1)?.only).toBe('credits');
  expect(window.snapshot().visit?.sections.relations?.stream.key).toBe(streams[0]!.key);
  window.retire();
});

test('history is capped, stream selection restarts at its first page, and boundary restart is explicit', async () => {
  const calls: ConnectionAddress[] = [];
  const read: ConnectionRead = async (request) => {
    calls.push(request);
    const groups = request.only ? [request.only] : ['relations'];
    const sections = Object.fromEntries(
      groups.map((group) => {
        const selection = request.selection?.[group];
        const stream = streams.find((choice) => choice.key === selection?.stream) ?? streams[0]!;
        const cursorPage = Number(/page-(\d+)$/.exec(selection?.cursor ?? '')?.[1] ?? 1);
        const next = cursorPage < 20 ? `${stream.key}-page-${cursorPage + 1}` : undefined;
        return [group, makeSection(stream, cursorPage, calls.length, next)];
      }),
    ) as Partial<Record<ConnectionGroup, ConnectionSection>>;
    return { ok: true, id, release: 'release', streams, sections };
  };
  const window = createConnectionWindow(address, read);
  await window.load();
  for (let page = 2; page <= CONNECTION_HISTORY_LIMIT + 2; page++) await window.next('relations');
  expect(window.snapshot().pages?.relations?.history).toHaveLength(CONNECTION_HISTORY_LIMIT);
  expect(window.snapshot().pages?.relations).toMatchObject({
    page: CONNECTION_HISTORY_LIMIT + 2,
    index: CONNECTION_HISTORY_LIMIT - 1,
  });
  while (window.snapshot().pages?.relations?.index) await window.previous('relations');
  expect(window.snapshot().pages?.relations).toMatchObject({ page: 3, index: 0 });
  const beforeBoundary = calls.length;
  await window.previous('relations');
  expect(calls).toHaveLength(beforeBoundary);
  await window.restartGroup('relations');
  expect(calls.at(-1)?.selection?.relations).toEqual({ stream: streams[0]!.key });
  expect(window.snapshot().pages?.relations).toMatchObject({ page: 1, index: 0, history: [{ page: 1 }] });
  const alternate = streams[2]!;
  await window.load('relations', { stream: alternate.key });
  expect(calls.at(-1)?.selection?.relations).toEqual({ stream: alternate.key });
  expect(window.snapshot().visit?.sections.relations?.stream.key).toBe(alternate.key);
  expect(window.snapshot().pages?.relations).toMatchObject({ stream: alternate.key, page: 1, index: 0 });
  window.retire();
});
