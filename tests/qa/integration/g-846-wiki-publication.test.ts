import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { CommandOutcome, OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { propertyRevelationRecord } from '../../../services/main/src/modules/reading-position/store.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import { activateMetadataWork, metadataWorkRequestDigest, GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (iri: string) => iri.slice('https://rezics.com/id/'.length);
type Command = { proposal: string; revision: number; outcome: string; receipt?: OwnerReceipt };
const outcomeResult = (receipt: OwnerReceipt, suffix: string) => {
  const row = receipt.commands!.find(outcome => outcome.key.endsWith(`:${suffix}`))!;
  return row.result as { component: string; revision: string };
};

test('G-846: reviewed Pride and Prejudice chapters publish once, resume partial delivery, and retain evidence/disclosure/compensation', async () => {
  const f = await startMediaStack('g-846',{ profileCredits: true });
  const holder = await f.member('holder'), steward = await f.member('steward');
  const tokenPrincipals = new Map([[holder.token,holder.principal],[steward.token,steward.principal]]);
  const objects = f.objects('semantic/structure/'); await objects.initialize();
  const reading = new ReadingPositionStore(f.contentPool), evidence = new WikiEvidenceStore(f.contentPool);
  const nativePublish = evidence.publish.bind(evidence);
  const nativeReveal = evidence.reveal.bind(evidence);
  let interruptRevelation = false;
  evidence.reveal = async (...args) => {
    if (interruptRevelation) { interruptRevelation = false; throw new Error('Position transaction interrupted'); }
    return nativeReveal(...args);
  };
  let pausePublication: string | null = null;
  evidence.publish = async (...args) => {
    if (args[1] === pausePublication) { pausePublication = null; throw new Error('Evidence owner interrupted before commit'); }
    return nativePublish(...args);
  };
  const nativeClaim = f.access.claim.bind(f.access);
  let revokeAtClaim: string | null = null;
  f.access.claim = async (...args) => {
    const admission = (await f.accessPool.query<{ scope_id: string }>('SELECT scope_id FROM access.admission WHERE id = $1',[args[0]])).rows[0];
    if (revokeAtClaim && admission?.scope_id === 'semantic:create:root') {
      await f.accessPool.query(`UPDATE access.permission_grant SET active = false
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.edit'`,[steward.actor,`work:edit:${revokeAtClaim}`]);
      revokeAtClaim = null;
    }
    return nativeClaim(...args);
  };
  let loseEntity = 0, rejectEntity = 0, hideReceipts = false, semanticWrites = 0;
  const nativeGraph = f.env.fuseki;
  const graph = new Proxy(nativeGraph,{ get(target,property) {
    if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
      const semantic = envelope.update.includes('SemanticChangedEvent');
      if (semantic && rejectEntity && --rejectEntity === 0) return { status: 'invalid' as const,report: { conforms: false } };
      const result = await target.commandWithReceipt(envelope);
      if (semantic) semanticWrites++;
      if (semantic && loseEntity && --loseEntity === 0) { hideReceipts = true; throw new Error('lost owner acknowledgement'); }
      return result;
    };
    if (property === 'query') return (...args: Parameters<typeof target.query>) => {
      if (hideReceipts && args[0].includes('SELECT ?outcome') && args[0].includes('?admissionId')) throw new Error('receipt read interrupted');
      return target.query(...args);
    };
    const value: unknown = Reflect.get(target,property,target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  f.access.configureBaseline(graph);
  const deps: MainWorkDependencies = { environment: { ...f.env,fuseki: graph },access: f.access,
    account: { verify: async request => {
      const principal = tokenPrincipals.get(request.headers.get('authorization')?.replace('Bearer ','') ?? '');
      if (!principal) throw new Error('QA bearer is missing'); return principal;
    } },structureObjects: objects,wikiEvidence: evidence,wikiQuotations: new WikiQuotationStore(f.contentPool),
    media: f.media,mediaAccess: f.mediaAccess,readingPositions: reading,editorialReview: new EditorialReviewStore(f.accessPool),rights: { store: new RightsStore(f.contentPool,f.accessPool) } };
  let app = createMainApp(graph,deps);
  const call = (method: string,path: string,body?: object,token: string | null = holder.token,key = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}${method === 'GET' && token ? `${path.includes('?') ? '&' : '?'}actingSubject=${token === steward.token ? steward.actor : holder.actor}` : ''}`,{ method,headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}) },...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response,status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`${response.status} expected ${status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const path = (proposal: string,suffix = '') => `/v1/editorial/proposals/${proposal}${suffix}`;
  const decide = (proposal: string,revision: number,key = randomUUID(),token = steward.token,actor = steward.actor) =>
    call('POST',path(proposal,'/decisions'),{ profile: 'editorial-proposal-decide-v1',revision,outcome: 'applied',
      approve: true,message: 'Checked chapter citations',actingSubject: actor },token,key);
  const apply = async (proposal: string,revision: number,key = randomUUID(),token = steward.token,actor = steward.actor) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await decide(proposal,revision,key,token,actor);
      const result = await json<Command>(response,response.status === 202 ? 202 : 200);
      if (result.receipt) return result.receipt;
    }
    throw new Error('Bundle did not finish its bounded deliveries');
  };
  const refuse = async (proposal: string,revision: number,suffix: string,token = steward.token,actor = steward.actor) => {
    const key = randomUUID();
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await decide(proposal,revision,key,token,actor);
      if (response.status === 202) { await json<Command>(response,202); continue; }
      const refusal = await json<{ blocker: { code: string; key: string; reason: string } }>(response,409);
      expect(refusal.blocker).toEqual({ code: 'owner_command_refused',
        key: `wiki:${proposal}:${revision}:${suffix}`,reason: 'owner_rejected' });
      expect(await json(await decide(proposal,revision,key,token,actor),409)).toMatchObject(refusal);
      // Refused items are durable, but cannot produce an applied decision or
      // allow later items to overtake them, including after a store restart.
      deps.editorialReview = new EditorialReviewStore(f.accessPool); app = createMainApp(graph,deps);
      const recovered = await json<{ proposal: { decision: null }; blockers: unknown[] }>(await call('POST',
        path(proposal,'/recovery'),{ profile: 'editorial-proposal-recover-v1' },null));
      expect(recovered.proposal.decision).toBeNull();
      expect(recovered.blockers).toContainEqual(refusal.blocker);
      expect((await f.accessPool.query(`SELECT o.outcome,o.owner_receipt FROM access.editorial_application_outcome o
        JOIN access.editorial_application a ON a.id = o.application WHERE a.proposal = $1`,[proposal])).rows)
        .toEqual([{ outcome: 'cancelled',owner_receipt: null }]);
      return (await f.accessPool.query<{ outcome: CommandOutcome }>(`SELECT o.outcome FROM access.editorial_command_outcome o
        JOIN access.editorial_application a ON a.id = o.application WHERE a.proposal = $1 ORDER BY o.position`,[proposal])).rows
        .map(row => row.outcome);
    }
    throw new Error('Bundle refusal did not finish its bounded deliveries');
  };
  const proposalFor = async (bundle: WikiExtraction) => {
    const rows = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH <${GRAPHS.current}> {
      <${bundle.target}> rv:head ?head } }`)).results?.bindings ?? [];
    const head = rows[0]!.head!.value;
    return json<Command>(await call('POST','/v1/editorial/proposals',{ profile: 'editorial-proposal-create-v1',kind: 'wiki-bundle',
      target: { resource: bundle.target,revision: head,context: 'urn:rezics:context:global' },candidate: bundle,
      baseHeads: [{ component: bundle.target,head }],evidence: [],actingSubject: holder.actor }),201);
  };
  const setup = async (publicWork: boolean) => {
    const title = publicWork ? 'Pride and Prejudice' : 'Private Pride and Prejudice';
    const types = ['https://schema.org/Book'];
    const work = await activateMetadataWork(f.env,{ title,language: 'en',semanticTypes: types,
      admission: f.admission(holder.actor,'work:create:root','work.create',metadataWorkRequestDigest(title,types,'en')) });
    if (publicWork) {
      const english = await f.contribution(work.work,holder.actor,'en','Pride and Prejudice, chapters 1–3');
      await f.contribution(work.work,holder.actor,'fr','Orgueil et Préjugés, chapitres 1–3');
      const selection = { context: { kind: 'main-version-default' as const,id: work.mainVersion },work: work.work,
        contribution: english.contribution,publicationDecision: english.decision,expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const,actingSubject: holder.actor };
      await selectMainDefault(f.env,f.admission(holder.actor,`publication:select:${work.mainVersion}`,
        'publication.select',mainSelectionDigest(selection)),selection);
    }
    for (const member of [holder,steward]) await f.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'agent.control','infinity') ON CONFLICT DO NOTHING`,
    [randomUUID(),member.principalId,member.actor]);
    await holder.grant(`work:read:${work.work}`,'work.read'); await holder.grant(`work:edit:${work.work}`,'work.edit');
    await steward.grant(`work:read:${work.work}`,'work.read'); await steward.grant(`work:review:${work.work}`,'work.review');
    await steward.grant(`work:edit:${work.work}`,'work.edit');
    const structure = await json<{ structure: string; revision: string }>(await call('POST','/v1/compositions',{
      profile: 'book-composition',work: work.work,mainVersion: work.mainVersion,actingSubject: holder.actor }),201);
    const chapters = await json<{ occurrences: string[] }>(await call('POST',`/v1/compositions/${short(structure.structure)}/changes`,{
      profile: 'book-composition',expectedHead: structure.revision,actingSubject: holder.actor,
      operations: [1,2,3].map(n => ({ op: 'insert',parent: structure.structure,role: 'chapter',position: 'last',
        target: 'https://schema.org/DigitalDocument',label: { value: `Chapter ${n}`,language: 'en' } })) }));
    const collections: Record<string,string> = {};
    for (const segment of ['franchise','characters','places','events','chapters']) {
      const collection = id();
      await holder.grant(`collection:edit:${collection}`,'collection.edit');
      await steward.grant(`collection:edit:${collection}`,'collection.edit'); await holder.grant(`semantic:read:${collection}`,'semantic.read');
      const created = await json<{ structure: string; revision: string }>(await call('POST','/v1/collections',{
        collection,name: segment,language: 'en',disclosure: 'public',actingSubject: holder.actor }),201);
      if (segment === 'franchise') await json(await call('POST',`/v1/collections/${short(collection)}/changes`,{
        expectedHead: created.revision,actingSubject: holder.actor,operations: [{ op: 'insert',parent: created.structure,
          role: 'member',position: 'last',target: work.work }] }));
      collections[segment] = collection;
    }
    await holder.grant('space:create:root','space.create');
    const space = await json<{ space: string }>(await call('POST','/v1/spaces',{ profile: 'space-realm-v1',name: 'Pride and Prejudice wiki',
      capabilities: ['realm'],actingSubject: holder.actor }),201);
    const zone = id(); await holder.grant(`zone:edit:${zone}`,'zone.edit'); await holder.grant(`semantic:read:${zone}`,'semantic.read');
    let navigation = await json<{ revision: string }>(await call('POST','/v1/zones',{ zone,space: space.space,disclosure: 'public',actingSubject: holder.actor }),201);
    for (const [routeSegment,target] of Object.entries(collections)) navigation = await json(await call('POST',`/v1/zones/${short(zone)}/mounts`,{
      expectedHead: navigation.revision,target,routeSegment,position: 'last',disclosure: 'public',actingSubject: holder.actor }));
    await holder.grant('semantic:create:root','semantic.change');
    await steward.grant('semantic:create:root','semantic.change');
    await steward.grant('relation:create:root','relation.change');
    await steward.grant(`statement:speak:${steward.actor}`,'statement.record');
    await steward.grant(`statement:speak:${steward.actor}`,'statement.withdraw');
    const property = await json<{ component: string }>(await call('POST','/v1/semantic/changes',{ profile: 'semantic-change-v1',
      expectedHead: null,actingSubject: holder.actor,state: { component: 'definition',kind: 'property' } }),201);
    await holder.grant(`semantic:read:${property.component}`,'semantic.read');
    const relation = await json<{ component: string }>(await call('POST','/v1/semantic/changes',{ profile: 'semantic-change-v1',
      expectedHead: null,actingSubject: holder.actor,state: { component: 'definition',kind: 'relation',roles: [
        { key: 'subject',minParticipants: 1,maxParticipants: 1,ordered: false },
        { key: 'object',minParticipants: 1,maxParticipants: 1,ordered: false }] } }),201);
    await holder.grant(`semantic:read:${relation.component}`,'semantic.read');
    const source = { representationSha256: (publicWork ? 'a' : 'b').repeat(64),mediaType: 'text/plain',language: 'en',
      rightsBasis: 'public_domain' as const,method: { agent: 'Holder extraction agent',model: 'local',inference: 'local' as const } };
    const evidenceFor = (quote: string) => ({ quote,locator: { version: 'rezics-locator-v1' as const,source: { type: 'external' as const,
      representationSha256: source.representationSha256,mediaType: source.mediaType },selector: { type: 'TextQuoteSelector' as const,exact: quote } } });
    const bundle: WikiExtraction = { profile: 'wiki-extraction-v1',target: work.work,continuity: work.work,zone,source,
      units: chapters.occurrences.map((occurrence,index) => ({ id: `ch${index + 1}`,ordinal: index,label: `Chapter ${index + 1}`,occurrence })),
      entities: [{ id: 'elizabeth',type: `${RV}Character`,names: [{ value: 'Elizabeth Bennet',language: 'en',kind: 'primary',revealedAt: 'ch1' },
        { value: 'Lizzy',language: 'en',kind: 'alias',revealedAt: 'ch2' }] },
      { id: 'jane',type: `${RV}Character`,names: [{ value: 'Jane Bennet',language: 'en',kind: 'primary',revealedAt: 'ch1' }] }],
      claims: [{ subject: 'elizabeth',predicate: property.component,object: { kind: 'literal',value: 'Bennet family' },
        modality: 'narrated',continuity: work.work,revealedAt: 'ch1',evidence: [evidenceFor('The Bennet family')] },
      { subject: 'elizabeth',predicate: relation.component,object: { kind: 'entity',ref: 'jane' },modality: 'narrated',
        continuity: work.work,revealedAt: 'ch3',evidence: [evidenceFor('Elizabeth and Jane')] }] };
    return { work,bundle,collections };
  };
  try {
    const shown = await setup(true), proposal = await proposalFor(shown.bundle);
    await json(await call('POST',path(proposal.proposal,'/reviews'),{ profile: 'editorial-proposal-review-v1',revision: 1,
      outcome: 'request_changes',message: 'Check the alias chapter',actingSubject: steward.actor },steward.token));
    const current = await json<{ revision: { baseHeads: unknown[] } }>(await call('GET',path(proposal.proposal)));
    await json(await call('POST',path(proposal.proposal,'/revisions'),{ profile: 'editorial-proposal-revise-v1',revision: 1,
      candidate: shown.bundle,baseHeads: current.revision.baseHeads,evidence: [],actingSubject: holder.actor }));
    // The same operator cannot approve from a second represented Agent.
    const secondAgent = id();
    await f.accessPool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')",[secondAgent]);
    await f.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`,[randomUUID(),holder.principalId,secondAgent]);
    expect((await decide(proposal.proposal,2,randomUUID(),holder.token,secondAgent)).status).toBe(403);
    const beforePositionFailure = semanticWrites;
    interruptRevelation = true;
    const applyKey = randomUUID();
    await json(await decide(proposal.proposal,2,applyKey),202);
    expect(semanticWrites).toBe(beforePositionFailure);
    expect((await f.contentPool.query('SELECT record FROM wiki.revelation_record')).rowCount).toBe(0);
    loseEntity = 2;
    await json(await decide(proposal.proposal,2,applyKey),202);
    expect((await f.accessPool.query(`SELECT position FROM access.editorial_command_outcome o
      JOIN access.editorial_application a ON a.id = o.application WHERE a.proposal = $1 ORDER BY position`,[proposal.proposal])).rows)
      .toEqual([{ position: 0 },{ position: 1 }]);
    hideReceipts = false;
    deps.editorialReview = new EditorialReviewStore(f.accessPool); app = createMainApp(graph,deps);
    const receipt = await apply(proposal.proposal,2,applyKey), writes = semanticWrites;
    expect(await apply(proposal.proposal,2,applyKey)).toEqual(receipt);
    expect(semanticWrites).toBe(writes);
    const elizabeth = outcomeResult(receipt,'entity:elizabeth').component;
    const jane = outcomeResult(receipt,'entity:jane').component;
    const statement = outcomeResult(receipt,'claim:0').component, relationship = outcomeResult(receipt,'claim:1').component;
    const revealed = await reading.lookup([elizabeth,jane,statement,relationship]);
    expect([...revealed.keys()].sort()).toEqual([elizabeth,jane,statement,relationship].sort());
    expect(receipt.commands!.map(command => command.outcome)).toEqual(receipt.commands!.map(() => 'applied'));
    const quoteIds = (receipt.owner as { evidence: string[] }).evidence;
    expect(quoteIds).toHaveLength(2);
    const quote = await json<{ quote: string }>(await call('GET',`/v1/wiki/evidence/${short(quoteIds[0]!)}?position=all`,undefined,null));
    expect(quote.quote).toBe('The Bennet family');
    const page = await call('GET',`/v1/resources/${short(elizabeth)}/page?position=all`,undefined,null);
    expect(page.status).toBe(200);
    const routes = await json<{ [key: string]: unknown }>(await call('GET',`/v1/zones/${short(shown.bundle.zone)}/routes?path=/characters/${short(elizabeth)}&position=all`,undefined,null));
    expect(JSON.stringify(routes)).toContain(elizabeth);
    // Every published claim has real retained evidence; every semantic record
    // and language-tagged name emitted by the adapter has a revelation position.
    for (const outcome of receipt.commands!.filter(outcome => /:entity:|:claim:/.test(outcome.key) && outcome.outcome === 'applied')) {
      const record = (outcome.result as { component: string }).component;
      expect((await reading.lookup([record])).get(record)).toHaveLength(1);
    }
    const nameIds = shown.bundle.entities.flatMap(entity => entity.names.map(name => propertyRevelationRecord(
      outcomeResult(receipt,`entity:${entity.id}`).component,
      `https://schema.org/${name.kind === 'alias' ? 'alternateName' : 'name'}`,
      { kind: 'language-string',lexical: name.value,language: name.language })));
    expect((await reading.lookup(nameIds)).size).toBe(nameIds.length);
    const evidenceRows = await f.contentPool.query('SELECT claim FROM wiki.evidence WHERE id = ANY($1::text[])',[quoteIds]);
    expect(evidenceRows.rows.map(row => row.claim).sort()).toEqual([statement,relationship].sort());
    await steward.grant('rights:assess','rights.assess');
    const restrictionKey = randomUUID();
    await json(await call('POST','/v1/rights/use-assessments',{ profile: 'rights-use-assessment-v1',actingSubject: steward.actor,
      material: { scopeKind: 'wiki_evidence',provider: null,namespace: null,sourceRecordId: null,contentVariantId: null,wikiEvidenceId: quoteIds[0],
        mediaAsset: null,component: 'record' },expressionKind: 'expression',family: 'data_rights',useKind: 'quotation',
      useScope: 'rezics:export:quotation',basis: 'permission',outcome: 'not_supported',licenseInstrument: null,exceptionKind: null,
      rationale: null,extent: {},evidence: {},obligations: [],expectedAssessment: null,idempotencyKey: restrictionKey },steward.token,restrictionKey),201);
    const restricted = await json<{ quote: null; locator: unknown; quoteWithheld: boolean }>(await call('GET',`/v1/wiki/evidence/${short(quoteIds[0]!)}?position=all`,undefined,null));
    expect(restricted.quote).toBeNull(); expect(restricted.quoteWithheld).toBe(true);
    expect(JSON.stringify(restricted.locator)).not.toContain('The Bennet family');
    expect(await (await call('GET',path(proposal.proposal),undefined,null)).text()).not.toContain('The Bennet family');
    expect(JSON.stringify(await apply(proposal.proposal,2,applyKey))).not.toContain('The Bennet family');
    const hidden = await setup(false), hiddenProposal = await proposalFor(hidden.bundle), hiddenReceipt = await apply(hiddenProposal.proposal,1);
    const hiddenCharacter = outcomeResult(hiddenReceipt,'entity:elizabeth').component;
    expect((await call('GET',`/v1/resources/${short(hiddenCharacter)}/page?position=all`,undefined,null)).status).toBe(404);
    expect((await call('GET',`/v1/statements/${short(outcomeResult(hiddenReceipt,'claim:0').component)}?position=all`,undefined,null)).status).toBe(404);
    expect((await f.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> { <${hiddenCharacter}> <${RV}semanticWork> ?work } }`)).boolean).toBe(false);
    expect((await call('GET',`/v1/wiki/evidence/${short((hiddenReceipt.owner as { evidence: string[] }).evidence[0]!)}?position=all`,undefined,null)).status).toBe(404);
    // A missing revelation stays hidden even for an explicit all-position read.
    const heldPosition = (await reading.lookup([statement])).get(statement)![0]!;
    await f.contentPool.query('DELETE FROM reading_position.revelation WHERE record = $1',[statement]);
    expect((await call('GET',`/v1/statements/${short(statement)}?position=all`,undefined,null)).status).toBe(404);
    expect((await call('GET',`/v1/wiki/evidence/${short(quoteIds[0]!)}?position=all`,undefined,null)).status).toBe(404);
    await nativeReveal(shown.work.work,[heldPosition],[]);
    // Ordinary semantic permission alone cannot edit an entity of another Work.
    const matched = await setup(true);
    matched.bundle.entities[0]!.match = elizabeth;
    matched.bundle.entities[0]!.names.push({ value: 'Foreign-work alias',language: 'en',kind: 'alias',revealedAt: 'ch3' });
    await steward.grant(`semantic:edit:${elizabeth}`,'semantic.change');
    await f.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.edit'`,[steward.actor,`work:edit:${shown.work.work}`]);
    const matchedProposal = await proposalFor(matched.bundle);
    const writesBeforeDenial = semanticWrites;
    // Known missing authority is refused before application. Mid-delivery
    // revocation is exercised separately through revokeAtClaim below.
    expect(await json(await decide(matchedProposal.proposal,1),403)).toMatchObject({
      code: 'editorial_owner_authority_required',
      blocker: { code: 'owner_authority_required', action: 'semantic.change', scope: `semantic:edit:${elizabeth}` },
    });
    expect(semanticWrites).toBe(writesBeforeDenial);
    expect((await f.accessPool.query('SELECT 1 FROM access.editorial_application WHERE proposal = $1',
      [matchedProposal.proposal])).rows).toEqual([]);
    expect((await f.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> { <${elizabeth}> <https://schema.org/alternateName> "Foreign-work alias"@en } }`)).boolean).toBe(false);
    await f.accessPool.query(`UPDATE access.permission_grant SET active = true
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.edit'`,[steward.actor,`work:edit:${shown.work.work}`]);
    for (const component of [elizabeth,outcomeResult(receipt,'entity:jane').component]) {
      await steward.grant(`semantic:edit:${component}`,'semantic.change');
    }
    await steward.grant(`relation:edit:${relationship}`,'relation.change');
    const reversal = await json<Command>(await call('POST',path(proposal.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence: [],actingSubject: holder.actor }),201);
    const otherSteward = await f.member('other-steward');
    tokenPrincipals.set(otherSteward.token,otherSteward.principal);
    await f.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`,[randomUUID(),otherSteward.principalId,otherSteward.actor]);
    await otherSteward.grant(`work:read:${shown.work.work}`,'work.read');
    await otherSteward.grant(`work:review:${shown.work.work}`,'work.review');
    await otherSteward.grant(`work:edit:${shown.work.work}`,'work.edit');
    for (const collection of Object.values(shown.collections)) await otherSteward.grant(`collection:edit:${collection}`,'collection.edit');
    for (const component of [elizabeth,jane]) await otherSteward.grant(`semantic:edit:${component}`,'semantic.change');
    await otherSteward.grant(`relation:edit:${relationship}`,'relation.change');
    await otherSteward.grant(`statement:speak:${otherSteward.actor}`,'statement.withdraw');
    const refusedRetraction = await refuse(reversal.proposal,1,'retract-claim:0',otherSteward.token,otherSteward.actor);
    expect(refusedRetraction.at(-1)).toMatchObject({ outcome: 'rejected' });
    expect(refusedRetraction.some(command => /:retract-claim:1$|:retract-entity:/.test(command.key))).toBe(false);
    expect((await f.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> { <${statement}> <${RV}statementState> <${RV}Active> } }`)).boolean).toBe(true);
    expect((await call('GET',`/v1/resources/${short(elizabeth)}/page?position=all`,undefined,null)).status).toBe(200);
    expect((await f.contentPool.query('SELECT id FROM wiki.evidence WHERE id = ANY($1::text[])',[quoteIds])).rowCount).toBe(2);
    // Successful compensation still reaches every owner when the original
    // personal speaker withdraws their own statement.
    const compensating = await setup(true), compensatingProposal = await proposalFor(compensating.bundle);
    const compensatingReceipt = await apply(compensatingProposal.proposal,1);
    for (const entity of ['elizabeth','jane']) await steward.grant(
      `semantic:edit:${outcomeResult(compensatingReceipt,`entity:${entity}`).component}`,'semantic.change');
    await steward.grant(`relation:edit:${outcomeResult(compensatingReceipt,'claim:1').component}`,'relation.change');
    const compensation = await json<Command>(await call('POST',path(compensatingProposal.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence: [],actingSubject: holder.actor }),201);
    const compensated = await apply(compensation.proposal,1);
    expect(compensated.commands!.map(command => command.outcome)).toEqual(compensated.commands!.map(() => 'applied'));
    expect(compensated.commands!.find(command => command.key.endsWith(':retract-claim:0'))?.outcome).toBe('applied');
    expect((await f.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      <${outcomeResult(compensatingReceipt,'claim:0').component}> <${RV}statementState> <${RV}Withdrawn> } }`)).boolean).toBe(true);
    expect((await call('GET',`/v1/resources/${short(outcomeResult(compensatingReceipt,'entity:elizabeth').component)}/page?position=all`,undefined,null)).status).toBe(404);
    const compensatedEvidence = (compensatingReceipt.owner as { evidence: string[] }).evidence;
    expect((await f.contentPool.query('SELECT id FROM wiki.evidence WHERE id = ANY($1::text[])',[compensatedEvidence])).rowCount).toBe(2);
    const rejected = await setup(true), rejectedProposal = await proposalFor(rejected.bundle);
    rejectEntity = 1;
    const rejectedOutcomes = await refuse(rejectedProposal.proposal,1,'entity:elizabeth');
    expect(rejectedOutcomes.map(command => [command.key.split(':').slice(3).join(':'),command.outcome]))
      .toEqual([['evidence','applied'],['entity:elizabeth','rejected']]);
    expect((await f.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> { ?entity <${RV}semanticWork> <${rejected.work.work}> } }`)).boolean).toBe(false);
    // Claim rechecks the Work mandate for creation as well as target edits;
    // losing it after registration cannot publish a Work link or any record.
    const revoked = await setup(true), revokedProposal = await proposalFor(revoked.bundle), beforeRevocation = semanticWrites;
    revokeAtClaim = revoked.work.work;
    const revokedOutcomes = await refuse(revokedProposal.proposal,1,'entity:elizabeth');
    expect(revokedOutcomes.map(command => [command.key.split(':').slice(3).join(':'),command.outcome]))
      .toEqual([['evidence','applied'],['entity:elizabeth','rejected']]);
    expect(semanticWrites).toBe(beforeRevocation);
    expect((await f.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> { ?entity <${RV}semanticWork> <${revoked.work.work}> } }`)).boolean).toBe(false);
    // Distinct incoming passages cannot race past the Work-wide allowance.
    const currentPoints = Number((await f.contentPool.query('SELECT sum(code_points)::text AS total FROM wiki.quotation WHERE work = $1',
      [hidden.work.work])).rows[0].total);
    let remaining = 10000 - currentPoints - 200;
    for (let n = 0; remaining > 0; n++) {
      const points = Math.min(remaining,200); remaining -= points;
      await f.contentPool.query(`INSERT INTO wiki.quotation(work,representation_sha256,locator_digest,quote_digest,
        code_points,policy_version,applied_receipt) VALUES ($1,$2,$3,$3,$4,1,'fixture')`,
      [hidden.work.work,'c'.repeat(64),n.toString(16).padStart(64,'0'),points]);
    }
    const passages = ['x','y','z'].map(letter => {
      const bundle = structuredClone(hidden.bundle);
      bundle.claims = [bundle.claims[0]!];
      bundle.claims[0]!.evidence[0]!.quote = letter.repeat(150);
      bundle.claims[0]!.evidence[0]!.locator.selector = { type: 'TextQuoteSelector',exact: letter.repeat(150) };
      return bundle;
    });
    const candidates = [];
    for (const bundle of passages) candidates.push(await proposalFor(bundle));
    const raceKeys = candidates.map(() => randomUUID());
    const suspended = candidates.pop()!, suspendedKey = raceKeys.pop()!;
    pausePublication = suspended.proposal;
    await json(await decide(suspended.proposal,1,suspendedKey),202);
    const raced = await Promise.all(candidates.map(async (proposal,index) => {
      const response = await decide(proposal.proposal,1,raceKeys[index]!);
      if (response.status === 409) {
        const problem = await json<{ code: string; blocker: { code: string } }>(response,409);
        expect(problem.code).toBe('editorial_budget_exhausted');
        return { ...proposal,outcome: 'cancelled',blocker: problem.blocker };
      }
      const result = await json<Command & { blocker?: { code: string } }>(response,response.status === 202 ? 202 : 200);
      if (result.outcome === 'apply_pending') return { ...result,outcome: 'applied',receipt: await apply(proposal.proposal,1,raceKeys[index]!) };
      return result;
    }));
    expect(raced.map(result => result.outcome).sort()).toEqual(['applied','cancelled']);
    expect(raced.find(result => result.outcome === 'cancelled')?.blocker?.code).toBe('budget_exhausted');
    const retryBudget = await json<{ blocker: { code: string } }>(await decide(suspended.proposal,1,suspendedKey),409);
    expect(retryBudget.blocker.code).toBe('budget_exhausted');
    expect((await f.accessPool.query(`SELECT outcome FROM access.editorial_application_outcome o
      JOIN access.editorial_application a ON a.id = o.application WHERE a.proposal = $1`,[suspended.proposal])).rows)
      .toEqual([{ outcome: 'cancelled' }]);
    const cancelled = raced.find(result => result.outcome === 'cancelled')!;
    expect((await f.accessPool.query(`SELECT admission FROM access.editorial_command_admission c
      JOIN access.editorial_application a ON a.id = c.application WHERE a.proposal = $1`,[cancelled.proposal])).rowCount).toBe(0);
    expect((await f.contentPool.query('SELECT id FROM wiki.evidence WHERE applied_receipt = $1',
      [`urn:rezics:wiki-evidence:${cancelled.proposal}:1`])).rowCount).toBe(0);
    expect((await f.accessPool.query(`SELECT outcome FROM access.editorial_application_outcome o
      JOIN access.editorial_application a ON a.id = o.application WHERE a.proposal = $1`,[cancelled.proposal])).rows)
      .toEqual([{ outcome: 'cancelled' }]);
    expect(Number((await f.contentPool.query('SELECT sum(code_points)::text AS total FROM wiki.quotation WHERE work = $1',
      [hidden.work.work])).rows[0].total)).toBe(9950);
  } finally { await f.stop(); }
},120000);
