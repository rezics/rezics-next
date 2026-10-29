import { test } from 'bun:test';
import { createContentUserCasesDriver } from './user-cases-driver.ts';

test('diagnose native user case thread fixture response', async () => {
  const driver = await createContentUserCasesDriver();
  try {
    const fixture = await driver.provision();
    const board = await driver.createBoard('published', {
      actor: fixture.moderator,
      key: JSON.stringify('diagnostic-board'),
    });
    if (!board.value)
      throw new Error(`Board response ${board.response.status}: ${await board.response.clone().text()}`);
    const thread = await driver.createThread(
      {
        boardId: board.value.id,
        title: 'Controlled diagnostic thread',
        kind: 'discussion',
        subjectIds: [fixture.subjectId],
        body: {
          version: 'rezics-document-v1',
          profile: 'blocks',
          doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Diagnostic' }] }] },
        },
        licence: 'MIT',
        visibility: 'published',
      },
      { actor: fixture.reader, key: JSON.stringify('diagnostic-thread') },
    );
    if (thread.response.status !== 201)
      throw new Error(`Thread response ${thread.response.status}: ${await thread.response.clone().text()}`);
  } finally {
    await driver.close();
  }
});
