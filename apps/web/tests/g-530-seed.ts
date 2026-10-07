// Seeds the G-530 records into the isolated QA stack the e2e harness started and prints their IDs as JSON: two public
// Books the reader shelves, and four public Works classified under Fantasy, Magic and Romance with the discovery
// generation the Concept page reads (Fantasy+Magic, Fantasy+Romance, Magic only, Fantasy only). Everything else the
// journey needs (the writer, the book, the chapter and the cover) the browser creates through Main as a person would.
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startHomeStack } from '../../../tests/qa/integration/feed-read-support.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-530 seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory) throw new Error('MAIN_OBJECT_DIRECTORY must name the running Main’s object directory');

const home = await startHomeStack('g530-e2e');
const { stack, author, json } = home;
// Owner commands keep revision bytes beside the graph; point them where the running Main reads them.
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const app = createMainApp(stack.fuseki, { ...home.deps, discovery: new DiscoveryProjection(stack.accessPool),
    platformAccess: new AccessExposure(stack.accessPool),
    judgments: new AccessJudgments(stack.accessPool), statementSeek: stack.statementSeek });
  const call = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`,
    { method, headers: { ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      authorization: `Bearer ${author.token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }));

  // Two Books the reader shelves, one per device size, each with an English text selected as its Main Version.
  const books: { work: string; title: string }[] = [];
  for (const index of [1, 2]) {
    const title = `The Lighthouse Keeper’s Almanac ${index} ${randomUUID().slice(0, 8)}`;
    const types = ['https://schema.org/Book'];
    const book = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
      author.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    const text = await stack.contribution(book.work, author.actor, 'en', `${title} in English`);
    const selection = { context: { kind: 'main-version-default' as const, id: book.mainVersion }, work: book.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
    const selected = await selectMainDefault(stack.env, stack.admission(author.actor,
      `publication:select:${book.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
    if (selected.outcome !== 'succeeded') throw new Error('Main selection failed');
    books.push({ work: book.work, title });
  }

  // Four Works under Concepts, then the discovery generation the Concept page lists them from.
  await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
  const platformGrant = randomUUID();
  await stack.accessPool.query(`INSERT INTO access.principal_permission_grant
    (id,issuer_subject,principal_id,scope_id,action,valid_until)
    VALUES ($1,$2,$3,'platform:access','platform:use:platform-admin',now()+interval '1 hour')`,
  [platformGrant,author.actor,author.principalId]);
  await stack.accessPool.query(`INSERT INTO access.platform_grant_episode
    (id,principal_grant_id,issuer_subject,permission,scope_id,assigned_by_principal,receipt)
    VALUES ($1,$2,$3,'platform:use:platform-admin','platform:access',$4,$5)`,
  [randomUUID(),platformGrant,author.actor,author.principalId,`urn:rezics:access-receipt:${platformGrant}`]);
  await author.grant('classification:define:global', 'classification.proposition.define');
  await author.grant('classification:decide:global', 'statement.decide');
  await author.grant(`statement:speak:${author.actor}`, 'statement.record');
  await author.grant('context:create:root','context.create');
  const run = randomUUID().slice(0, 8);
  const works: { work: string; mainVersion: string; title: string }[] = [];
  for (const index of [1, 2, 3, 4]) {
    const work = await stack.publicWork(author.actor, ['en'], `Concept Work ${index} ${run}`);
    works.push({ work: work.work, mainVersion: work.mainVersion, title: work.title });
  }
  const define = async (label: string) => {
    const term = await json<{concept: string;sense: string;definitionRevision: string}>(await call('POST',
      '/v1/classification-propositions',{profile: 'classification-proposition-v1',label: `${label} ${run}`,
        actingSubject: author.actor}),201);
    await json(await call('POST',`/v1/concepts/${term.concept.slice(-36)}/spoiler-hints`,{
      profile: 'concept-spoiler-hint-v1',context: {kind: 'global'},hint: 'not-spoiler',
      expectedGeneration: '0',actingSubject: author.actor}),201);
    const interpretation = await json<{context: string;semanticRevision: string}>(await call('POST','/v1/contexts',{
      profile: 'context-v1',role: 'shared',disclosure: 'public',base: null,
      entries: [{target: term.concept,relation: 'https://rezics.com/vocab/classifiedAs',state: 'defined',
        definition: term.definitionRevision,applicability: []}],actingSubject: author.actor}),201);
    return {...term,interpretation};
  };
  const fantasy = await define('Fantasy'), magic = await define('Magic'), romance = await define('Romance');
  const accept = async (work: typeof works[number],term: Awaited<ReturnType<typeof define>>) => {
    const statement = await json<{statement: string;meaningKey: string}>(await call('POST','/v1/statements',{
      profile: 'statement-v1',speaker: {kind: 'personal'},subject: work.mainVersion,predicate: 'https://rezics.com/vocab/classifiedAs',
      relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,value: {kind: 'resource',iri: term.concept},
      applicability: [],interpretation: {kind: 'explicit',context: term.interpretation.context,
        semanticRevision: term.interpretation.semanticRevision},evidence: [],actingSubject: author.actor}),201);
    return json(await call('POST','/v1/statement-decisions',{profile: 'statement-decision-v1',
      target: {kind: 'qualified-fact',meaningKey: statement.meaningKey,support: [statement.statement]},acceptance: {kind: 'global'},
      outcome: 'accepted',expectedDecisionHead: null,actingSubject: author.actor}),201);
  };
  await accept(works[0]!, fantasy); await accept(works[0]!, magic);
  await accept(works[1]!, fantasy); await accept(works[1]!, romance);
  await accept(works[2]!, magic);
  await accept(works[3]!, fantasy);
  type Generation = { generation: string; checkpoint: string; complete: boolean; state: string };
  let row = await json<Generation>(await call('POST', '/v1/discovery/generation-builds', {
    profile: 'discovery-generation-build-v1', actingSubject: author.actor,
    basis: { scope: 'global', realm: null, context: null } }));
  for (let steps = 0; !row.complete && steps < 20; steps++) row = await json<Generation>(await call('POST',
    `/v1/discovery/generations/${row.generation}/advance`, { actingSubject: author.actor,
      expectedCheckpoint: row.checkpoint }));
  if (!row.complete || row.state !== 'ready') throw new Error('The discovery generation did not complete');
  const head = await json<{ activeHeadRevision: string | null }>(await call('GET',
    `/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(author.actor)}`));
  await json(await call('POST', '/v1/discovery/generation-activations', {
    profile: 'discovery-generation-activation-v1', actingSubject: author.actor, generation: row.generation,
    expectedHeadRevision: head.activeHeadRevision }));

  console.log(JSON.stringify({ books,
    concept: { fantasy: fantasy.concept, magic: magic.concept, romance: romance.concept, works } }));
} finally {
  await home.stop();
}
