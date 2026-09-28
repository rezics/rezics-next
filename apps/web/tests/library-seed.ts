// Seeds one public Book for the Library e2e into the isolated QA stack the
// e2e harness started: a Work with an English text selected as its Main
// Version, written through the owner commands the Work page seed uses, and
// prints its ID and title. Library needs nothing more to shelve.
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The Library seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory) throw new Error('MAIN_OBJECT_DIRECTORY must name the running Main’s object directory');

const stack = await startMediaStack('library-e2e');
// Owner commands keep revision bytes beside the graph; point them where the running Main reads them.
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const author = await stack.member('library-author');
  const title = `The Lighthouse Keeper’s Almanac ${randomUUID().slice(0, 8)}`;
  const types = ['https://schema.org/Book'];
  const book = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
    author.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
  if (!book.work || !book.mainVersion) throw new Error('Book was not created');
  const text = await stack.contribution(book.work, author.actor, 'en', `${title} in English`);
  const selection = { context: { kind: 'main-version-default' as const, id: book.mainVersion }, work: book.work,
    contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
  const selected = await selectMainDefault(stack.env, stack.admission(author.actor,
    `publication:select:${book.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
  if (selected.outcome !== 'succeeded') throw new Error('Main selection failed');
  console.log(JSON.stringify({ work: book.work, title }));
} finally {
  await stack.stop();
}
