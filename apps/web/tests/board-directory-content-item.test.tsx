import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import recording from '../src/kernel/recorded/board.json';
import { communitySubject } from '../src/kernel/fake/subject-community';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { BoardDirectory } from '../src/threads/board-directory-view';
import { boardDirectoryRequest, type DirectoryBoard } from '../src/threads/board-directory';

test('ready Board directory rows compose shared ContentItems with separate board and contribution links', () => {
  setLocale('en', { reload: false });
  const board: DirectoryBoard = {
    ...recording.board,
    community: null,
    purpose: 'reviews',
    visibility: 'published',
    availability: 'available',
    title: 'Local history reviews',
  };
  const contribution = { subject: communitySubject.id, subjectTitle: communitySubject.label };
  const html = renderToStaticMarkup(
    createElement(BoardDirectory, {
      request: boardDirectoryRequest({ purpose: 'reviews' }),
      contribution,
      result: { state: 'ready', boards: [board], next: null },
      onRetry: () => {},
    }),
  );

  const headings = [...html.matchAll(/<h2\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gu)];
  expect(headings).toHaveLength(1);
  expect(headings[0]![2]).toBe(board.title);
  expect(html).toContain('data-content-item-slot="metadata"');
  for (const suppliedFact of [m.board_directory_global(), m.board_directory_reviews(), m.board_directory_public()])
    expect(html).toContain(suppliedFact);

  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gu)].map((match) => ({
    markup: match[0],
    href: match[1]!.replaceAll('&amp;', '&'),
  }));
  const primary = links.find(({ href }) => href === `/en/boards/${board.id}`);
  expect(primary).toBeDefined();
  expect(primary!.markup).toContain(`aria-labelledby="${headings[0]![1]}"`);
  expect(primary!.markup).toContain('data-slot="list-row-link"');

  const actionHref =
    `https://site.test/en/boards/${board.id}/new?subject=${encodeURIComponent(contribution.subject)}` +
    `&subjectTitle=${encodeURIComponent(contribution.subjectTitle)}`;
  const action = links.find(({ href }) => href === new URL(actionHref).pathname + new URL(actionHref).search);
  expect(action).toBeDefined();
  expect(action!.markup).toContain(
    `aria-label="${m.board_directory_review_named({ title: board.title!, subject: contribution.subjectTitle })}"`,
  );
  expect(action!.markup).toContain(m.subject_community_review());
});
