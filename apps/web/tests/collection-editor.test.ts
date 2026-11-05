import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildCollectionMemberEditPlan,
  CollectionMemberList,
  CollectionSubjectList,
} from '../src/library/collection-editor';
import { loadCollectionPage, subjectOf, type CollectionMember } from '../src/library/reads';
import recording from '../src/kernel/recorded/library-collection.json';
import memberRecording from '../src/kernel/recorded/library-collection-members.json';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

function attributeText(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[character]!,
  );
}

function actionButton(row: string, name: string) {
  const button = [...row.matchAll(/<button\b[^>]*>/g)].find((match) =>
    match[0].includes(`aria-label="${attributeText(name)}"`),
  )?.[0];
  expect(button).toBeDefined();
  return button!;
}

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

test('Collection editor row actions identify their target for keyboard and screen reader users and preserve actual menu visibility behavior', async () => {
  const previousLocale = getLocale();
  const disclosed = subjectOf(memberRecording.members[0]!.subject)!;
  const members: CollectionMember[] = [
    ...memberRecording.members.slice(0, 2).map((member, index) => ({
      ...member,
      subject: disclosed,
      note: index === 0 ? null : 'An independent occurrence note',
    })),
    { ...memberRecording.members[2]!, subject: null, note: 'Concealed note must stay concealed' },
  ];
  const original = structuredClone(members);
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      for (const ordered of [members, members.toReversed()]) {
        const html = renderToStaticMarkup(
          createElement(CollectionMemberList, {
            members: ordered,
            editing: true,
            firstPage: true,
            selectedIds: new Set([members[1]!.id]),
            onSelectionChange: () => {},
            onMove: () => {},
            onRemove: () => {},
            onCopy: () => {},
          }),
        );
        const rows = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]);
        expect(rows).toHaveLength(ordered.length);
        const names = new Set<string>();
        for (const [index, member] of ordered.entries()) {
          const title = member.subject ? 'Snow Country' : messages.library_subject_unavailable;
          const context = messages.library_member_occurrence
            .replace('{title}', title)
            .replace('{position}', String(index + 1));
          const row = rows[index]!;
          const actions = [
            messages.library_member_move_up,
            messages.library_member_move_down,
            messages.library_member_remove,
            ...(member.subject ? [messages.library_collection_actions] : []),
          ];
          for (const action of actions) {
            const name = `${action}: ${context}`;
            const button = actionButton(row, name);
            expect(button).toContain(`title="${attributeText(name)}"`);
            expect(button).toContain('size-11');
            expect(name).not.toContain(member.id);
            expect(name).not.toContain(member.note ?? 'Concealed note must stay concealed');
            expect(names.has(name)).toBe(false);
            names.add(name);
          }
          const selection = m.library_collection_select_member({ title: context });
          const checkbox = row.match(/<[^>]+role="checkbox"[^>]*>/)?.[0];
          expect(checkbox).toContain(`aria-label="${attributeText(selection)}"`);
          expect(checkbox).toContain(`aria-checked="${member.id === members[1]!.id}"`);
          if (member.subject) {
            expect(row).toContain(`id="collection-member-note-${member.id}"`);
            expect(row).toContain(`aria-label="${attributeText(`${messages.library_member_note}: Snow Country`)}"`);
            expect(row).toContain(member.note ? `>${member.note}</textarea>` : '></textarea>');
          } else {
            expect(row).not.toContain('<textarea');
            expect(row).not.toContain('aria-haspopup="menu"');
          }
        }
        // Opening and visibility transitions are exercised by RowActionContext in the owning story.
        expect(html).not.toContain('role="menu"');
        expect(html).not.toContain('role="dialog"');
        expect(html).not.toContain('Concealed note must stay concealed');
        expect(buildCollectionMemberEditPlan(ordered, ordered, true)).toEqual([]);
      }
    }
    expect(members).toEqual(original);
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});

test('contextual row controls retain first, last and later-page boundaries and pending state', () => {
  const members: CollectionMember[] = memberRecording.members.map((member) => ({
    ...member,
    subject: subjectOf(member.subject),
  }));
  for (const firstPage of [true, false]) {
    for (const busy of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(CollectionMemberList, {
          members,
          editing: true,
          firstPage,
          busy,
          onMove: () => {},
          onRemove: () => {},
        }),
      );
      const rows = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]);
      for (const [index, member] of members.entries()) {
        const context = m.library_member_occurrence({
          title: memberRecording.members[index]!.subject.label.value,
          position: index + 1,
        });
        const up = actionButton(rows[index]!, `${m.library_member_move_up()}: ${context}`);
        const down = actionButton(rows[index]!, `${m.library_member_move_down()}: ${context}`);
        const remove = actionButton(rows[index]!, `${m.library_member_remove()}: ${context}`);
        expect(/\sdisabled=""/.test(up)).toBe(busy || index === 0 || (!firstPage && index === 1));
        expect(/\sdisabled=""/.test(down)).toBe(busy || index === members.length - 1 || (!firstPage && index === 0));
        expect(/\sdisabled=""/.test(remove)).toBe(busy);
        expect(rows[index]).toContain(`id="collection-member-note-${member.id}"`);
      }
    }
  }
  const html = renderToStaticMarkup(
    createElement(CollectionSubjectList, { subjects: members.map((member) => member.subject), onCopy: () => {} }),
  );
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain(m.library_member_remove());
  for (const [index, member] of memberRecording.members.entries()) {
    const context = m.library_member_occurrence({ title: member.subject.label.value, position: index + 1 });
    expect(actionButton(html, `${m.library_collection_actions()}: ${context}`)).toContain('aria-haspopup="menu"');
  }
});
