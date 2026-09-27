// Seeds one public Work for the Work page e2e into the isolated QA stack the
// e2e harness started: English and Japanese versions, a Realm that adopted it,
// Global and Realm classification, an Open Library credit and Global and Realm
// ratings. It writes through the same owner commands and Main routes as
// `services/main/tests/work-read.integration.test.ts`, and prints the IDs.
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditTriples } from '../../../services/main/src/modules/work/author-credit.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The Work page seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory) throw new Error('MAIN_OBJECT_DIRECTORY must name the running Main’s object directory');

async function created<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (response.status !== 201) throw new Error(`Seed step failed with ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

const stack = await startMediaStack('work-page-e2e');
// Owner commands keep revision bytes beside the graph; the running Main verifies ratings against them.
stack.env.objectDirectory = objectDirectory;
try {
  const [a, b, c] = await Promise.all(['reader-a', 'reader-b', 'reader-c'].map(name => stack.member(name)));
  const title = `The Cartographer of Tides ${randomUUID().slice(0, 8)}`;
  const work = await stack.publicWork(a!.actor, ['en', 'ja'], title);
  const header = await stack.call('GET', `/v1/works/${work.work.slice(-36)}`);
  const { revision } = await header.json() as { revision: string };

  await a!.grant('space:create:root', 'space.create');
  const realm = await created<{ realm: string }>(await a!.send('POST', '/v1/spaces',
    { profile: 'space-realm-v1', name: 'Tidewater Readers', capabilities: ['realm'], actingSubject: a!.actor }));
  await a!.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
  await created(await a!.send('POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
    context: { kind: 'realm-local', id: realm.realm }, work: work.work, mainVersion: work.mainVersion,
    contribution: work.variants[0]!.contribution, publicationDecision: work.variants[0]!.decision,
    expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: a!.actor }));

  await a!.grant('classification:define:global', 'classification.proposition.define');
  await a!.grant('classification:decide:global', 'classification.decision.set');
  await a!.grant(`classification:context:${realm.realm}`, 'classification.context.configure');
  await a!.grant(`classification:decide:${realm.realm}`, 'classification.decision.set');
  await created(await a!.send('POST', '/v1/classification-contexts',
    { profile: 'classification-context-v1', realm: realm.realm, actingSubject: a!.actor }));
  const decide = async (label: string, context: { kind: 'global' } | { kind: 'realm-classification'; id: string }) => {
    const proposition = await created<{ sense: string }>(await a!.send('POST', '/v1/classification-propositions',
      { profile: 'classification-proposition-v1', label, actingSubject: a!.actor }));
    await created(await a!.send('POST', '/v1/classification-decisions', { profile: 'classification-direct-decision-v1',
      work: work.work, mainVersion: work.mainVersion, sense: proposition.sense, expectedDecisionHead: null,
      context, outcome: 'accepted', actingSubject: a!.actor }));
  };
  await decide('Adventure', { kind: 'global' });
  await decide('Estuary cycle', { kind: 'realm-classification', id: realm.realm });

  // Credits arrive through source adoption, which has no route of its own; write the confirmed triples.
  const credit = authorCreditTriples({ work: work.work, credit: `https://rezics.com/id/${randomUUID()}`,
    revision: `https://rezics.com/id/${randomUUID()}`, expectedHead: revision, sourceKey: '/authors/OL2162284A',
    sourceRoleKey: null, nativeOrdinal: 0, actingSubject: a!.actor }, stack.env.lineage.dataEpoch, '0');
  await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
    GRAPH ${iri(GRAPHS.current)} { ${credit.current} }
    GRAPH ${iri(GRAPHS.revisions)} { ${credit.revision} } }`);

  await a!.grant(`rating:context:${realm.realm}`, 'rating.context.create');
  await a!.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
  const global = await created<{ context: string }>(await a!.send('POST', '/v1/global-rating-contexts',
    { profile: 'global-rating-standing-context-v1', question: 'How good is this Work overall?', actingSubject: a!.actor }));
  const local = await created<{ context: string }>(await a!.send('POST', '/v1/rating-contexts',
    { profile: 'realm-standing-rating-context-v1', realm: realm.realm, question: 'How well does it fit Tidewater Readers?',
      actingSubject: a!.actor }));
  for (const [member, globalValue, realmValue] of [[a!, 5, 8], [b!, 4, 6], [c!, 5, null]] as const) {
    await member.grant(`rating:observe:${global.context}`, 'rating.observation.set');
    await created(await member.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: global.context, work: work.work,
      mainVersion: work.mainVersion, expectedRevisionHead: null, value: globalValue, actingSubject: member.actor }));
    if (realmValue === null) continue;
    await member.grant(`rating:observe:${local.context}`, 'rating.observation.set');
    await created(await member.send('POST', '/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: local.context, work: work.work,
      mainVersion: work.mainVersion, expectedRevisionHead: null, value: realmValue, actingSubject: member.actor }));
  }
  console.log(JSON.stringify({ work: work.work, realm: realm.realm, title }));
} finally {
  await stack.stop();
}
