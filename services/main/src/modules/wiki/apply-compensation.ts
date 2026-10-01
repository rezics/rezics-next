import { canonicalCandidate, headsEqual, EditorialBlocked, EditorialInvalid, type ApplyInput, type BaseHead,
  type EditorialCommand, type EditorialTarget, type Json, type OwnerReceipt } from '../editorial-review/contract.ts';
import type { EditorialRuntime } from '../editorial-review/runtime.ts';
import { assertOwnerReceipt } from '../editorial-review/lifecycle.ts';
import { readCurrentComponent } from '../semantic/change.ts';
import { SEMANTIC_TERMS } from '../semantic/schema.ts';
import { canonicalRelation, changeRelationOccurrence, readRelationChangeTerminal, relationChangeDigest } from '../relation/change.ts';
import { cancelSemanticAdmission, familyReceiptIri } from '../semantic/command.ts';
import { withdrawStatement, withdrawStatementRequest, STATEMENT_FAMILIES } from '../statement/graph.ts';
import { readCommandReceipt, sealCommandTerminal } from '../context/command.ts';
import { changeComposition, compositionChangeDigest, readCompositionReceipt,
  sealStructureAdmissionCancellation, type CompositionOperation } from '../structure/change.ts';
import { derivedId } from '../structure/graph.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { evidenceId } from './evidence.ts';
import { extractionCandidate, wikiSegment, type WikiSnapshot } from './apply-snapshot.ts';
import { semanticSpec, wikiEntityState, wikiItemKey } from './apply.ts';
import { commandResult, wikiGraphCommand } from './apply-runtime.ts';

export const isWikiRetraction = (candidate: unknown): candidate is { profile: 'wiki-retraction-v1'; proposal: string } =>
  !!candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'profile' in candidate
    && candidate.profile === 'wiki-retraction-v1';
export async function originalWikiReceipt(runtime: EditorialRuntime, proposal: string): Promise<OwnerReceipt> {
  if (!/^[0-9a-f-]{36}$/.test(proposal)) throw new EditorialInvalid('Invalid original proposal');
  const receipt = await runtime.work.editorialReview?.appliedReceipt(proposal);
  if (!receipt || isWikiRetraction(receipt.candidate)) throw new EditorialInvalid('Wiki retraction requires an applied bundle');
  extractionCandidate(receipt.candidate);
  return receipt;
}
export function compensateWikiReceipt(receipt: OwnerReceipt) {
  assertOwnerReceipt(receipt,{ revision: { proposal: receipt.proposal,n: receipt.revision,candidate: receipt.candidate,
    candidateDigest: receipt.candidateDigest,before: receipt.before,baseHeads: receipt.beforeHeads,evidence: [] },
  operationKey: receipt.operationKey,expectedHeads: receipt.beforeHeads });
  extractionCandidate(receipt.candidate);
  return { candidate: canonicalCandidate({ profile: 'wiki-retraction-v1',proposal: receipt.proposal }).candidate,
    before: canonicalCandidate({ profile: 'wiki-retraction-prestate-v1',proposal: receipt.proposal }).candidate,
    baseHeads: receipt.afterHeads };
}
export async function validateWikiRetraction(runtime: EditorialRuntime, target: EditorialTarget,
  candidate: { proposal: string }, expected: BaseHead[]) {
  const original = await originalWikiReceipt(runtime,candidate.proposal), bundle = extractionCandidate(original.candidate);
  if (bundle.target !== target.resource || target.work !== target.resource) throw new EditorialInvalid('Retraction names another Work');
  const workHeads = (await runtime.work.environment.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(bundle.target)} rv:head ?head } } LIMIT 2`,4096)).results?.bindings ?? [];
  const actual = [{ component: bundle.target,head: workHeads.length === 1 ? workHeads[0]?.head?.value ?? null : null }];
  if (!headsEqual(expected,actual)) throw new EditorialBlocked({ code: 'stale_base',expectedHeads: expected,actualHeads: actual });
  const outcomes = original.commands ?? [];
  for (const entity of bundle.entities) {
    const prefix = `wiki:${original.proposal}:${original.revision}:`;
    const result = commandResult(outcomes.find(outcome => outcome.key === `${prefix}work-link:${entity.id}`))
      ?? commandResult(outcomes.find(outcome => outcome.key === `${prefix}entity:${entity.id}`));
    if (!result || typeof result.component !== 'string') continue;
    const current = await readCurrentComponent(runtime.work.environment,result.component,'resource');
    if (current?.head !== result.revision) throw new EditorialBlocked({ code: 'stale_base',
      expectedHeads: [{ component: result.component,head: typeof result.revision === 'string' ? result.revision : null }],
      actualHeads: [{ component: result.component,head: current?.head ?? null }] });
  }
  return { ...compensateWikiReceipt(original),baseHeads: expected };
}
export async function wikiRetractionCommands(runtime: EditorialRuntime, input: ApplyInput): Promise<EditorialCommand[]> {
  if (!isWikiRetraction(input.revision.candidate)) throw new EditorialInvalid('Invalid wiki retraction');
  const original = await originalWikiReceipt(runtime,input.revision.candidate.proposal), bundle = extractionCandidate(original.candidate);
  const snapshot = original.before as unknown as WikiSnapshot, outcomes = original.commands ?? [], env = runtime.work.environment;
  const oldKey = (item: string) => `wiki:${original.proposal}:${original.revision}:${item}`;
  const oldResult = (item: string) => commandResult(outcomes.find(outcome => outcome.key === oldKey(item)));
  const commands: EditorialCommand[] = [];
  for (const [segment,header] of Object.entries(snapshot.collections)) {
    if (segment === 'franchise') continue;
    const memberships = outcomes.filter(outcome => outcome.key.startsWith(oldKey(`members:${segment}:`)) && outcome.outcome === 'applied');
    const positions: string[] = [];
    for (const membership of memberships) {
      const result = commandResult(membership);
      if (typeof result?.revision !== 'string') continue;
      const offset = Number(membership.key.slice(oldKey(`members:${segment}:`).length));
      const ordinal = (id: string) => bundle.units.find(unit => unit.id === id)!.ordinal;
      const items = segment === 'chapters' ? bundle.units.filter(unit => unit.occurrence).sort((a,b) => a.ordinal - b.ordinal)
        : bundle.entities.filter(entity => !entity.match && wikiSegment(entity.type) === segment).sort((a,b) =>
          Math.min(...a.names.map(name => ordinal(name.revealedAt))) - Math.min(...b.names.map(name => ordinal(name.revealedAt))));
      const count = items.slice(offset,offset + 16).filter(item => !('names' in item) || oldResult(`entity:${item.id}`)).length;
      positions.push(...Array.from({ length: count },(_value,index) => derivedId(`${result.revision}\0occurrence\0${index}`)));
    }
    const last = commandResult(memberships.at(-1));
    if (typeof last?.revision !== 'string') continue;
    for (let at = 0; at < positions.length; at += 16) {
      const part = positions.slice(at,at + 16), key = wikiItemKey(input,`retract-members:${segment}:${at}`);
      commands.push(wikiGraphCommand(runtime,key,async settled => {
        const previous = commandResult(settled.find(outcome => outcome.key === wikiItemKey(input,`retract-members:${segment}:${at - 16}`)));
        const head = typeof previous?.revision === 'string' ? previous.revision : last.revision as string;
        const operations: CompositionOperation[] = part.map(occurrence => ({ op: 'remove',occurrence }));
        return { binding: { action: 'collection.edit',scope: `collection:edit:${header.owner}`,
          digest: compositionChangeDigest(header.structure,head,operations,'collection-membership') },
        read: id => readCompositionReceipt(env,id,'collection.edit'),
        dispatch: admission => changeComposition(env,{ admission,structure: header.structure,expectedHead: head,operations }),
        cancel: admission => sealStructureAdmissionCancellation(env,admission) };
      }));
    }
  }
  for (const [index,claim] of bundle.claims.entries()) {
    const result = oldResult(`claim:${index}`);
    if (!result || typeof result.component !== 'string' || typeof result.revision !== 'string') continue;
    const component = result.component, head = result.revision;
    commands.push(wikiGraphCommand(runtime,wikiItemKey(input,`retract-claim:${index}`),async () => {
      const predicate = snapshot.predicates[claim.predicate]!;
      if (predicate.kind === 'property') {
        const originalOwner = original.owner as Record<string,Json>;
        if (typeof originalOwner.decidingAgent !== 'string') throw new EditorialInvalid('Original wiki receipt lacks its speaker');
        const statement = { statement: component,expectedHead: head,speaker: { kind: 'personal' as const },
          actingSubject: input.permit.decidingAgent,originalSpeaker: originalOwner.decidingAgent };
        const request = withdrawStatementRequest(statement);
        return { binding: { action: request.action,scope: request.scope,digest: request.digest },
          read: id => readCommandReceipt(env,id,STATEMENT_FAMILIES.withdraw),
          dispatch: admission => withdrawStatement(env,admission,statement),
          cancel: admission => sealCommandTerminal(env,admission,STATEMENT_FAMILIES.withdraw,'unavailable') };
      }
      const ref = (value: string) => bundle.entities.some(entity => entity.id === value) ? oldResult(`entity:${value}`)?.component : value;
      if (claim.object.kind !== 'entity') throw new EditorialInvalid('Wiki relation lacks its entity');
      const relation = { definition: predicate.head,lifecycle: 'retired' as const,applicability: [claim.continuity],
        evidence: evidenceId(original.proposal,original.revision,index,0),
        participations: [{ role: 'subject',participant: { kind: 'resource',ref: ref(claim.subject) } },
          { role: 'object',participant: { kind: 'resource',ref: ref(claim.object.ref) } }] };
      const state = canonicalRelation(predicate.definition!,relation);
      return { binding: { action: 'relation.change',scope: `relation:edit:${component}`,digest: relationChangeDigest(component,head,state) },
        read: id => readRelationChangeTerminal(env,id),dispatch: admission => changeRelationOccurrence(env,
          { admission,occurrence: component,expectedHead: head,input: relation }),
        cancel: admission => cancelSemanticAdmission(env,familyReceiptIri(admission.id,'relation-change'),admission) };
    }));
  }
  for (const entity of bundle.entities) {
    const result = oldResult(`work-link:${entity.id}`) ?? oldResult(`entity:${entity.id}`);
    if (!result || typeof result.component !== 'string' || typeof result.revision !== 'string') continue;
    const component = result.component, head = result.revision;
    const state = snapshot.entities[entity.id]?.state ?? wikiEntityState(entity,snapshot);
    if (!entity.match && state.component === 'resource') {
      state.lifecycle = 'retired';
      state.properties = state.properties.filter(property => property.predicate !== SEMANTIC_TERMS.semanticWork);
    }
    commands.push(wikiGraphCommand(runtime,wikiItemKey(input,`retract-entity:${entity.id}`),async () => semanticSpec(runtime,component,head,state)));
  }
  if (!commands.length) throw new EditorialInvalid('Applied wiki bundle has no effects to retract');
  return commands;
}
