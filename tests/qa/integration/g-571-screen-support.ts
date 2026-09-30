import { randomUUID } from 'node:crypto';
import { sha } from './media-support.ts';
import { realmSelectionSlotIri } from '../../../services/main/src/modules/work/select-realm.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from '../../../services/main/src/modules/space/create.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { MediaScreenStore } from '../../../services/main/src/modules/media-screen/store.ts';
import { MediaScreenWorker } from '../../../services/main/src/modules/media-screen/worker.ts';
import { screenVerdict, type Scores } from '../../../services/main/src/modules/media-screen/policy.ts';
import type { ImageClassifier } from '../../../services/main/src/modules/media-screen/classifier.ts';
import type { MediaStack } from './media-support.ts';

export const benign: Scores = { Drawing: 0.05, Hentai: 0.01, Neutral: 0.9, Porn: 0.01, Sexy: 0.03 };
export const flagged: Scores = { Drawing: 0.01, Hentai: 0.01, Neutral: 0.03, Porn: 0.9, Sexy: 0.05 };
export function screening(stack: MediaStack, classifier: ImageClassifier = { classify: async () => benign }, timeoutMs = 30_000) {
  const store = new MediaScreenStore(stack.contentPool);
  const cases = new GovernanceStore(stack.accessPool, { capture: async () => { throw new Error('unused capture'); } },
    { current: async () => null }, new GovernanceRules(stack.accessPool));
  const worker = new MediaScreenWorker(store, classifier, stack.objects, cases, timeoutMs);
  return { store, cases, worker };
}
export async function clearQueued(stack: MediaStack) {
  const { store } = screening(stack);
  for (let i = 0; i < 50; i++) {
    const lease = await store.leaseNext();
    if (!lease) return;
    await store.settle(lease, screenVerdict(benign));
  }
  throw new Error('test queue exceeded bound');
}

/** An exact retained media set and public Realm selection fixture, so the delivery
 * guard is tested after every other route prerequisite has succeeded. */
export async function realmMediaFixture(stack: MediaStack, work: { work: string; mainVersion: string },
  item: { use: string; asset: string; revision: string; representation: string; sha256: string;
    mediaType: string; width: number; height: number }) {
  const variant = `urn:rezics:variant:${randomUUID()}`;
  const serializedJson = JSON.stringify({ profile: 'media-set-v1', items: [{ use: item.use,
    asset: `https://rezics.com/id/${item.asset}`, assetRevision: item.revision,
    representation: item.representation, sha256: item.sha256, mediaType: item.mediaType,
    width: item.width, height: item.height }] });
  const saved = await stack.content.saveDraft({ operationId: `g571-realm:${randomUUID()}`,
    variant: { id: variant, resourceId: work.work, language: { kind: 'zxx' }, direction: 'none' },
    expectedHead: null, model: 'media-set-v1', sourceRevision: null, provenance: {}, serializedJson });
  if (!saved.revisionId) throw new Error('fixture media revision failed');
  const realm = `https://rezics.com/id/${randomUUID()}`;
  const space = `https://rezics.com/id/${randomUUID()}`;
  const selection = `https://rezics.com/id/${randomUUID()}`;
  const decision = `https://rezics.com/id/${randomUUID()}`;
  const slot = realmSelectionSlotIri(realm, work.mainVersion);
  await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
    GRAPH <urn:rezics:graph:current> {
      <${space}> a rv:Space ; rv:realmCapability <${realm}> ; rv:disclosure rv:Public .
      <${realm}> a rv:Realm ; rv:space <${space}> ; rv:realmState rv:Active ;
        rv:selectionPolicy <${SELECTION_POLICY}> ; rv:reviewPolicy <${REVIEW_POLICY}> .
      <${slot}> a rv:RealmPublicationSlot ; rv:realm <${realm}> ; rv:mainVersion <${work.mainVersion}> ;
        rv:work <${work.work}> ; rv:selectionHead <${selection}> . }
    GRAPH <urn:rezics:graph:revisions> {
      <${selection}> a rv:PublicationSelection ; rv:slot <${slot}> ; rv:work <${work.work}> ;
        rv:mainVersion <${work.mainVersion}> ; rv:mediaVariant <${variant}> ; rv:mediaPublicationDecision <${decision}> ;
        rv:mediaRevision <urn:rezics:content:revision:${saved.revisionId}> ; rv:mediaDigest "${sha(serializedJson)}" .
      <${decision}> a rv:ContentPublicationDecision ; rv:component <${variant}> ; rv:resource <${work.work}> ;
        rv:contentModel "media-set-v1" ; rv:contentRevision <urn:rezics:content:revision:${saved.revisionId}> ;
        rv:byteDigest "${sha(serializedJson)}" . } }`);
  return `/v1/realms/${realm.split('/').at(-1)}/main-versions/${work.mainVersion.split('/').at(-1)}/selections/${selection.split('/').at(-1)}/media/${item.use}`;
}
