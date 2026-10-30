import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollectionMemberList } from '../src/library/collection-editor';
import { loadCollectionPage, subjectOf, type CollectionMember } from '../src/library/reads';
import recording from '../src/kernel/recorded/library-collection.json';
import memberRecording from '../src/kernel/recorded/library-collection-members.json';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

test('Collection editor note boxes have visible localized Note labels bound to stable occurrence IDs in all eight locales', async () => {
  const previousLocale = getLocale();
  // Duplicate subjects still have separate note editors, even when both notes are empty.
  const members: CollectionMember[] = memberRecording.members.slice(0, 2).map((member) => ({
    ...member,
    note: null,
    subject: subjectOf(memberRecording.members[0]!.subject),
  }));
  try {
    expect(locales).toHaveLength(8);
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      for (const ordered of [members, members.toReversed()]) {
        const html = renderToStaticMarkup(
          createElement(CollectionMemberList, { members: ordered, editing: true, firstPage: true }),
        );
        const labels = [...html.matchAll(/<label\b([^>]*)>([^<]*)<\/label>/g)];
        const notes = [...html.matchAll(/<textarea\b([^>]*)><\/textarea>/g)];
        expect(labels).toHaveLength(ordered.length);
        expect(notes).toHaveLength(ordered.length);
        for (const [index, member] of ordered.entries()) {
          const noteId = `collection-member-note-${member.id}`;
          expect(labels[index]![1]).toContain(`for="${noteId}"`);
          expect(labels[index]![1]).not.toMatch(/sr-only|hidden/);
          expect(labels[index]![2]).toBe(messages.library_member_note);
          expect(notes[index]![1]).toContain(`id="${noteId}"`);
        }
      }
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});

test('the curated compatibility reader distinguishes a preparing response from a ready empty member page', async () => {
  for (const status of [200, 202]) {
    const paths: string[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const path = new URL(new Request(input, init).url).pathname;
        paths.push(path);
        return path.endsWith('/members')
          ? Response.json(status === 202 ? { preparing: true } : { members: [], next: null }, { status })
          : Response.json(recording);
      },
    });
    const page = loadCollectionPage(
      client,
      new Request('https://web.test/collection'),
      {},
      { id: recording.collection.id },
    );
    if (status === 202) {
      await expect(page).rejects.toThrow('Collection preparation requires the dedicated membership reader');
    } else {
      expect((await page).members).toEqual([]);
    }
    expect(paths.sort()).toEqual([
      `/v1/collections/${recording.collection.id}`,
      `/v1/collections/${recording.collection.id}/members`,
    ]);
  }
});
