import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CoverSummary } from '@rezics/ui/cover';
import type { CollectionMember } from '../src/library/reads';
import { CollectionDescriptionReader } from '../src/library/collection-description-reader';
import { m } from '../src/paraglide/messages.js';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const collectionId = id(20);
const subjectId = id(21);
const collectionAddress = `/en/collections/${collectionId}?cursor=${encodeURIComponent('next+/=')}&layout=grid&type=work&f.genre=fiction`;
const cover: CoverSummary = {
  media: 'ranked-cover',
  width: 640,
  height: 960,
  placeholder: { thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j3A', color: '#5a4632' },
  variants: [{ format: 'webp', width: 640 }],
  focalPoint: null,
  credit: null,
};
const subject = { id: subjectId, type: 'work', types: ['work'], label: 'Repeated title', cover };
const members: CollectionMember[] = [
  { id: id(1), note: 'First occurrence note.', addedAt: '2026-10-01T00:00:00Z', subject },
  { id: id(2), note: 'Second occurrence note.', addedAt: '2026-10-02T00:00:00Z', subject },
  {
    id: id(3),
    note: 'Third row note.',
    addedAt: '2026-10-03T00:00:00Z',
    subject: { ...subject, id: id(22), label: 'Later title' },
  },
];

test('ranked public rows keep occurrence order, notes, covers, and exact Collection return locations', () => {
  const description = 'The curator description stays readable above the published rows.';
  const html = renderToStaticMarkup(
    <>
      <CollectionDescriptionReader description={description} />
      <CollectionReadMembers members={members} currentHref={collectionAddress} layout="grid" onCopy={() => {}} />
    </>,
  );

  const renderedIds = [...html.matchAll(/data-collection-member-id="([^"]+)"/g)].map((match) => match[1]);
  expect(renderedIds).toEqual(members.map((member) => member.id));
  expect(html).toContain(description);
  expect(html).toContain('/media/ranked-cover/webp-640');
  const noteOrder = members.map((member) => html.indexOf(member.note!));
  expect(noteOrder.every((position) => position === -1)).toBe(true);
  expect(html.match(/data-collection-detail-opener/g)).toHaveLength(3);
  expect(html).toContain(m.library_collection_position_on_page({ position: 1 }));
  expect(html).toContain(m.library_collection_position_on_page({ position: 2 }));
  expect(html).toContain(m.library_collection_position_on_page({ position: 3 }));

  const subjectLinks = [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1]!.replaceAll('&amp;', '&'))
    .filter((href) => href.includes(`/subjects/${subjectId}/`));
  expect(subjectLinks).toHaveLength(2);
  for (const [index, href] of subjectLinks.entries()) {
    const destination = new URL(href!, 'https://rezics.test');
    const returned = new URL(destination.searchParams.get('via')!, 'https://rezics.test');
    expect(returned.pathname).toBe(`/en/collections/${collectionId}`);
    expect(returned.searchParams.get('cursor')).toBe('next+/=');
    expect(returned.searchParams.get('layout')).toBe('grid');
    expect(returned.searchParams.get('type')).toBe('work');
    expect(returned.searchParams.get('f.genre')).toBe('fiction');
    expect(returned.hash).toBe(`#collection-member-${members[index]!.id}`);
  }
});
