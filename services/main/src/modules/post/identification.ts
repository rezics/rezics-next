import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionDenied } from '../access/admission.ts';
import { createAdmittedMetadataWork } from '../work/create-admitted.ts';
import { GRAPHS, hash, iri, RV } from '../work/activate.ts';
import { setWorkMetadata } from '../work/metadata-command.ts';
import { createAdmittedComposition, changeAdmittedComposition } from '../structure/change-admitted.ts';
import { derivedId } from '../structure/graph.ts';
import { existingIdentificationStructure } from '../structure/identification-bootstrap.ts';
import { structureProfileFor } from '../structure/profiles.ts';
import { readDefinitionByKey } from '../relation/change.ts';
import { admittedWorkRelationChange } from '../relation/work-authority.ts';
import { createAdmittedTextContribution } from '../contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../contribution/publish-admitted.ts';
import { selectAdmittedMainDefault } from '../work/select-main-admitted.ts';
import { readWorkBasis } from '../work/read-header.ts';
import { workRead, WorkReadMissing } from '../work/read-session.ts';
import { checkedIdentification, identificationEvidenceLink, PostIdentificationConflict,
  PostIdentificationUnavailable } from './identification-schema.ts';
import { readPost } from './read.ts';

/** Each admitted command owns its replay receipt. The same caller key resumes
 * the same subcommands; a failed later command never deletes an earlier effect. */
export async function identifyPost(deps: MainWorkDependencies, request: Request,
  post: string, unchecked: unknown, key: string) {
  const input = checkedIdentification(unchecked);
  const composition = structureProfileFor('book-composition');
  const principal = await deps.account.verify(request, ['work:edit', 'work:read']);
  const operation = hash(JSON.stringify([post, input.actingSubject, key]));
  const subkey = (step: string) => `post-identification-${step}:${operation}`;
  const evidence = identificationEvidenceLink(post, operation, input.evidence);
  const placed = await deps.environment.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(post)} a rv:Post . ${iri(input.placement.book)} a <${composition.ownerType}> ; rv:mainVersion ?main .
    ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile <${composition.graphProfile}> ; rv:selectedGeneration ?generation .
    ?generation rv:generationState rv:Active . ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
      rv:occurrence ${iri(input.placement.occurrence)} ; rv:occurrenceRole rv:ChapterRole ; <https://schema.org/item> ${iri(post)} .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removal } } }`);
  if (!placed.boolean) throw new WorkReadMissing('Post placement is unavailable');
  if (!await deps.access.canEditWork(principal, input.actingSubject, post)
    && !await deps.access.canEditWork(principal, input.actingSubject, input.placement.book)) {
    throw new AdmissionDenied('Post custody or Book maintenance is required');
  }
  const source = await workRead(deps, request, { actingSubject: input.actingSubject }, session => readPost(session, post));
  const definition = await readDefinitionByKey(deps.environment, 'composition-part');
  if (!definition || definition.lifecycle !== 'active' || definition.workSubjectRole !== 'part') {
    throw new PostIdentificationUnavailable('Composition-part definition is unavailable');
  }
  const titles = input.work.kind === 'new' ? [...input.work.titles].sort((a, b) => a.language.localeCompare(b.language)) : [];
  const title = titles[0];
  const work = input.work.kind === 'new'
    ? await createAdmittedMetadataWork(deps.environment, deps.account, deps.access, request, {
      title: title!.value, language: title!.language, localizedTitle: titles[1],
      semanticTypes: [composition.ownerType], actingSubject: input.actingSubject, idempotencyKey: subkey('work'),
    }) : await workRead(deps, request, { actingSubject: input.actingSubject }, async session => {
      const id = input.work.kind === 'existing' ? input.work.id : '';
      const basis = await readWorkBasis(session, id);
      if (id === input.placement.book || !basis.card.types.includes(composition.ownerType)
        || !await deps.access.canEditWork(principal, input.actingSubject, id)) {
        throw new PostIdentificationConflict('Identification requires another Book that this identity may edit');
      }
      return { work: id, mainVersion: basis.card.mainVersion, receipt: null, replayed: true,
        published: basis.disclosure === 'public' };
    });
  const metadata = titles.length > 1 ? await setWorkMetadata(deps, request, { work: work.work, expectedHead: null,
    state: { kind: 'header', originalTitle: null, localized: titles.map(value => ({ language: value.language,
      title: value.value, description: null, mainVersionLabel: null })) },
    actingSubject: input.actingSubject, idempotencyKey: subkey('metadata') }) : null;
  const structure = input.work.kind === 'existing'
    ? await existingIdentificationStructure(deps.environment, work.work, work.mainVersion, post) : null;
  const created = structure ?? await createAdmittedComposition(deps.environment, deps.account, deps.access, request,
    { work: work.work, mainVersion: work.mainVersion, actingSubject: input.actingSubject, idempotencyKey: subkey('structure') });
  if (!created.structure || !created.revision) throw new PostIdentificationUnavailable('Structure receipt is incomplete');
  const placement = structure?.occurrence ? { revision: structure.revision, receipt: structure.receipt,
    occurrences: [structure.occurrence] } : await changeAdmittedComposition(deps.environment, deps.account, deps.access, request,
    { structure: created.structure, expectedHead: created.revision, operations: [{ op: 'insert', parent: created.structure,
      position: 'last', role: 'chapter', target: post }], actingSubject: input.actingSubject, idempotencyKey: subkey('placement') });
  if (!placement.revision) throw new PostIdentificationUnavailable('Placement receipt is incomplete');
  let publication: string | null = null;
  if (source.disclosure === 'public' && (input.work.kind === 'new' || !('published' in work && work.published))) {
    // Publish only the Book's introduction, through Studio's native commands.
    // Its chapter text stays on the Post and is read through the composition.
    const intro = { value: title?.value ?? source.title.value, language: source.title.language };
    const draft = await createAdmittedTextContribution(deps.environment, deps.account, deps.access, request,
      { work: work.work, language: intro.language, body: intro.value, actingSubject: input.actingSubject,
        idempotencyKey: subkey('introduction') });
    if (!draft.contribution || !draft.draftRevision) throw new PostIdentificationUnavailable('Introduction receipt is incomplete');
    const published = await publishAdmittedTextContribution(deps.environment, deps.account, deps.access, request,
      { contribution: draft.contribution, expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: input.actingSubject,
        idempotencyKey: subkey('publication') });
    if (!published.publicationDecision) throw new PostIdentificationUnavailable('Publication receipt is incomplete');
    const selected = await selectAdmittedMainDefault(deps.environment, deps.account, deps.access, request,
      { work: work.work, context: { kind: 'main-version-default', id: work.mainVersion }, contribution: draft.contribution,
        publicationDecision: published.publicationDecision, expectedSelectionHead: null, selectionBasis: 'main-maintainer',
        actingSubject: input.actingSubject, idempotencyKey: subkey('selection') });
    publication = selected.receipt;
  }
  const relation = await admittedWorkRelationChange(deps.environment, deps.account, deps.access, request,
    { expectedHead: null, input: { definition: definition.revision, evidence, participations: [
      { role: 'whole', participant: { kind: 'resource', ref: input.placement.book } },
      { role: 'part', participant: { kind: 'resource', ref: work.work } }], },
      actingSubject: input.actingSubject, idempotencyKey: subkey('relation') });
  return { profile: 'post-identification-v1' as const, identification: relation.occurrence, post, work: work.work,
    mainVersion: work.mainVersion, structure: created.structure,
    occurrence: placement.occurrences?.[0] ?? derivedId(`${placement.revision}\0occurrence\0${0}`),
    relation: relation.occurrence, relationRevision: relation.revision, evidence: input.evidence, receipt: relation.receipt,
    receipts: { work: work.receipt, metadata: metadata?.receipt ?? null, structure: created.receipt,
      placement: placement.receipt, publication, relation: relation.receipt }, replayed: relation.replayed,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: relation.dataEpoch, sequence: relation.sequence } };
}
