import { beforeAll, expect, test } from 'bun:test';
import manifest from '../../../generated/model/manifest.json';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { join } from 'node:path';

const base = process.env.FUSEKI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:39030/rezics';
const rv = 'https://rezics.com/vocab/';
const graphs = { control: 'urn:rezics:graph:control', current: 'urn:rezics:graph:current',
  revisions: 'urn:rezics:graph:revisions', receipts: 'urn:rezics:graph:receipts',
  outbox: 'urn:rezics:graph:outbox' };
const dataset = 'urn:rezics:dataset:product';
const nonce = crypto.randomUUID();
const profile = manifest.profiles.find(entry => entry.id === 'work-metadata-v1')!;
const validation = (shape: string, focus: string[]) => ({ profile: profile.id, sha256: profile.sha256,
  shape: `https://rezics.com/definition/work-metadata-v1/${shape}`, focus, graphs: [graphs.current] });
type Result = { status: string; position?: { datasetId: string; dataEpoch: string; sequence: string }; report?: string };
const command = async (receipt: string, update: string, validations: object[] = [], digest = receipt): Promise<Result> => {
  const response = await fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt, digest, update, validations, deadlineMs: 10000 }) });
  expect(response.status).toBe(200);
  return response.json() as Promise<Result>;
};
const select = async (sparql: string) => {
  const response = await fetch(`${base}/query?query=${encodeURIComponent(sparql)}`,
    { headers: { accept: 'application/sparql-results+json' } });
  expect(response.ok).toBe(true);
  return response.json() as Promise<{ boolean?: boolean; results?: { bindings: Record<string, {value:string}>[] } }>;
};
const ask = async (sparql: string) => (await select(sparql)).boolean === true;
const lineage = async () => {
  const rows = (await select(`PREFIX rv: <${rv}> SELECT ?epoch ?routing ?n WHERE {
    GRAPH <${graphs.control}> { <${dataset}> rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?n }
  }`)).results?.bindings ?? [];
  expect(rows.length).toBe(1);
  return { epoch: rows[0]!.epoch!.value, routing: rows[0]!.routing!.value, n: BigInt(rows[0]!.n!.value) };
};
const receiptTriples = (receipt: string, epoch: string, position: string, digest = receipt,
  extra = '') => `GRAPH <${graphs.receipts}> { <${receipt}> a <${rv}OperationReceipt> ;
    <${rv}requestDigest> ${JSON.stringify(digest)} ; <${rv}datasetId> <${dataset}> ;
    <${rv}dataEpoch> ${JSON.stringify(epoch)} ; <${rv}sequence> ${position} ;
    <${rv}outcome> <${rv}Cancelled> ${extra}. }`;
const outboxTriples = (batch: string, epoch: string, position: string) =>
  `GRAPH <${graphs.outbox}> { <${batch}> a <${rv}OutboxBatch> ;
    <${rv}dataEpoch> ${JSON.stringify(epoch)} ; <${rv}sequence> ${position} ; <${rv}eventCount> 0 . }`;
const eventOutbox = (receipt: string, epoch: string) => `GRAPH <${graphs.outbox}> {
  <${receipt}:batch> a <${rv}OutboxBatch> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
    <${rv}sequence> ?next ; <${rv}eventCount> 1 ; <${rv}event> <${receipt}:event> .
  <${receipt}:event> a <${rv}WorkCreatedEvent> ; <${rv}ordinal> 0 ; <${rv}receipt> <${receipt}> . }`;
const contentEventOutbox = (receipt: string, epoch: string) => `GRAPH <${graphs.outbox}> {
  <${receipt}:batch> a <${rv}OutboxBatch> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
    <${rv}sequence> ?next ; <${rv}eventCount> 1 ; <${rv}event> <${receipt}:event> .
  <${receipt}:event> a <${rv}ContentPublicationEvent> ; <${rv}ordinal> 0 ;
    <${rv}receipt> <${receipt}> . }`;
const build = async (receipt: string, options: { data?: string; outbox?: string; receipt?: string;
  increment?: number; guardEpoch?: boolean; guardRouting?: boolean; control?: string } = {}) => {
  const {epoch,routing} = await lineage();
  const guards = [options.guardEpoch === false ? '' : `<${dataset}> rv:dataEpoch ${JSON.stringify(epoch)} .`,
    options.guardRouting === false ? '' : `<${dataset}> rv:routingEpoch ${JSON.stringify(routing)} .`,
    `<${dataset}> rv:sequence ?n .`].join('\n');
  const next = '?next';
  const update = `PREFIX rv: <${rv}> DELETE { GRAPH <${graphs.control}> { <${dataset}> rv:sequence ?n } }
    INSERT { GRAPH <${graphs.control}> { <${dataset}> rv:sequence ${options.control ?? next} }
      ${options.data ?? ''}
      ${options.receipt ?? receiptTriples(receipt, epoch, next)}
      ${options.outbox === undefined ? outboxTriples(`urn:rezics:p02:${nonce}:${encodeURIComponent(receipt)}:batch`, epoch, next) : options.outbox}
    } WHERE { GRAPH <${graphs.control}> { ${guards} }
      FILTER NOT EXISTS { GRAPH <${graphs.receipts}> { <${receipt}> ?rp ?ro } }
      BIND(?n + ${options.increment ?? 1} AS ?next) }`;
  return {update,epoch};
};
const absent = async (receipt: string) => expect(await ask(`ASK { GRAPH <${graphs.receipts}> { <${receipt}> ?p ?o } }`)).toBe(false);

beforeAll(async () => {
  let health: {moduleVersion:string;profiles:Record<string,string>} | undefined;
  for (let attempt=0; attempt<60 && !health; attempt++) {
    try { health = await (await fetch(`${base}/command`)).json(); } catch { await Bun.sleep(250); }
  }
  expect(health?.moduleVersion).toBe('0.5.2');
  expect(health?.profiles['work-metadata-v1']).toBe(profile.sha256);
  const rows = (await select(`PREFIX rv: <${rv}> SELECT ?epoch WHERE {
    GRAPH <${graphs.control}> { <${dataset}> rv:dataEpoch ?epoch }
  }`)).results?.bindings ?? [];
  if (rows.length === 0) await initializeFreshGraph(new FusekiClient(base),
    { dataEpoch: crypto.randomUUID(), routingEpoch: '0' });
  await lineage();
});

test('SYS02/SYS09/SYS10: a legitimate work write has one receipt, sequence step and outbox', async () => {
  const receipt = `urn:rezics:p02:${nonce}:work`;
  const work = `urn:rezics:p02:${nonce}:work-node`;
  const main = `urn:rezics:p02:${nonce}:main-node`;
  const data = `GRAPH <${graphs.current}> {
    <${work}> a <https://schema.org/CreativeWork> ; <${rv}mainVersion> <${main}> ;
      <${rv}continuityProfile> <https://rezics.com/definition/continuity/native-work-v1> ;
      <http://www.w3.org/2000/01/rdf-schema#label> "P02BlueGarden"@en .
    <${main}> a <${rv}MainVersion> ; <${rv}work> <${work}> ; <${rv}hostingPolicy> <${rv}MetadataOnly> . }`;
  const {epoch:writeEpoch} = await lineage();
  const {update,epoch} = await build(receipt,{data,outbox:eventOutbox(receipt,writeEpoch)});
  const checks = [validation('work-shape',[work]), validation('main-version-shape',[main])];
  const result = await command(receipt, update, checks);
  expect(result.status).toBe('committed');
  expect(result.position?.datasetId).toBe(dataset);
  expect(result.position?.dataEpoch).toBe(epoch);
  expect(await command(receipt, update, checks)).toEqual(result);
  expect((await command(receipt, update, checks, 'forged')).status).toBe('conflict');
  expect(await ask(`ASK { GRAPH <${graphs.current}> { <${work}> a <https://schema.org/CreativeWork> } }`)).toBe(true);
});

test('SYS02: Main metadata Work writer still commits through the native boundary', async () => {
  const {epoch,routing,n} = await lineage();
  const title = `Invariant writer ${nonce}`;
  const admission = {id:crypto.randomUUID(), scope:'work:create:root', action:'work.create',
    idempotencyKey:`p02-${nonce}`, requestDigest:metadataWorkRequestDigest(title),
    authorityEpoch:'0', expiresAt:new Date(Date.now()+60_000).toISOString()};
  const result = await activateMetadataWork({fuseki:new FusekiClient(base),
    lineage:{dataEpoch:epoch,routingEpoch:routing},
    objectDirectory:join(process.cwd(),'.temp','p02-invariant-objects',nonce)},
    {title,admission});
  expect(result.replayed).toBe(false);
  expect(BigInt(result.sequence)).toBe(n+1n);
  expect((await lineage()).n).toBe(n+1n);
});

test('SYS02/MODEL17: product data still requires matching canonical validation', async () => {
  const receipt = `urn:rezics:p02:${nonce}:unvalidated`;
  const bad = `urn:rezics:p02:${nonce}:bad-work`;
  const {epoch} = await lineage();
  const {update} = await build(receipt, {data:`GRAPH <${graphs.current}> { <${bad}> a <https://schema.org/CreativeWork> . }`,
    outbox:eventOutbox(receipt,epoch)});
  const result = await command(receipt, update);
  expect(result.status).toBe('invalid');
  expect(result.report).toContain('profile validation');
  await absent(receipt);
  const under = `urn:rezics:p02:${nonce}:underdeclared`;
  const underUpdate = await build(under, {data:`GRAPH <${graphs.current}> { <${bad}> a <https://schema.org/CreativeWork> . }`,
    outbox:eventOutbox(under,epoch)});
  const underResult = await command(under, underUpdate.update, [validation('work-shape',['urn:rezics:missing'])]);
  expect(underResult.status).toBe('invalid');
  expect(underResult.report).toContain('focus omitted');
  await absent(under);
});

test('P0.8: Content publication validates exact current/revision foci and reciprocal position', async () => {
  const contentProfile = manifest.profiles.find(entry => entry.id === 'content-publication-v1')!;
  const health = await (await fetch(`${base}/command`)).json() as { profiles: Record<string,string> };
  expect(health.profiles['content-publication-v1']).toBe(contentProfile.sha256);
  const contentValidation = (role: 'variant' | 'decision', focus: string, graph: string) => ({
    profile: contentProfile.id, sha256: contentProfile.sha256,
    shape: `https://rezics.com/definition/content-publication-v1/${role}-shape`,
    focus: [focus], graphs: [graph],
  });
  const run = async (name: string, change: { missingRevision?: boolean; omitVariant?: boolean;
    wrongComponent?: boolean; wrongPosition?: boolean; wrongReceiptDigest?: boolean } = {}) => {
    const receipt = `urn:rezics:p08:${nonce}:${name}`;
    const work = `${receipt}:work`;
    const main = `${receipt}:main`;
    const variant = `${receipt}:variant`;
    const other = `${receipt}:other-variant`;
    const decision = `${receipt}:decision`;
    const {epoch} = await lineage();
    const data = `GRAPH <${graphs.current}> {
      <${work}> a <https://schema.org/CreativeWork> ; <${rv}mainVersion> <${main}> ;
        <${rv}continuityProfile> <https://rezics.com/definition/continuity/native-work-v1> ;
        <http://www.w3.org/2000/01/rdf-schema#label> "Content pin ${name}"@en .
      <${main}> a <${rv}MainVersion> ; <${rv}work> <${work}> ;
        <${rv}hostingPolicy> <${rv}MetadataOnly> .
      <${variant}> a <${rv}ContentVariant> ; <${rv}resource> <${work}> ;
        <${rv}contentPublicationHead> <${decision}> .
      ${change.wrongComponent ? `<${other}> a <${rv}ContentVariant> ; <${rv}resource> <${work}> ;
        <${rv}contentPublicationHead> <${decision}> .` : ''}
    }
    GRAPH <${graphs.revisions}> {
      <${decision}> a <${rv}ContentPublicationDecision>, <${rv}RevisionAnchor> ;
        <${rv}component> <${change.wrongComponent ? other : variant}> ;
        <${rv}operation> <urn:rezics:operation:${'a'.repeat(64)}> ;
        ${change.missingRevision ? '' : `<${rv}contentRevision> <urn:rezics:content:revision:00000000-0000-4000-8000-000000000001> ;`}
        <${rv}contentPreparation> "prep-1" ; <${rv}resource> <${work}> ;
        <${rv}byteDigest> "${'b'.repeat(64)}" ;
        <${rv}contentFormat> "rezics-content-json-v1" ; <${rv}contentModel> "plain-text-v1" ;
        <${rv}contentLanguageKind> "tag" ; <${rv}contentLanguage> "en-US" ;
        <${rv}contentDirection> "ltr" ;
        <${rv}ownerDataEpoch> "00000000-0000-4000-8000-000000000002" ;
        <${rv}ownerSequence> "7" ;
        <${rv}modelRevision> <https://rezics.com/definition/content-publication-v1> ;
        <${rv}shapeRevision> <https://rezics.com/definition/content-publication-v1> ;
        <${rv}datasetId> <${dataset}> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
        <${rv}sequence> ${change.wrongPosition ? '999' : '?next'} .
    }`;
    const receiptData = `GRAPH <${graphs.receipts}> {
      <${receipt}> a <${rv}OperationReceipt> ; <${rv}requestDigest> ${JSON.stringify(receipt)} ;
        <${rv}operation> <urn:rezics:operation:${'a'.repeat(64)}> ;
        <${rv}contentRevision> <urn:rezics:content:revision:00000000-0000-4000-8000-000000000001> ;
        <${rv}contentPreparation> "prep-1" ; <${rv}variant> <${change.wrongComponent ? other : variant}> ;
        <${rv}resource> <${work}> ;
        <${rv}byteDigest> "${(change.wrongReceiptDigest ? 'c' : 'b').repeat(64)}" ;
        <${rv}ownerDataEpoch> "00000000-0000-4000-8000-000000000002" ;
        <${rv}ownerSequence> "7" ; <${rv}publicationDecision> <${decision}> ;
        <${rv}datasetId> <${dataset}> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
        <${rv}sequence> ?next ; <${rv}outcome> <${rv}Succeeded> .
    }`;
    const {update} = await build(receipt, { data, outbox:contentEventOutbox(receipt,epoch),
      receipt:receiptData });
    const checks = [validation('work-shape',[work]), validation('main-version-shape',[main]),
      ...(!change.omitVariant ? [contentValidation('variant', variant, graphs.current)] : []),
      ...(change.wrongComponent ? [contentValidation('variant', other, graphs.current)] : []),
      contentValidation('decision', decision, graphs.revisions)];
    const result = await command(receipt, update, checks);
    return {receipt, variant, decision, result};
  };
  const valid = await run('valid');
  if (valid.result.status !== 'committed') throw new Error(JSON.stringify(valid.result));
  expect(await ask(`ASK { GRAPH <${graphs.current}> { <${valid.variant}> <${rv}contentPublicationHead> <${valid.decision}> } }`)).toBe(true);
  for (const [name, change, report] of [
    ['missing-revision', {missingRevision:true}, 'receipt field mismatch: contentRevision'],
    ['omitted-focus', {omitVariant:true}, 'Content variant focus omitted'],
    ['wrong-component', {wrongComponent:true}, 'reciprocal head/resource mismatch'],
    ['wrong-position', {wrongPosition:true}, 'graph position mismatch'],
    ['wrong-receipt-digest', {wrongReceiptDigest:true}, 'receipt field mismatch: byteDigest'],
  ] as const) {
    const invalid = await run(name, change);
    expect(invalid.result.status).toBe('invalid');
    expect(invalid.result.report).toContain(report);
    await absent(invalid.receipt);
  }
});

test('SYS02: forged receipts, missing or duplicate outbox, wrong sequence and omitted epoch guards roll back', async () => {
  const cases: [string, (receipt:string,epoch:string) => Parameters<typeof build>[1]][] = [
    ['forged-digest', (r,e) => ({receipt:receiptTriples(r,e,'?next','forged')})],
    ['extra-receipt-value', (r,e) => ({receipt:receiptTriples(r,e,'?next',r,`; <${rv}sequence> ?n `)})],
    ['missing-outbox', () => ({outbox:''})],
    ['duplicate-outbox', (r,e) => ({outbox:outboxTriples(`${r}:a`,e,'?next')+outboxTriples(`${r}:b`,e,'?next')})],
    ['unchanged-sequence', () => ({control:'?n'})],
    ['overshot-sequence', () => ({increment:2})],
    ['missing-data-epoch-guard', () => ({guardEpoch:false})],
    ['missing-routing-epoch-guard', () => ({guardRouting:false})],
  ];
  for (const [name, options] of cases) {
    const receipt = `urn:rezics:p02:${nonce}:${name}`;
    const {epoch} = await lineage();
    const settings = options(receipt,epoch);
    const {update} = await build(receipt,settings);
    const result = await command(receipt,update);
    expect(result.status).toBe(name === 'forged-digest' ? 'conflict' : 'invalid');
    if (name === 'missing-outbox') expect(result.report).toContain('outbox batch required');
    if (name === 'duplicate-outbox') expect(result.report).toContain('exactly one outbox batch');
    if (name.endsWith('sequence')) expect(result.report).toContain('invalid sequence advance');
    if (name.endsWith('guard')) expect(result.report).toContain('guards required');
    await absent(receipt);
  }
  const receipt = `urn:rezics:p02:${nonce}:foreign-receipt`;
  const {update} = await build(receipt);
  const response = await fetch(`${base}/command`, {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({receipt,digest:receipt,update:update.replace('INSERT {',
      `INSERT { GRAPH <${graphs.receipts}> { <${receipt}:other> <${rv}requestDigest> "forged" . }`),
      validations:[]})});
  expect(response.status).toBe(400);
  await absent(receipt);
});

test('SYS02: normal command cannot remove control record and reopen bootstrap', async () => {
  const receipt = `urn:rezics:p02:${nonce}:erase-control`;
  const {epoch,routing} = await lineage();
  const update = `PREFIX rv: <${rv}> DELETE { GRAPH <${graphs.control}> { <${dataset}> ?p ?o } }
    INSERT { ${receiptTriples(receipt,epoch,'?next')} ${outboxTriples(`${receipt}:batch`,epoch,'?next')} }
    WHERE { GRAPH <${graphs.control}> { <${dataset}> rv:dataEpoch ${JSON.stringify(epoch)} ;
      rv:routingEpoch ${JSON.stringify(routing)} ; rv:sequence ?n ; ?p ?o }
      BIND(?n + 1 AS ?next) }`;
  expect((await command(receipt,update)).status).toBe('invalid');
  await absent(receipt);
  const bootstrap = `urn:rezics:receipt:bootstrap:${nonce}`;
  const retry = `PREFIX rv: <${rv}> INSERT { GRAPH <${graphs.receipts}> {
    <${bootstrap}> a rv:OperationReceipt ; rv:requestDigest "rebootstrap" ; rv:datasetId <${dataset}> ;
      rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 0 . }
    GRAPH <${graphs.control}> { <${dataset}> rv:dataEpoch ${JSON.stringify(epoch)} ;
      rv:routingEpoch ${JSON.stringify(routing)} ; rv:sequence 0 . }
    } WHERE { FILTER(true) }`;
  expect((await command(bootstrap,retry,[],'rebootstrap')).status).toBe('invalid');
  await absent(bootstrap);
});

test('SYS09: disposable QA Fuseki retains raw fixture updates', async () => {
  const graph = `urn:rezics:p02:${nonce}:fixture`;
  const response = await fetch(`${base}/update`, {method:'POST', headers:{'content-type':'application/sparql-update'},
    body:`INSERT DATA { GRAPH <${graph}> { <urn:fixture> <urn:probe> <urn:ok> } }`});
  expect(response.ok).toBe(true);
  expect(await ask(`ASK { GRAPH <${graph}> { <urn:fixture> <urn:probe> <urn:ok> } }`)).toBe(true);
});

test('SYS02: product assembler has no raw write operation', async () => {
  const product = await Bun.file(new URL('../fuseki-text.ttl', import.meta.url)).text();
  const fixture = await Bun.file(new URL('../fuseki-text-qa.ttl', import.meta.url)).text();
  expect(product).not.toContain('fuseki:serviceUpdate');
  expect(product).not.toContain('fuseki:serviceReadWriteGraphStore');
  expect(fixture).toContain('fuseki:serviceUpdate "update"');
});
