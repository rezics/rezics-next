import { expect, test } from 'bun:test';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { activateTextContribution, textContributionDigest } from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest } from '../../../services/main/src/modules/contribution/publish.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

/**
 * The Work page advertises statements as soon as a recipe is public. That read
 * shares the page's meaning: a healthy Work with nothing accepted answers a
 * complete page, including in the moment before statement seek coverage advances.
 */
async function publishedRecipe(stack: MediaStack, title: string) {
  const author = await stack.member('recipe-author');
  await provisionFixtureAuthor(stack.env, author.actor);
  const semanticTypes = ['https://schema.org/Recipe'];
  const created = await activateMetadataWork(stack.env, {
    title, language: 'en', semanticTypes, authorAgent: author.actor,
    admission: stack.admission(author.actor, 'work:create:root', 'work.create',
      metadataWorkRequestDigest(title, semanticTypes, 'en', { authorAgent: author.actor })),
  });
  const draftInput = {
    work: created.work, language: 'en', body: 'Bright and tender, with a little crunch.',
    actingSubject: author.actor,
  };
  const draft = await activateTextContribution(stack.env, stack.admission(author.actor,
    `contribution:create:${created.work}`, 'contribution.create', textContributionDigest(draftInput)),
  draftInput);
  if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision)
    throw new Error(`draft failed: ${draft.outcome}`);
  const publishInput = {
    contribution: draft.contribution, expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution' as const, disclosure: 'public' as const, actingSubject: author.actor,
  };
  const publication = await publishTextContribution(stack.env, stack.admission(author.actor,
    `contribution:publish:${draft.contribution}`, 'contribution.publish', textPublicationDigest(publishInput)),
  publishInput);
  if (publication.outcome !== 'succeeded' || !publication.publicationDecision)
    throw new Error(`publish failed: ${publication.outcome}`);
  const selection = {
    context: { kind: 'main-version-default' as const, id: created.mainVersion },
    work: created.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: author.actor,
  };
  const selected = await selectMainDefault(stack.env, stack.admission(author.actor,
    `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
  if (selected.outcome !== 'succeeded') throw new Error(`selection failed: ${selected.outcome}`);
  return { author, work: created.work };
}

async function expectCompleteStatements(stack: MediaStack, author: { actor: string; token: string }, work: string) {
  const id = work.slice(-36);
  const query = `actingSubject=${encodeURIComponent(author.actor)}`;
  const readAsAuthor = (path: string) => stack.call('GET', `${path}?${query}`, { token: author.token });
  const pageResponse = await readAsAuthor(`/v1/resources/${id}/page`);
  const pageText = await pageResponse.text();
  expect(pageResponse.status, pageText).toBe(200);
  const page = JSON.parse(pageText) as { sections: { id: string; href: string }[] };
  const section = page.sections.find((item) => item.id === 'statements');
  expect(section?.href).toBe(`/v1/resources/${id}/statements`);
  const read = await readAsAuthor(section!.href);
  const readText = await read.text();
  expect(read.status, readText).toBe(200);
  const statements = JSON.parse(readText) as {
    profile: string; resource: string; nextCursor: string | null;
    groups: { items: unknown[] }[];
    count: { value: number; kind: string; total: null };
  };
  expect(statements).toMatchObject({
    profile: 'subject-statements-v1', resource: work, nextCursor: null,
    count: { kind: 'exact-page', total: null },
  });
  expect(statements.count.value).toBe(statements.groups.reduce((count, group) => count + group.items.length, 0));
}

test('a just-published recipe Work answers a complete statements page', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const stack = await startMediaStack('statements-after-publish');
  try {
    const { author, work } = await publishedRecipe(stack, 'Lemon poppy muffins');
    await expectCompleteStatements(stack, author, work);
  } finally {
    await stack.stop();
  }
}, 180_000);

test('a just-published recipe Work answers statements while raw seek coverage lags an active Global policy', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const stack = await startMediaStack('statements-after-publish-global');
  try {
    await ensureGlobalClassificationContext(stack.env);
    const { author, work } = await publishedRecipe(stack, 'Global lemon muffins');
    await expectCompleteStatements(stack, author, work);
  } finally {
    await stack.stop();
  }
}, 180_000);
