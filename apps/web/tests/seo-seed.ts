// Seeds Works for the address and search-metadata e2e into the isolated QA stack
// the e2e harness started: a public Work with a description whose first slug was
// renamed, a Work whose slug was merged into it, one whose slug was retired, and
// a private Work. Addresses go through the owner commands the Main routes
// admit; it prints the IDs and slugs.
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { AliasRegistry,type AliasReceipt } from '../../../services/main/src/modules/address/registry.ts';
import { GRAPHS,iri } from '../../../services/main/src/modules/work/activate.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The search-metadata seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory) throw new Error('MAIN_OBJECT_DIRECTORY must alias the running Main’s object directory');

const stack = await startMediaStack('seo-e2e');
// Owner commands keep revision bytes where the running Main reads them, as services/main/src/index.ts configures it.
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects,addresses: new AliasRegistry(stack.accessPool) });
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

  const change = async (target: string,operation: 'claim' | 'rename' | 'release' | 'merge',
    alias: string | null,expectedRevision: string | null,successor?: string) => {
    const family = operation === 'claim' ? 'claim' : operation === 'rename' ? 'rename' : 'dispose';
    await author.grant(`address:${family}:${target}`,`address.${family}`);
    const response = await author.send('POST',`/v1/addresses/${operation === 'claim' ? 'claims' : operation === 'rename' ? 'renames' : 'dispositions'}`, {
      profile: 'alias-write-v1',scope: 'work',holder: target,operation,expectedRevision,
      ...(alias === null ? {} : { alias: alias }),actingSubject: author.actor,...(successor ? { successor } : {}),
    });
    if (response.status !== 201) throw new Error(`Alias write failed: ${await response.text()}`);
    return response.json() as Promise<AliasReceipt>;
  };
  const claim = async (target: string,alias: string) => (await change(target,'claim',alias,null)).revision;
  const first = `salt-road-${tag}`;
  const current = `salt-road-almanac-${tag}`;
  await change(work.work,'rename',current,await claim(work.work,first));

  const draft = await stack.publicWork(author.actor,['en'],'Equivalent old Work');
  const merged = `salt-road-draft-${tag}`;
  await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(draft.work)} rv:mergedInto ${iri(work.work)} } }`);
  await change(draft.work,'merge',null,await claim(draft.work,merged),work.work);
  const withdrawn = await stack.publicWork(author.actor,['en'],'Withdrawn alias');
  const retired = `salt-road-withdrawn-${tag}`;
  await change(withdrawn.work,'release',null,await claim(withdrawn.work,retired));

  const hidden = await stack.privateWork(author.actor, `A Private Ledger ${tag}`);
  console.log(JSON.stringify({ work: work.work, title, description, first, current, merged, retired,
    hidden: hidden.work, hiddenTitle: hidden.title }));
} finally {
  await stack.stop();
}
