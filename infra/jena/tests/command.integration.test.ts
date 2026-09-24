import { beforeAll, expect, test } from 'bun:test';
import manifest from '../../../generated/model/manifest.json';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest, StaleWorkHead }
  from '../../../services/main/src/modules/work/edit.ts';
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
  const response = await fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: `Bearer ${process.env.FUSEKI_COMMAND_TOKEN}` },
    body: JSON.stringify({ receipt, digest, update, validations, deadlineMs: 10000 }) });
  if (response.status !== 200) throw new Error(`command HTTP ${response.status}: ${await response.text()}`);
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
const fixtureUpdate = async (update: string) => {
  const response = await fetch(`${base}/update`, { method: 'POST',
    headers: { 'content-type': 'application/sparql-update' }, body: update });
  if (!response.ok) throw new Error(`QA fixture update ${response.status}: ${await response.text()}`);
};
const profileValidation = (id: string, role: string, focus: string, graph: string) => {
  const entry = manifest.profiles.find(item => item.id === id)!;
  return { profile: id, sha256: entry.sha256,
    shape: `https://rezics.com/definition/${id}/${role}-shape`, focus: [focus], graphs: [graph] };
};
const searchOutbox = (receipt: string, epoch: string, kind: string) => `GRAPH <${graphs.outbox}> {
  <${receipt}:batch> a <${rv}OutboxBatch> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
    <${rv}sequence> ?next ; <${rv}eventCount> 1 ; <${rv}event> <${receipt}:event> .
  <${receipt}:event> a <${rv}${kind}> ; <${rv}ordinal> 0 ; <${rv}receipt> <${receipt}> . }`;
const searchGraph = 'urn:rezics:search:public';
const contentRevision = 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000001';

async function seedContentSearchBase(name: string, withEligibility: boolean, rights = true) {
  const id = `urn:rezics:p08:${nonce}:${name}`;
  const work = `${id}:work`;
  const variant = `${id}:variant`;
  const publication = `${id}:publication`;
  const eligibility = `${id}:eligibility`;
  const {epoch} = await lineage();
  await fixtureUpdate(`PREFIX rv: <${rv}> INSERT DATA {
    GRAPH <${graphs.current}> {
      <${work}> a <https://schema.org/CreativeWork> .
      <${variant}> a rv:ContentVariant ; rv:resource <${work}> ;
        rv:contentPublicationHead <${publication}> ${withEligibility ? `;
        rv:publicSearchEligibilityHead <${eligibility}>` : ''} .
    }
    GRAPH <${graphs.revisions}> {
      <${publication}> a rv:ContentPublicationDecision, rv:RevisionAnchor ;
        rv:component <${variant}> ; rv:resource <${work}> ;
        rv:contentRevision <${contentRevision}> .
      ${withEligibility ? `<${eligibility}> a rv:ContentSearchEligibilityDecision, rv:RevisionAnchor ;
        rv:component <${variant}> ; rv:variant <${variant}> ; rv:resource <${work}> ;
        rv:publicationDecision <${publication}> ;
        ${rights ? 'rv:rightsBasis rv:OriginalContribution ;' : ''}
        rv:disclosure rv:Public ; rv:admissionId "00000000-0000-4000-8000-000000000003" ;
        rv:authorityEpoch "0" ;
        rv:admittedScope ${JSON.stringify(`content:search-eligibility:${variant}`)} ;
        rv:actingSubject <urn:rezics:test:actor> ;
        rv:modelRevision <https://rezics.com/definition/content-search-eligibility-v1> ;
        rv:shapeRevision <https://rezics.com/definition/content-search-eligibility-v1> ;
        rv:datasetId <${dataset}> ; rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence 1 .` : ''}
    }
  }`);
  return { id, work, variant, publication, eligibility, epoch };
}

beforeAll(async () => {
  let health: {moduleVersion:string;instanceId:string;publicSearchWriteEpoch:string;
    publicSearchWriteActive:boolean;profiles:Record<string,string>} | undefined;
  for (let attempt=0; attempt<60 && !health; attempt++) {
    try { health = await (await fetch(`${base}/command`)).json(); } catch { await Bun.sleep(250); }
  }
  expect(health?.moduleVersion).toBe('0.5.10');
  expect(health?.instanceId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  expect(health?.publicSearchWriteEpoch).toMatch(/^(0|[1-9][0-9]*)$/);
  expect(health?.publicSearchWriteActive).toBe(false);
  expect(health?.profiles['work-metadata-v1']).toBe(profile.sha256);
  await fixtureUpdate([...Object.values(graphs), searchGraph, 'urn:rezics:search:probe']
    .map(graph => `CLEAR SILENT GRAPH <${graph}>`).join('; '));
  await initializeFreshGraph(new FusekiClient(base),
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

test('MODEL17: selected graph union deduplicates equal triples and validates across graphs', async () => {
  for (const [name, otherHead] of [['equal', false], ['conflicting', true]] as const) {
    const receipt = `urn:rezics:p08:${nonce}:union-${name}`;
    const work = `${receipt}:work`;
    const main = `${receipt}:main`;
    const data = `GRAPH <${graphs.current}> {
      <${work}> a <https://schema.org/CreativeWork> ; <${rv}mainVersion> <${main}> ;
        <${rv}continuityProfile> <https://rezics.com/definition/continuity/native-work-v1> .
      <${main}> a <${rv}MainVersion> ; <${rv}work> <${work}> ;
        <${rv}hostingPolicy> <${rv}MetadataOnly> . }
      GRAPH <${graphs.revisions}> { <${work}> <${rv}mainVersion>
        <${otherHead ? `${receipt}:other` : main}> . }`;
    const {epoch} = await lineage();
    const {update} = await build(receipt, {data, outbox:eventOutbox(receipt, epoch)});
    const checks = [
      {...validation('work-shape', [work]), graphs:[graphs.current, graphs.revisions, graphs.current]},
      validation('main-version-shape', [main]),
    ];
    const result = await command(receipt, update, checks);
    expect(result.status).toBe(otherHead ? 'invalid' : 'committed');
    if (otherHead) {
      expect(result.report).toContain(`${rv}mainVersion`);
      await absent(receipt);
    }
  }
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

test('P0.8: admitted public eligibility binds current head, rights, scope and receipt', async () => {
  const run = async (name: string, change: { rights?: string; scope?: string;
    receiptAdmission?: string; omitVariant?: boolean; omitDecision?: boolean } = {}) => {
    const base = await seedContentSearchBase(`eligibility-${name}`, false);
    const {variant, work, publication, eligibility, epoch} = base;
    const receipt = `${base.id}:receipt`;
    const admission = '00000000-0000-4000-8000-000000000003';
    const scope = change.scope ?? `content:search-eligibility:${variant}`;
    const fields = `<${rv}variant> <${variant}> ; <${rv}resource> <${work}> ;
      <${rv}publicationDecision> <${publication}> ;
      <${rv}rightsBasis> <${rv}${change.rights ?? 'OriginalContribution'}> ;
      <${rv}disclosure> <${rv}Public> ;
      <${rv}admissionId> ${JSON.stringify(admission)} ; <${rv}authorityEpoch> "0" ;
      <${rv}admittedScope> ${JSON.stringify(scope)} ; <${rv}actingSubject> <urn:rezics:test:actor> ;`;
    const data = `GRAPH <${graphs.current}> {
      <${variant}> <${rv}publicSearchEligibilityHead> <${eligibility}> . }
      GRAPH <${graphs.revisions}> { <${eligibility}> a <${rv}ContentSearchEligibilityDecision>,
        <${rv}RevisionAnchor> ; <${rv}component> <${variant}> ; ${fields}
        <${rv}modelRevision> <https://rezics.com/definition/content-search-eligibility-v1> ;
        <${rv}shapeRevision> <https://rezics.com/definition/content-search-eligibility-v1> ;
        <${rv}datasetId> <${dataset}> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
        <${rv}sequence> ?next . }`;
    const receiptData = `GRAPH <${graphs.receipts}> { <${receipt}> a <${rv}OperationReceipt> ;
      <${rv}requestDigest> ${JSON.stringify(receipt)} ; <${rv}outcome> <${rv}Succeeded> ;
      <${rv}eligibilityDecision> <${eligibility}> ; ${fields.replace(
        JSON.stringify(admission), JSON.stringify(change.receiptAdmission ?? admission))}
      <${rv}datasetId> <${dataset}> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
      <${rv}sequence> ?next . }`;
    const {update} = await build(receipt, {data, receipt:receiptData,
      outbox:searchOutbox(receipt,epoch,'ContentSearchEligibilityEvent')});
    const checks = [
      ...(!change.omitVariant ? [profileValidation('content-publication-v1','variant',variant,graphs.current)] : []),
      ...(!change.omitDecision ? [profileValidation('content-search-eligibility-v1','decision',
        eligibility,graphs.revisions)] : []),
    ];
    return {receipt,eligibility,result:await command(receipt,update,checks)};
  };
  const epochBefore = BigInt((await (await fetch(`${base}/command`)).json()).publicSearchWriteEpoch);
  const good = await run('valid');
  if (good.result.status !== 'committed') throw new Error(JSON.stringify(good.result));
  expect(BigInt((await (await fetch(`${base}/command`)).json()).publicSearchWriteEpoch)).toBe(epochBefore);
  expect(await ask(`ASK { GRAPH <${graphs.revisions}> {
    <${good.eligibility}> <${rv}rightsBasis> <${rv}OriginalContribution> } }`)).toBe(true);
  for (const [name, change, report] of [
    ['rights', {rights:'LicensedCopy'}, 'rightsBasis'],
    ['scope', {scope:'content:search-eligibility:other'}, 'admission scope mismatch'],
    ['receipt-admission', {receiptAdmission:'00000000-0000-4000-8000-000000000004'},
      'receipt field mismatch: admissionId'],
    ['variant-focus', {omitVariant:true}, 'Content variant focus omitted'],
    ['decision-focus', {omitDecision:true}, 'Content search eligibility focus omitted'],
  ] as const) {
    const failed = await run(name,change);
    expect(failed.result.status).toBe('invalid');
    expect(failed.result.report).toContain(report);
    await absent(failed.receipt);
  }
});

test('P0.8: public MatchUnit projection requires exact two-shape binding and an eligible publication', async () => {
  const run = async (name: string, change: { unitEligibility?: string; bodyLanguage?: string;
    receiptOwner?: string; omitUnitFocus?: boolean; omitProjectionFocus?: boolean;
    rights?: boolean } = {}) => {
    const base = await seedContentSearchBase(`projection-${name}`, true, change.rights !== false);
    const {variant,work,publication,eligibility,epoch} = base;
    const receipt = `${base.id}:receipt`;
    const anchor = `${base.id}:anchor`;
    const unit = `${base.id}:unit`;
    const owner = '00000000-0000-4000-8000-000000000002';
    const data = `GRAPH <${graphs.revisions}> { <${anchor}> a <${rv}ContentProjection>,
      <${rv}RevisionAnchor> ; <${rv}component> <${variant}> ; <${rv}resource> <${work}> ;
      <${rv}contentRevision> <${contentRevision}> ;
      <${rv}publicationDecision> <${publication}> ; <${rv}eligibility> <${eligibility}> ;
      <${rv}matchUnit> <${unit}> ; <${rv}ownerDataEpoch> ${JSON.stringify(owner)} ;
      <${rv}ownerSequence> "7" ;
      <${rv}modelRevision> <https://rezics.com/definition/content-match-unit-v1> ;
      <${rv}shapeRevision> <https://rezics.com/definition/content-match-unit-v1> ;
      <${rv}datasetId> <${dataset}> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
      <${rv}sequence> ?next . }
      GRAPH <${searchGraph}> { <${unit}> a <${rv}MatchUnit> ; <${rv}resource> <${work}> ;
      <${rv}variant> <${variant}> ; <${rv}revision> <${contentRevision}> ;
      <${rv}publicationDecision> <${publication}> ;
      <${rv}eligibility> <${change.unitEligibility ?? eligibility}> ;
      <${rv}projection> <${anchor}> ; <${rv}language> "en" ;
      <${rv}field> <${rv}Body> ; <${rv}disclosure> <${rv}Public> ;
      <${rv}searchBody> "Bounded body"@${change.bodyLanguage ?? 'en'} . }`;
    const receiptData = `GRAPH <${graphs.receipts}> { <${receipt}> a <${rv}OperationReceipt> ;
      <${rv}requestDigest> ${JSON.stringify(receipt)} ; <${rv}outcome> <${rv}Succeeded> ;
      <${rv}resource> <${work}> ; <${rv}variant> <${variant}> ;
      <${rv}ownerDataEpoch> ${JSON.stringify(change.receiptOwner ?? owner)} ;
      <${rv}ownerSequence> "7" ; <${rv}contentRevision> <${contentRevision}> ;
      <${rv}publicationDecision> <${publication}> ; <${rv}eligibility> <${eligibility}> ;
      <${rv}matchUnit> <${unit}> ; <${rv}projection> <${anchor}> ;
      <${rv}datasetId> <${dataset}> ; <${rv}dataEpoch> ${JSON.stringify(epoch)} ;
      <${rv}sequence> ?next . }`;
    const {update} = await build(receipt, {data,receipt:receiptData,
      outbox:searchOutbox(receipt,epoch,'ContentProjectionEvent')});
    const checks = [
      ...(!change.omitProjectionFocus ? [profileValidation('content-match-unit-v1','projection',
        anchor,graphs.revisions)] : []),
      ...(!change.omitUnitFocus ? [profileValidation('content-match-unit-v1','unit',
        unit,searchGraph)] : []),
    ];
    return {receipt,unit,result:await command(receipt,update,checks)};
  };
  const epochBefore = BigInt((await (await fetch(`${base}/command`)).json()).publicSearchWriteEpoch);
  const good = await run('valid');
  if (good.result.status !== 'committed') throw new Error(JSON.stringify(good.result));
  const epochAfter = (await (await fetch(`${base}/command`)).json()) as {
    publicSearchWriteEpoch: string; publicSearchWriteActive: boolean };
  expect(BigInt(epochAfter.publicSearchWriteEpoch)).toBe(epochBefore + 2n);
  expect(epochAfter.publicSearchWriteActive).toBe(false);
  expect(await ask(`ASK { GRAPH <${searchGraph}> { <${good.unit}> a <${rv}MatchUnit> } }`)).toBe(true);
  for (const [name, change, report] of [
    ['eligibility', {unitEligibility:'urn:rezics:wrong-eligibility'}, 'MatchUnit link mismatch: eligibility'],
    ['language', {bodyLanguage:'fr'}, 'body language or byte limit mismatch'],
    ['receipt-owner', {receiptOwner:'00000000-0000-4000-8000-000000000004'},
      'receipt field mismatch: ownerDataEpoch'],
    ['unit-focus', {omitUnitFocus:true}, 'MatchUnit focus omitted'],
    ['projection-focus', {omitProjectionFocus:true}, 'Content projection focus omitted'],
    ['rights', {rights:false}, 'rightsBasis'],
  ] as const) {
    const failed = await run(name,change);
    expect(failed.result.status).toBe('invalid');
    expect(failed.result.report).toContain(report);
    await absent(failed.receipt);
    expect(await ask(`ASK { GRAPH <${searchGraph}> { <${failed.unit}> ?p ?o } }`)).toBe(false);
  }
  expect(BigInt((await (await fetch(`${base}/command`)).json()).publicSearchWriteEpoch))
    .toBe(epochBefore + 14n);
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
  const response = await fetch(`${base}/command`, {method:'POST', headers:{'content-type':'application/json',
    authorization: `Bearer ${process.env.FUSEKI_COMMAND_TOKEN}`},
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
  const response = await fetch(`${base}/command`, { method: 'POST',
    headers: { 'content-type': 'application/json',
      authorization: `Bearer ${process.env.FUSEKI_MAINTENANCE_TOKEN}` },
    body: JSON.stringify({ receipt: bootstrap, digest: 'rebootstrap', update: retry,
      validations: [], deadlineMs: 10000 }) });
  expect(response.status).toBe(200);
  expect((await response.json() as Result).status).toBe('invalid');
  await absent(bootstrap);
});

test('SYS02: maintenance receipt prefixes require the caller capability before replay or mutation', async () => {
  const bootstraps = (await select(`SELECT ?receipt WHERE { GRAPH <${graphs.receipts}> {
    ?receipt <${rv}requestDigest> ?digest }
    FILTER(STRSTARTS(STR(?receipt), "urn:rezics:receipt:bootstrap:")) }`)).results?.bindings ?? [];
  expect(bootstraps.length).toBe(1);
  const replay = await fetch(`${base}/command`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt: bootstraps[0]!.receipt!.value, digest: 'unknown',
      update: 'invalid', validations: [], deadlineMs: 10000 }) });
  expect(replay.status).toBe(403);
  for (const prefix of ['bootstrap', 'restore-cutover', 'restore-release', 'retained-zero']) {
    const receipt = `urn:rezics:receipt:${prefix}:${nonce}`;
    const {update} = await build(receipt);
    for (const authorization of [undefined, 'Bearer ' + '0'.repeat(64)]) {
      const response = await fetch(`${base}/command`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ receipt, digest: receipt, update, validations: [], deadlineMs: 10000 }) });
      expect(response.status).toBe(403);
      expect((await response.json() as Result).status).toBe('forbidden');
      await absent(receipt);
    }
  }
});

test('SYS02/SYS14: native head CAS and admission scope reject forged Work and selection mutations', async () => {
  const realm = `urn:rezics:p02:${nonce}:realm`;
  const cases = [
    { name: 'work-edit', predicate: 'head', result: 'workRevision',
      scope: (target: string) => `work:edit:${target}`, report: 'receipt expected head differs' },
    { name: 'main-selection', predicate: 'selectionHead', result: 'selection',
      scope: (target: string) => `publication:select:${target}`, report: 'receipt expected head differs' },
    { name: 'realm-selection', predicate: 'selectionHead', result: 'selection',
      scope: () => 'publication:adopt:wrong', report: 'Access scope differs' },
    { name: 'realm-rejection', predicate: 'selectionHead', result: 'rejection',
      scope: () => `publication:reject:${realm}`, report: 'receipt expected head differs' },
  ];
  for (const entry of cases) {
    const key = `urn:rezics:p02:${nonce}:head-${entry.name}`;
    const target = `${key}:target`, prior = `${key}:prior`, next = `${key}:next`;
    const receipt = `${key}:receipt`, batch = `${key}:batch`, event = `${key}:event`;
    const expected = entry.name === 'realm-selection' ? prior : `${key}:wrong`;
    const {epoch,routing} = await lineage();
    await fixtureUpdate(`PREFIX rv: <${rv}> INSERT DATA {
      GRAPH <${graphs.current}> { <${target}> rv:${entry.predicate} <${prior}> }
    }`);
    const role = entry.name.startsWith('realm-')
      ? `rv:slot <${target}> ; rv:realm <${realm}> ;`
      : entry.name === 'main-selection' ? `rv:mainVersion <${target}> ;` : `rv:work <${target}> ;`;
    const update = `PREFIX rv: <${rv}>
      DELETE { GRAPH <${graphs.control}> { <${dataset}> rv:sequence ?n }
        GRAPH <${graphs.current}> { <${target}> rv:${entry.predicate} <${prior}> } }
      INSERT { GRAPH <${graphs.control}> { <${dataset}> rv:sequence ?next }
        GRAPH <${graphs.current}> { <${target}> rv:${entry.predicate} <${next}> }
        GRAPH <${graphs.revisions}> { <${next}> a rv:RevisionAnchor ;
          rv:component <${target}> ; rv:predecessor <${prior}> . }
        GRAPH <${graphs.receipts}> { <${receipt}> a rv:OperationReceipt ;
          rv:requestDigest ${JSON.stringify(receipt)} ; rv:datasetId <${dataset}> ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence ?next ;
          rv:outcome rv:Succeeded ; rv:admissionId ${JSON.stringify(crypto.randomUUID())} ;
          rv:authorityEpoch "0" ; rv:admittedScope ${JSON.stringify(entry.scope(target))} ;
          rv:expectedHead <${expected}> ; ${role} rv:${entry.result} <${next}> . }
        GRAPH <${graphs.outbox}> { <${batch}> a rv:OutboxBatch ;
          rv:dataEpoch ${JSON.stringify(epoch)} ; rv:sequence ?next ;
          rv:eventCount 1 ; rv:event <${event}> .
          <${event}> a rv:WorkEditedEvent ; rv:ordinal 0 ; rv:receipt <${receipt}> . }
      } WHERE { GRAPH <${graphs.control}> { <${dataset}> rv:dataEpoch ${JSON.stringify(epoch)} ;
          rv:routingEpoch ${JSON.stringify(routing)} ; rv:sequence ?n . }
        GRAPH <${graphs.current}> { <${target}> rv:${entry.predicate} <${prior}> }
        BIND(?n + 1 AS ?next) }`;
    const denied = await fetch(`${base}/command`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt, digest: receipt, update, validations: [], deadlineMs: 10000 }) });
    expect(denied.status).toBe(403);
    await absent(receipt);
    const admitted = await command(receipt, update);
    expect(admitted.status).toBe('invalid');
    expect(admitted.report).toContain(entry.report);
    await absent(receipt);
    expect(await ask(`PREFIX rv: <${rv}> ASK { GRAPH <${graphs.current}> {
      <${target}> rv:${entry.predicate} <${prior}> } }`)).toBe(true);
  }
});

test('SYS02/SYS14: native Work edit commits one exact head and resolves competing edits', async () => {
  const {epoch,routing} = await lineage();
  const env = { fuseki: new FusekiClient(base),
    lineage: { dataEpoch: epoch, routingEpoch: routing },
    objectDirectory: join('.temp', `p02-head-${nonce}`) };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const title = `Head CAS ${nonce}`;
  const created = await activateMetadataWork(env, { title, admission: {
    id: crypto.randomUUID(), scope: 'work:create:root', action: 'work.create',
    idempotencyKey: `head-${nonce}`, requestDigest: metadataWorkRequestDigest(title),
    authorityEpoch: '0', expiresAt,
  } });
  const intent = (head: string, name: string) => ({ work: created.work, expectedHead: head,
    title: name, admission: { id: crypto.randomUUID(), scope: `work:edit:${created.work}`,
      action: 'work.edit', requestDigest: metadataWorkEditDigest(created.work, head, name),
      authorityEpoch: '0', expiresAt } });
  const first = await editMetadataWork(env, intent(created.workRevision, 'Head CAS first'));
  expect(first.predecessor).toBe(created.workRevision);
  const races = await Promise.allSettled([
    editMetadataWork(env, intent(first.revision, 'Head CAS contender A')),
    editMetadataWork(env, intent(first.revision, 'Head CAS contender B')),
  ]);
  expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(races.filter(result => result.status === 'rejected'
    && result.reason instanceof StaleWorkHead)).toHaveLength(1);
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
