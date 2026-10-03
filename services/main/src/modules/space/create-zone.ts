import { normalizeAddressAlias } from '@rezics/model/address/aliases';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { derivedId, COMPOSITION_PROFILE } from '../structure/graph.ts';
import { recordTree, orderTree, structureObjects, structureCreationValidations } from '../structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, checkStructureManifest } from '../structure/format.ts';
import { newCost } from '../structure/tree.ts';
import { structureProfileFor } from '../structure/profiles.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, CancelledActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { COMMUNITY_HANDLE, InvalidSpaceInput, readSpaceCreationReceipt,
  spaceCreationReceiptIri, type SpaceCreationReceipt } from './create.ts';

export const SPACE_ZONE_PROFILE = 'https://rezics.com/definition/space-zone-v1';
const ZONE_PROFILE = 'https://rezics.com/definition/zone-capability-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const SPACE_ZONE_CREATE_COST = { graphCommandCalls: 1, graphReceiptReads: 4,
  immutableWrites: 7, validationCalls: 4, handleChecks: 2, deadlineMs: 10_000 } as const;

export interface CreateZoneSpaceInput {
  name: string;
  language?: string;
  handle?: string;
  actingSubject: string;
  visibility?: 'public' | 'private';
  listing?: 'listed' | 'unlisted';
}

export function zoneSpaceCreationDigest(input: CreateZoneSpaceInput) {
  const language = canonicalLanguage(input.language ?? 'und');
  if (!input.name.trim() || input.name.length > 120 || /[\u0000-\u001f\u007f]/u.test(input.name)
    || !native.test(input.actingSubject) || !language || language.length > 35
    || input.handle !== undefined && !COMMUNITY_HANDLE.test(input.handle)
    || !['public','private'].includes(input.visibility ?? 'public')
    || !['listed','unlisted'].includes(input.listing ?? 'listed')) {
    throw new InvalidSpaceInput('invalid Zone Space creation request');
  }
  return hash(JSON.stringify({ family: 'create-space-zone-v1', name: input.name, language,
    capabilities: ['zone'], owner: input.actingSubject, visibility: input.visibility ?? 'public',
    listing: input.listing ?? 'listed', ...(input.handle ? {
      handle: normalizeAddressAlias(input.handle, 'ascii-handle').key } : {}) }));
}

function checked(terminal: SpaceCreationReceipt, admission: RegisteredAdmission,
  input: CreateZoneSpaceInput, digest: string) {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== digest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new IdempotencyConflict('Space admission differs from graph receipt');
  }
  if (terminal.outcome === 'cancelled') throw new CancelledActivation('Space creation was cancelled');
  if (terminal.owner !== input.actingSubject || !terminal.zone || terminal.realm) {
    throw new IdempotencyConflict('Zone Space receipt differs from its owner or capabilities');
  }
  return terminal;
}

/** Space, Zone and empty navigation share one admission, receipt and graph
 * position. A lost response cannot leave a site without its readable home. */
export async function createZoneSpace(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateZoneSpaceInput) {
  const digest = zoneSpaceCreationDigest(input);
  if (admission.action !== 'space.create' || admission.scope !== 'space:create:root'
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Space admission differs from intent');
  }
  const receipt = spaceCreationReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const prior = await readSpaceCreationReceipt(env, admission.id);
  if (prior) return checked(prior, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Space admission expired');
  const space = ID + admission.id;
  const zone = derivedId(`${admission.id}\0space-zone`);
  const spaceRevision = derivedId(`${admission.id}\0space-revision`);
  const zoneRevision = derivedId(`${admission.id}\0zone-revision`);
  const navigation = derivedId(`${admission.id}\0zone-navigation`);
  const navigationRevision = derivedId(`${admission.id}\0navigation-revision`);
  const generation = derivedId(`${admission.id}\0navigation-generation`);
  const operation = derivedId(`${admission.id}\0space-operation`);
  const language = canonicalLanguage(input.language ?? 'und')!;
  const visibility = input.visibility ?? 'public';
  const listing = input.listing ?? 'listed';
  const disclosure = visibility === 'public' ? 'Public' : 'Private';
  const spaceManifest = prepareComponent(env.objectDirectory, space, {
    name: input.name, language, owner: input.actingSubject, zoneCapability: zone,
    capabilities: ['zone'], disclosure: visibility, listing }, SPACE_ZONE_PROFILE);
  const zoneManifest = prepareComponent(env.objectDirectory, zone, {
    kind: 'zone', owner: zone, actingSubject: input.actingSubject, space,
    disclosure: visibility, name: input.name, language }, ZONE_PROFILE);
  const objects = structureObjects(env);
  const cost = newCost();
  const manifestBytes = new TextEncoder().encode(JSON.stringify({
    format: STRUCTURE_MANIFEST_FORMAT, structure: navigation, structureOf: zone,
    profile: 'zone-navigation', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordTree(objects).empty(cost), order: await orderTree(objects).empty(cost),
    placementCount: 0, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE,
  }));
  checkStructureManifest(manifestBytes);
  const navigationManifest = await objects.put(manifestBytes);
  const both = [GRAPHS.current, GRAPHS.revisions];
  const validations = [
    ...await profileValidations(env.fuseki, 'space-zone-v1', [{
      shape: `${SPACE_ZONE_PROFILE}/space-shape`, focus: [space], graphs: [GRAPHS.current] }]),
    ...await profileValidations(env.fuseki, 'zone-capability-v1', [
      { shape: `${ZONE_PROFILE}/zone-shape`, focus: [zone], graphs: both },
      { shape: `${ZONE_PROFILE}/revision-shape`, focus: [zoneRevision], graphs: both },
    ]),
    ...await structureCreationValidations(env, structureProfileFor('zone-navigation'),
      zone, navigation, generation, navigationRevision),
  ];
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Space admission expired');
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations,
      deadlineMs: SPACE_ZONE_CREATE_COST.deadlineMs,
      update: `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(space)} a rv:Space ; rv:owner ${iri(input.actingSubject)} ;
            rv:definitionProfile ${iri(SPACE_ZONE_PROFILE)} ; rv:zoneCapability ${iri(zone)} ;
            rv:disclosure rv:${disclosure} ; rv:listing ${lit(listing)} ;
            rdfs:label ${lit(input.name)}@${language} ; rv:head ${iri(spaceRevision)} .
          ${iri(zone)} a rv:Zone ; rv:space ${iri(space)} ; rv:zoneState rv:Active ;
            rv:disclosure rv:${disclosure} ; rv:zoneHead ${iri(zoneRevision)} ; rv:navigation ${iri(navigation)} .
          ${iri(navigation)} a rv:Structure ; rv:structureOf ${iri(zone)} ;
            rv:structureProfile <${structureProfileFor('zone-navigation').graphProfile}> ;
            rv:structureHead ${iri(navigationRevision)} ; rv:selectedGeneration ${iri(generation)} .
          ${iri(generation)} a rv:StructureGeneration ; rv:structure ${iri(navigation)} ;
            rv:generationState rv:Active ; rv:stagedBy ${iri(operation)} ; rv:placementCount 0 .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(spaceRevision)} a rv:RevisionAnchor ; rv:component ${iri(space)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${spaceManifest}`)} ;
            rv:modelRevision ${iri(SPACE_ZONE_PROFILE)} ; rv:shapeRevision ${iri(SPACE_ZONE_PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
          ${iri(zoneRevision)} a rv:ZoneRevision, rv:RevisionAnchor ; rv:component ${iri(zone)} ;
            rv:operation ${iri(operation)} ; rv:zoneOperation rv:ZoneCreate ;
            rv:manifest ${iri(`urn:rezics:sha256:${zoneManifest}`)} ;
            rv:modelRevision ${iri(ZONE_PROFILE)} ; rv:shapeRevision ${iri(ZONE_PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
          ${iri(navigationRevision)} a rv:StructureRevision, rv:RevisionAnchor ; rv:component ${iri(navigation)} ;
            rv:operation ${iri(operation)} ; rv:structureOperation rv:StructureCreate ;
            rv:generation ${iri(generation)} ; rv:placementCount 0 ;
            rv:manifest ${iri(`urn:rezics:sha256:${navigationManifest}`)} ;
            rv:modelRevision ${iri(COMPOSITION_PROFILE)} ; rv:shapeRevision ${iri(COMPOSITION_PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
            rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
            rv:outcome rv:Succeeded ; rv:space ${iri(space)} ; rv:zone ${iri(zone)} ;
            rv:spaceRevision ${iri(spaceRevision)} ; rv:zoneRevision ${iri(zoneRevision)} ;
            rv:navigation ${iri(navigation)} ; rv:navigationRevision ${iri(navigationRevision)} ;
            rv:owner ${iri(input.actingSubject)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:ZoneSpaceCreatedEvent ; rv:ordinal 0 ; rv:action "space.create" ;
            rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ; rv:space ${iri(space)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          VALUES ?new { ${[space, zone, navigation, generation].map(iri).join(' ')} } ?new ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') throw new InvalidSpaceInput('Zone Space validation failed');
  } catch (error) {
    if (error instanceof InvalidSpaceInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const terminal = await readSpaceCreationReceipt(env, admission.id);
  if (terminal) return checked(terminal, admission, input, digest);
  throw new PendingActivation(updateError ? 'Zone Space update outcome unknown' : 'Zone Space creation guard did not match');
}
