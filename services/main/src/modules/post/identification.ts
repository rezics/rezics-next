import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionDenied } from '../access/admission.ts';
import { createAdmittedMetadataWork, PendingAdmittedWork } from '../work/create-admitted.ts';
import { GRAPHS, hash, iri, RV } from '../work/activate.ts';
import { setWorkMetadata } from '../work/metadata-command.ts';
import { createAdmittedComposition, changeAdmittedComposition, type AdmittedComposition } from '../structure/change-admitted.ts';
import { readDefinitionByKey, type RelationChangeResult } from '../relation/change.ts';
import { admittedWorkRelationChange } from '../relation/work-authority.ts';
import { checkedIdentification, identificationDigest, PostIdentificationUnavailable } from './identification-schema.ts';
import { type IdentificationResult } from './identification-store.ts';
import { derivedId } from '../structure/graph.ts';
import { workRead, WorkReadMissing } from '../work/read-session.ts';
import { readWorkBasis } from '../work/read-header.ts';
import { existingIdentificationStructure, type IdentificationStructureProof } from '../structure/identification-bootstrap.ts';
import { PostIdentificationConflict } from './identification-schema.ts';
import { readPost } from './read.ts';

export class PendingPostIdentification extends PendingAdmittedWork {
  constructor(id: string) { super(id); Object.defineProperty(this, 'phase', { value: 'post-identification' }); }
}

/** Every step uses the ordinary admitted owner command. A failed later step
 * leaves earlier resources available for replay; it never compensates by deleting. */
export async function identifyPost(deps: MainWorkDependencies, request: Request,
  post: string, unchecked: unknown, key: string): Promise<IdentificationResult & { replayed: boolean }> {
  const input = checkedIdentification(unchecked), store = deps.postIdentifications;
  if (input.work.kind === 'existing' && input.work.id === input.placement.book) {
    throw new PostIdentificationConflict('The independently identified Work must differ from its source Book');
  }
  if (!store || !deps.access.withWorkEditAuthority) throw new PostIdentificationUnavailable('Identification authority is unavailable');
  const principal = await deps.account.verify(request, ['work:edit', 'work:read']);
  const placed = await deps.environment.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(post)} a rv:Post . ${iri(input.placement.book)} a <https://schema.org/Book> ; rv:mainVersion ?main .
    ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:BookComposition ; rv:selectedGeneration ?generation .
    ?generation rv:generationState rv:Active .
    ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ${iri(input.placement.occurrence)} ;
      rv:occurrenceRole rv:ChapterRole ; <https://schema.org/item> ${iri(post)} .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removal } } }`);
  if (!placed.boolean) throw new WorkReadMissing('Post placement is unavailable');
  const authority = await deps.access.canEditWork(principal, input.actingSubject, post) ? post : input.placement.book;
  if (!await deps.access.canEditWork(principal, input.actingSubject, authority)) throw new AdmissionDenied('Post custody or Book maintenance is required');
  await workRead(deps, request, { actingSubject: input.actingSubject }, async session => {
    await readPost(session, post);
    return readWorkBasis(session, input.placement.book);
  });
  const definition = await readDefinitionByKey(deps.environment, 'composition-part');
  if (!definition || definition.lifecycle !== 'active' || definition.workSubjectRole !== 'part') {
    throw new PostIdentificationUnavailable('Composition-part definition is unavailable');
  }
  const record = await deps.access.withWorkEditAuthority(principal, input.actingSubject, authority,
    proof => store.reserve(proof, post, key, identificationDigest(post, input), input, definition));
  if (record.result) return { ...record.result, replayed: true };
  const operation = hash(record.id), subkey = (step: string) => `post-identification-${step}:${operation}`;
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    if (record.steps[name]) return record.steps[name] as T;
    const returned = await run();
    let value: T;
    try { value = await store.checkpoint(record.id, name, returned); }
    catch { throw new PendingPostIdentification(record.id); }
    record.steps[name] = value; return value;
  };
  const work = input.work.kind === 'new'
    ? await step('work', () => {
      if (input.work.kind !== 'new') throw new PostIdentificationUnavailable('Work intent changed');
      const titles = [...input.work.titles].sort((a, b) => a.language.localeCompare(b.language)), title = titles[0]!;
      // Custody does not prove authorship. Creating the catalogue identity must
      // never credit a maintainer as the writer of somebody else's text.
      return createAdmittedMetadataWork(deps.environment, deps.account, deps.access, request,
        { title: title.value, language: title.language, localizedTitle: titles[1], semanticTypes: [input.work.type],
          actingSubject: input.actingSubject, idempotencyKey: subkey('work') });
    }) : await step('work-reference', async () => {
      if (input.work.kind !== 'existing') throw new PostIdentificationUnavailable('Work intent changed');
      const basis = await workRead(deps, request, { actingSubject: input.actingSubject },
        session => readWorkBasis(session, input.work.kind === 'existing' ? input.work.id : ''));
      return { work: input.work.id, mainVersion: basis.card.mainVersion, receipt: null };
    });
  const metadata = input.work.kind === 'new' && input.work.titles.length > 1
    ? await step('metadata', () => setWorkMetadata(deps, request, { work: work.work, expectedHead: null,
      state: { kind: 'header', originalTitle: null, localized: input.work.kind === 'new'
        ? input.work.titles.map(title => ({ language: title.language, title: title.value,
          description: null, mainVersionLabel: null })) : [] },
      actingSubject: input.actingSubject, idempotencyKey: subkey('metadata') })) : null;
  const structure = await step<IdentificationStructureProof>('structure', async () => {
    if (input.work.kind === 'existing') {
      const existing = await existingIdentificationStructure(deps.environment, work.work, work.mainVersion, post);
      if (existing) return existing;
    }
    const created = await createAdmittedComposition(deps.environment, deps.account, deps.access, request,
      { work: work.work, mainVersion: work.mainVersion, actingSubject: input.actingSubject, idempotencyKey: subkey('structure') });
    if (!created.structure || !created.revision) throw new PostIdentificationUnavailable('Structure receipt is incomplete');
    return { structure: created.structure, revision: created.revision, receipt: created.receipt };
  });
  if (!structure.structure || !structure.revision) throw new PostIdentificationUnavailable('Structure receipt is incomplete');
  const placement = await step<Pick<AdmittedComposition, 'revision' | 'receipt' | 'occurrences'>>('placement', () => structure.occurrence
    ? Promise.resolve({ revision: structure.revision, receipt: structure.receipt, occurrences: [structure.occurrence] })
    : changeAdmittedComposition(
    deps.environment, deps.account, deps.access, request, { structure: structure.structure!, expectedHead: structure.revision!,
      operations: [{ op: 'insert', parent: structure.structure!, position: 'last', role: 'chapter', target: post }],
      actingSubject: input.actingSubject, idempotencyKey: subkey('placement') }));
  if (!placement.revision) throw new PostIdentificationUnavailable('Placement receipt is incomplete');
  const occurrence = placement.occurrences?.[0] ?? derivedId(`${placement.revision}\0occurrence\0${0}`);
  const receipt = `https://rezics.com/v1/post-identifications/${record.id}`;
  const relation = await step<RelationChangeResult>('relation', () => admittedWorkRelationChange(
    deps.environment, deps.account, deps.access, request, { expectedHead: null,
      input: { definition: record.definition_ref, evidence: receipt, participations: [
        { role: 'whole', participant: { kind: 'resource', ref: input.placement.book } },
        { role: 'part', participant: { kind: 'resource', ref: work.work } },
      ] }, actingSubject: input.actingSubject, idempotencyKey: subkey('relation') }));
  const result = await deps.access.withWorkEditAuthority(principal, input.actingSubject, authority,
    () => store.complete(record.id, { profile: 'post-identification-v1',
    identification: `https://rezics.com/id/${record.id}`, post, work: work.work, mainVersion: work.mainVersion,
    structure: structure.structure!, occurrence, relation: relation.occurrence, relationRevision: relation.revision,
    evidence: input.evidence, receipt, receipts: { work: work.receipt, metadata: metadata?.receipt ?? null,
      structure: structure.receipt, placement: placement.receipt, relation: relation.receipt },
    sourcePosition: { datasetId: 'product', dataEpoch: relation.dataEpoch, sequence: relation.sequence } })
      .catch(() => { throw new PendingPostIdentification(record.id); }));
  return { ...result, replayed: false };
}
