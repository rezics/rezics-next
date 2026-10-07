// Seeds one public Book and one exact edition for the loans journey into the
// QA stack the e2e harness started. The running Main reads the same graph.
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The loans seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory) throw new Error('MAIN_OBJECT_DIRECTORY must name the running Main’s object directory');

const stack = await startMediaStack('library-loans-e2e');
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const editor = await stack.member('library-loans-editor');
  const title = `The Borrowed Atlas ${randomUUID().slice(0, 8)}`;
  const created = await stack.publicWork(editor.actor, ['en'], title);
  await editor.grant(`work:edit:${created.work}`, 'work.edit');
  const release = `https://rezics.com/id/${randomUUID()}`;
  const written = await editor.send('PUT', `/v1/works/${created.work.slice(-36)}/releases/${release.slice(-36)}`, {
    profile: 'release-v1', expectedHead: null, actingSubject: editor.actor, id: release, kind: 'formal',
    status: 'official', contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en',
    tracklistLanguage: null, title: { value: title, language: 'en' }, editionStatement: 'Paperback library edition',
    publisher: null, publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null,
    evidence: null,
  });
  if (written.status !== 200 && written.status !== 202) {
    throw new Error(`Release was not saved (${written.status}): ${await written.text()}`);
  }
  console.log(JSON.stringify({ work: created.work, title, release }));
} finally {
  await stack.stop();
}
