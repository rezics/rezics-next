import { canonicalCandidate, EditorialBlocked, EditorialInvalid, type ApplyInput, type CommandOutcome,
  type EditorialCommand, type OwnerReceipt } from '../editorial-review/contract.ts';
import type { EditorialRuntime } from '../editorial-review/runtime.ts';
import { changeSemanticComponent, semanticChangeDigest, readSemanticChangeTerminal, type ComponentInput } from '../semantic/change.ts';
import { cancelSemanticAdmission, familyReceiptIri } from '../semantic/command.ts';
import { SEMANTIC_TERMS } from '../semantic/schema.ts';
import { canonicalRelation, changeRelationOccurrence, readRelationChangeTerminal, relationChangeDigest,
  type RelationInput } from '../relation/change.ts';
import { recordStatement, recordStatementRequest, STATEMENT_FAMILIES, type RecordStatementInput } from '../statement/graph.ts';
import { readCommandReceipt, sealCommandTerminal } from '../context/command.ts';
import { changeComposition, compositionChangeDigest, readCompositionReceipt, sealStructureAdmissionCancellation,
  type CompositionOperation } from '../structure/change.ts';
import { propertyRevelationRecord, type Revelation } from '../reading-position/store.ts';
import { derivedId } from '../structure/graph.ts';
import { publicCatalogueWork } from '../access/role-proof.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { evidenceId, evidenceReceipt } from './evidence.ts';
import { commandResult, wikiGraphCommand, type WikiGraphCommand } from './apply-runtime.ts';
import { extractionCandidate, wikiSegment, type WikiSnapshot } from './apply-snapshot.ts';
import type { WikiExtraction } from './protocol.ts';
type WikiEntity = WikiExtraction['entities'][number];

export const WIKI_APPLY_COST = { entities: 128, claims: 256, evidence: 4096, collectionBatch: 16,
  commands: 600, headsPerEntity: 1 } as const;
export function wikiItemKey(input: Pick<ApplyInput,'revision'>, item: string): string {
  const prefix = `wiki:${input.revision.proposal}:${input.revision.n}:`;
  // A full local entity id plus a retraction prefix can exceed the admission
  // key bound. Keep ordinary keys readable and hash only that long suffix.
  return prefix + (prefix.length + item.length <= 128 ? item : canonicalCandidate(item).digest);
}
const resultFor = (settled: readonly CommandOutcome[], key: string) => commandResult(settled.find(outcome => outcome.key === key));
const resource = (settled: readonly CommandOutcome[], key: string) => {
  const value = resultFor(settled,key)?.component;
  return typeof value === 'string' ? value : null;
};
export function wikiEntityState(entity: WikiEntity, snapshot: WikiSnapshot): ComponentInput {
  const old = snapshot.entities[entity.id]?.state;
  if (old && old.component !== 'resource') throw new EditorialInvalid('Wiki entity crosses component owners');
  const properties = [...old?.properties ?? [],...entity.names.map(name => ({
    predicate: `https://schema.org/${name.kind === 'alias' ? 'alternateName' : 'name'}`,
    value: { kind: 'language-string' as const,lexical: name.value,language: name.language } }))];
  return { component: 'resource',types: old?.types ?? [entity.type],lifecycle: 'active',
    properties: [...new Map(properties.map(property => [canonicalCandidate(property).digest,property])).values()] };
}
export function semanticSpec(runtime: EditorialRuntime, target: string | undefined, head: string | null,
  state: ComponentInput, beforeCommit?: (component: string, receipt: string) => Promise<void>): WikiGraphCommand {
  const env = runtime.work.environment;
  return { binding: { action: 'semantic.change',scope: target ? `semantic:edit:${target}` : 'semantic:create:root',
    digest: semanticChangeDigest(target,head,state) },read: id => readSemanticChangeTerminal(env,id),
  dispatch: admission => changeSemanticComponent(env,{ admission,...(target ? { target } : {}),expectedHead: head,state,beforeCommit }),
  cancel: admission => cancelSemanticAdmission(env,familyReceiptIri(admission.id,'semantic-change'),admission) };
}
export async function wikiCommands(runtime: EditorialRuntime, input: ApplyInput): Promise<EditorialCommand[]> {
  const bundle = extractionCandidate(input.revision.candidate), snapshot = input.revision.before as unknown as WikiSnapshot;
  const evidence = runtime.work.wikiEvidence;
  if (!evidence || !runtime.work.readingPositions) throw new EditorialBlocked({ code: 'owner_unavailable' });
  const env = runtime.work.environment, key = (item: string) => wikiItemKey(input,item);
  const allEvidence = bundle.claims.flatMap((claim,c) => claim.evidence.map((_e,e) => evidenceId(input.revision.proposal,input.revision.n,c,e)));
  const evidenceOutcome = (publicWork: boolean): CommandOutcome => ({ key: key('evidence'),outcome: 'applied',
    receipt: evidenceReceipt(input.revision.proposal,input.revision.n),result: { evidence: allEvidence,publicWork } });
  const published = () => evidence.published(input.revision.proposal,input.revision.n,allEvidence.length);
  const commands: EditorialCommand[] = [{ key: key('evidence'),
    prepare: async () => ({ action: 'wiki.evidence',scope: `work:edit:${bundle.target}`,digest: input.revision.candidateDigest }),
    resolve: async () => {
      // Public/private is retained with the first settled command by the kernel.
      // An interrupted Content commit has no public graph effects yet.
      return allEvidence.length && await published() ? evidenceOutcome(await publicCatalogueWork(env.fuseki,bundle.target)) : null;
    },
    execute: async () => {
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(bundle.target)} rv:head ?head } } LIMIT 2`,4096)).results?.bindings ?? [];
      const head = rows[0]?.head?.value;
      if (rows.length !== 1 || head !== input.expectedHeads[0]?.head) throw new EditorialBlocked({ code: 'stale_base',
        expectedHeads: input.expectedHeads,actualHeads: [{ component: bundle.target,head: head ?? null }] });
      const principal = await runtime.work.account.verify(runtime.request,['work:review']);
      const authorize = runtime.work.access.withWorkEditAuthority;
      if (!authorize) throw new EditorialBlocked({ code: 'owner_unavailable' });
      await authorize.call(runtime.work.access,principal,input.permit.decidingAgent,bundle.target,async () =>
        evidence.publish(bundle,input.revision.proposal,input.revision.n,snapshot.submitter));
      return evidenceOutcome(await publicCatalogueWork(env.fuseki,bundle.target));
    } }];
  const reveal = async (rows: Revelation[], claims: Parameters<typeof evidence.reveal>[2] = []) => {
    // Reuse already revealed values; publication never moves an earlier name or
    // entity to a later chapter merely because another bundle cites it again.
    const fresh: Revelation[] = [];
    for (let at = 0; at < rows.length; at += 50) {
      const batch = rows.slice(at,at + 50), existing = await runtime.work.readingPositions!.lookup(batch.map(row => row.record));
      fresh.push(...batch.filter(row => !existing.get(row.record)?.some(old => old.continuityWork === row.continuityWork)));
    }
    await evidence.reveal(bundle.target,fresh,claims,rows.map(row => row.record));
  };
  const unit = (id: string) => bundle.units.find(unit => unit.id === id)!;
  const position = (record: string,kind: Revelation['recordKind'],revealedAt: string,receipt: string): Revelation => ({
    record,recordKind: kind,continuityWork: bundle.target,occurrence: unit(revealedAt).occurrence!,receipt });
  for (const entity of bundle.entities) {
    const state = wikiEntityState(entity,snapshot), before = snapshot.entities[entity.id];
    const revealEntity = async (component: string,receipt: string) => {
      const earliest = [...entity.names].sort((a,b) => unit(a.revealedAt).ordinal - unit(b.revealedAt).ordinal)[0]!;
      await reveal([position(component,'entity',earliest.revealedAt,receipt),...entity.names.map(name => {
        const predicate = `https://schema.org/${name.kind === 'alias' ? 'alternateName' : 'name'}`;
        return position(propertyRevelationRecord(component,predicate,
          { kind: 'language-string',lexical: name.value,language: name.language }),name.kind === 'alias' ? 'alias' : 'name',name.revealedAt,receipt);
      })]);
    };
    commands.push(wikiGraphCommand(runtime,key(`entity:${entity.id}`),async settled => {
      const next = structuredClone(state);
      if (next.component === 'resource' && resultFor(settled,key('evidence'))?.publicWork
        && !next.properties.some(property => property.predicate === SEMANTIC_TERMS.semanticWork
          && property.value.kind === 'resource' && property.value.ref === bundle.target)) {
        next.properties.push({ predicate: SEMANTIC_TERMS.semanticWork,value: { kind: 'resource',ref: bundle.target } });
      }
      return semanticSpec(runtime,entity.match,before?.head ?? null,next,revealEntity);
    },
      async result => revealEntity(result.component,result.receipt)));
  }
  const ref = (value: string,settled: readonly CommandOutcome[]) => bundle.entities.some(entity => entity.id === value)
    ? resource(settled,key(`entity:${value}`)) : value;
  for (const [index,claim] of bundle.claims.entries()) {
    const predicate = snapshot.predicates[claim.predicate]!;
    const ids = claim.evidence.map((_e,e) => evidenceId(input.revision.proposal,input.revision.n,index,e));
    const revealClaim = (component: string,receipt: string) => reveal([position(component,
      predicate.kind === 'property' ? 'statement' : 'relation',claim.revealedAt,receipt)]);
    commands.push(wikiGraphCommand(runtime,key(`claim:${index}`),async settled => {
      const subject = ref(claim.subject,settled), object = claim.object.kind === 'entity' ? ref(claim.object.ref,settled) : null;
      if (!subject || claim.object.kind === 'entity' && !object) return null;
      if (predicate.kind === 'property') {
        const statement: RecordStatementInput = { speaker: { kind: 'personal' },subject,predicate: claim.predicate,
          relationDefinition: predicate.head,value: claim.object.kind === 'entity' ? { kind: 'resource',iri: object! }
            : { kind: 'literal',lexical: claim.object.value,language: claim.object.language ?? null,
              datatype: 'http://www.w3.org/2001/XMLSchema#string' },applicability: [claim.continuity],
          interpretation: { kind: 'selected' },evidence: ids,actingSubject: input.permit.decidingAgent,
          wikiPublicationWork: bundle.target };
        const request = recordStatementRequest(statement);
        return { binding: { action: request.action,scope: request.scope,digest: request.digest },
          read: id => readCommandReceipt(env,id,STATEMENT_FAMILIES.record),
          dispatch: admission => recordStatement(env,admission,statement,{ kind: 'personal',canReadPrivate: async () => false },revealClaim),
          cancel: admission => sealCommandTerminal(env,admission,STATEMENT_FAMILIES.record,'unavailable') };
      }
      const relation: RelationInput = { definition: predicate.head,participations: [
        { role: 'subject',participant: { kind: 'resource',ref: subject } },
        { role: 'object',participant: { kind: 'resource',ref: object! } }],applicability: [claim.continuity],evidence: ids[0] };
      const state = canonicalRelation(predicate.definition!,relation);
      return { binding: { action: 'relation.change',scope: 'relation:create:root',digest: relationChangeDigest(undefined,null,state) },
        read: id => readRelationChangeTerminal(env,id),
        dispatch: admission => changeRelationOccurrence(env,{ admission,expectedHead: null,input: relation,beforeCommit: revealClaim }),
        cancel: admission => cancelSemanticAdmission(env,familyReceiptIri(admission.id,'relation-change'),admission) };
    },async result => reveal([position(result.component,predicate.kind === 'property' ? 'statement' : 'relation',
      claim.revealedAt,result.receipt)],[{ evidence: ids,claim: result.component,kind: predicate.kind === 'property' ? 'statement' : 'relation' }]),
    predicate.kind === 'property' ? { action: 'statement.record',scope: `statement:speak:${input.permit.decidingAgent}` }
      : { action: 'relation.change',scope: 'relation:create:root' }));
  }
  const mounts = ['characters','places','events','chapters'] as const;
  for (const segment of mounts) {
    const items = segment === 'chapters' ? [...bundle.units].filter(unit => unit.occurrence)
      .sort((a,b) => a.ordinal - b.ordinal).map(unit => ({ ref: unit.occurrence!,entity: false }))
      : bundle.entities.filter(entity => !entity.match && wikiSegment(entity.type) === segment)
        .sort((a,b) => Math.min(...a.names.map(name => unit(name.revealedAt).ordinal)) - Math.min(...b.names.map(name => unit(name.revealedAt).ordinal)))
        .map(entity => ({ ref: entity.id,entity: true }));
    const header = snapshot.collections[segment];
    if (!items.length) continue;
    if (!header) throw new EditorialInvalid('Wiki Collection mount is missing');
    for (let at = 0; at < items.length; at += WIKI_APPLY_COST.collectionBatch) {
      const batch = items.slice(at,at + WIKI_APPLY_COST.collectionBatch);
      commands.push(wikiGraphCommand(runtime,key(`members:${segment}:${at}`),async settled => {
        const targets = batch.flatMap(item => {
          const target = item.entity ? resource(settled,key(`entity:${item.ref}`)) : item.ref;
          return target ? [target] : [];
        });
        if (!targets.length) return null;
        const previous = at ? resultFor(settled,key(`members:${segment}:${at - WIKI_APPLY_COST.collectionBatch}`)) : null;
        const head = typeof previous?.revision === 'string' ? previous.revision : header.head;
        const operations: CompositionOperation[] = targets.map(target => ({ op: 'insert',role: 'member',target,
          parent: header.structure,position: 'last',selection: { mode: 'follow-context' } }));
        return { binding: { action: 'collection.edit',scope: `collection:edit:${header.owner}`,
          digest: compositionChangeDigest(header.structure,head,operations,'collection-membership') },
        read: id => readCompositionReceipt(env,id,'collection.edit'),
        dispatch: admission => changeComposition(env,{ admission,structure: header.structure,expectedHead: head,operations }),
        cancel: admission => sealStructureAdmissionCancellation(env,admission) };
      },undefined,{ action: 'collection.edit',scope: `collection:edit:${header.owner}` }));
    }
  }
  return commands;
}

export async function completeWikiBundle(input: ApplyInput, outcomes: readonly CommandOutcome[]): Promise<OwnerReceipt> {
  const resources = outcomes.flatMap(outcome => {
    const result = commandResult(outcome);
    return typeof result?.component === 'string' ? [result.component] : [];
  });
  return { receipt: derivedId(`${input.operationKey}\0wiki-receipt`),proposal: input.revision.proposal,revision: input.revision.n,
    candidateDigest: input.revision.candidateDigest,operationKey: input.operationKey,beforeHeads: input.expectedHeads,
    afterHeads: input.expectedHeads,candidate: input.revision.candidate,before: input.revision.before,
    owner: { resources: [...new Set(resources)],decidingAgent: input.permit.decidingAgent,
      evidence: resultFor(outcomes,wikiItemKey(input,'evidence'))?.evidence ?? [] } };
}
