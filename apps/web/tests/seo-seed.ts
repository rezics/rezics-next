// Seeds Works for the address and search-metadata e2e into the isolated QA stack
// the e2e harness started: a public Work with a description whose first slug was
// renamed, a Work whose slug was merged into it, one whose slug was retired, and
// a private Work. Addresses go through the owner commands the Main routes
// admit; it prints the IDs and slugs.
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { claimWorkAddress, workAddressDigest } from '../../../services/main/src/modules/address/claim.ts';
import { disposeWorkAddress, workAddressDispositionDigest } from '../../../services/main/src/modules/address/dispose.ts';
import { renameWorkAddress, workAddressRenameDigest } from '../../../services/main/src/modules/address/rename.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The search-metadata seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory) throw new Error('MAIN_OBJECT_DIRECTORY must name the running Main’s object directory');

const stack = await startMediaStack('seo-e2e');
// Owner commands keep revision bytes where the running Main reads them, as services/main/src/index.ts configures it.
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const author = await stack.member('seo-author');
  const tag = randomUUID().slice(0, 8);
  const title = `The Salt Road Almanac ${tag}`;
  const description = 'Recipes, tide tables and gossip from a coast that keeps moving.';
  const work = await stack.publicWork(author.actor, ['en'], title);
  await author.grant(`work:edit:${work.work}`, 'work.edit');
  const saved = await author.send('PUT', `/v1/works/${work.work.slice(-36)}/metadata`,
    { profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: author.actor, state: { kind: 'header',
      originalTitle: { value: 'Almanach de la route du sel', language: 'fr' },
      localized: [{ language: 'en', title: null, mainVersionLabel: null, description }] } });
  if (saved.status !== 200) throw new Error(`Description failed with ${saved.status}: ${await saved.text()}`);

  const admitted = (target: string, verb: string, action: string, digest: string) =>
    stack.admission(author.actor, `address:${verb}:${target}`, action, digest);
  const claim = async (target: string, slug: string) => {
    const input = { work: target, slug, actingSubject: author.actor };
    const receipt = await claimWorkAddress(stack.env, admitted(target, 'claim', 'address.claim',
      workAddressDigest(input)), input);
    if (receipt.outcome !== 'succeeded' || !receipt.revision) throw new Error(`Claiming ${slug} failed`);
    return receipt.revision;
  };
  const dispose = async (target: string, slug: string, revision: string, targetWork?: string) => {
    const input = targetWork ? { operation: 'merge' as const, work: target, slug, expectedRevision: revision, targetWork,
      actingSubject: author.actor } : { operation: 'retire' as const, work: target, slug, expectedRevision: revision,
      actingSubject: author.actor };
    const receipt = await disposeWorkAddress(stack.env, admitted(target, 'dispose', 'address.dispose',
      workAddressDispositionDigest(input)), input);
    if (receipt.outcome !== 'succeeded') throw new Error(`Disposing of ${slug} failed`);
  };

  const first = `salt-road-${tag}`;
  const current = `salt-road-almanac-${tag}`;
  const rename = { work: work.work, slug: first, newSlug: current, expectedRevision: await claim(work.work, first),
    actingSubject: author.actor };
  const renamed = await renameWorkAddress(stack.env, admitted(work.work, 'rename', 'address.rename',
    workAddressRenameDigest(rename)), rename);
  if (renamed.outcome !== 'succeeded') throw new Error('Renaming the address failed');

  const draft = await stack.privateWork(author.actor);
  const merged = `salt-road-draft-${tag}`;
  await dispose(draft.work, merged, await claim(draft.work, merged), work.work);
  const withdrawn = await stack.privateWork(author.actor);
  const retired = `salt-road-withdrawn-${tag}`;
  await dispose(withdrawn.work, retired, await claim(withdrawn.work, retired));

  const hidden = await stack.privateWork(author.actor, `A Private Ledger ${tag}`);
  console.log(JSON.stringify({ work: work.work, title, description, first, current, merged, retired,
    hidden: hidden.work, hiddenTitle: hidden.title }));
} finally {
  await stack.stop();
}
