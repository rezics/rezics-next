import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry }
  from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { compositionReceiptIri, readCompositionReceipt,
  sealStructureAdmissionCancellation, terminalResult } from '../structure/change.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readWorkComponentState } from '../work/history.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { checkZoneConfiguration, InvalidZoneConfiguration, ZONE_CONFIG_FORMAT,
  ZONE_LIMITS, ZONE_PROFILE, type ZoneConfiguration, type ZoneQueryBlock } from './config-format.ts';
import { activeDefinitionDependenciesGuard } from '../context/definition-state.ts';
import { ZONE_PRESENTATION_PROFILE, type ZonePresentation } from './presentation-format.ts';
import { readZoneName } from './read-name.ts';
import type { ResourceListing } from '../space/policy.ts';

export class ZoneUnavailable extends Error {}
export class ZoneStale extends Error {}
export class ZoneOfficialDenied extends Error {}

interface ZoneHead {
  zone: string; space: string; navigation: string; revision: string; manifest: string;
  state: 'active' | 'retired'; disclosure: 'public' | 'private';
  spaceVisibility: 'public' | 'private'; listing: ResourceListing;
  defaultRealm?: string; presentation?: string; official?: Record<string, never>;
  defaultContext?: { context: string; semanticRevision: string };
}

async function zoneHead(env: WorkActivationEnvironment, zone: string): Promise<ZoneHead> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space ?navigation ?head
    ?manifest ?state ?disclosure ?realm ?presentation ?context ?contextRevision ?official ?spaceDisclosure ?listing WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:space ?space ;
        rv:navigation ?navigation ; rv:zoneHead ?head ; rv:zoneState ?state ;
        rv:disclosure ?disclosure .
        ?space a rv:Space ; rv:disclosure ?spaceDisclosure .
        OPTIONAL { ?space rv:listing ?listing }
        OPTIONAL { ${iri(zone)} rv:defaultRealm ?realm }
        OPTIONAL { ${iri(zone)} rv:presentation ?presentation }
        OPTIONAL { ${iri(zone)} rv:official ?official }
        OPTIONAL { ${iri(zone)} rv:defaultContext ?context }
        OPTIONAL { ${iri(zone)} rv:defaultContextRevision ?contextRevision } }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ZoneRevision ;
        rv:component ${iri(zone)} ; rv:manifest ?manifest . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) throw new ZoneUnavailable('Zone is unavailable');
  const row = rows[0]!;
  if (!row.space?.value || !row.navigation?.value || !row.head?.value
    || !row.manifest?.value || !row.state?.value || !row.disclosure?.value || !row.spaceDisclosure?.value) {
    throw new ZoneUnavailable('Zone head is incomplete');
  }
  if (!!row.context?.value !== !!row.contextRevision?.value) {
    throw new ZoneUnavailable('Zone Context selection is incomplete');
  }
  if (row.official?.value && row.official.value !== 'true') {
    throw new ZoneUnavailable('Official Zone marker differs');
  }
  if (![`${RV}Public`,`${RV}Private`].includes(row.spaceDisclosure.value)
    || !['listed','unlisted'].includes(row.listing?.value ?? 'listed')) throw new ZoneUnavailable('Zone Space visibility is invalid');
  return { zone, space: row.space.value, navigation: row.navigation.value,
    revision: row.head.value, manifest: row.manifest.value,
    state: row.state.value === `${RV}Retired` ? 'retired' : 'active',
    disclosure: row.disclosure.value === `${RV}Public` ? 'public' : 'private',
    spaceVisibility: row.spaceDisclosure.value === `${RV}Public` ? 'public' : 'private',
    listing: (row.listing?.value ?? 'listed') as ResourceListing,
    ...(row.realm?.value ? { defaultRealm: row.realm.value } : {}),
    ...(row.context?.value && row.contextRevision?.value ? { defaultContext: {
      context: row.context.value, semanticRevision: row.contextRevision.value } } : {}),
    ...(row.presentation?.value ? { presentation: row.presentation.value } : {}),
    ...(row.official?.value === 'true' ? { official: {} } : {}) };
}

export async function readZoneConfiguration(env: WorkActivationEnvironment, zone: string) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const head = await zoneHead(env, zone);
  const stored = await readWorkComponentState(env, head.manifest, zone, ZONE_PROFILE);
  const name = readZoneName(stored.name, stored.language);
  const configuration = stored.configuration;
  const config = configuration && typeof configuration === 'object' && !Array.isArray(configuration)
    ? checkZoneConfiguration(Buffer.from(JSON.stringify(configuration)))
    : checkZoneConfiguration(Buffer.from(JSON.stringify({ format: ZONE_CONFIG_FORMAT,
      zone, space: head.space, navigation: head.navigation, state: head.state,
      disclosure: head.disclosure, budget: { timeMs: ZONE_LIMITS.queryBudgetMs,
        rows: ZONE_LIMITS.queryBudgetRows }, queryBlocks: [], model: ZONE_PROFILE })));
  if (config.zone !== zone || config.space !== head.space || config.navigation !== head.navigation
    || config.state !== head.state || config.disclosure !== head.disclosure
    || JSON.stringify(config.defaultContext ?? null) !== JSON.stringify(head.defaultContext ?? null)
    || JSON.stringify(config.official ?? null) !== JSON.stringify(head.official ?? null)
    || (typeof config.presentation === 'string' ? config.presentation
      : config.presentation ? ZONE_PRESENTATION_PROFILE : undefined) !== head.presentation) {
    throw new ZoneUnavailable('Zone configuration differs from graph head');
  }
  const advancedBase64 = typeof stored.advancedBase64 === 'string' ? stored.advancedBase64 : undefined;
  if (advancedBase64 && config.advanced !== `sha256:${hash(Buffer.from(advancedBase64, 'base64'))}`) {
    throw new ZoneUnavailable('Zone advanced configuration digest differs');
  }
  return { ...head, ...name, configuration: config, ...(advancedBase64 ? { advancedBase64 } : {}),
    cost: { graphReads: 1, objectReads: 2 } };
}

export interface ZoneRevisionInput {
  zone: string; expectedHead: string; actingSubject: string; idempotencyKey: string;
  operation: 'configure' | 'retire' | 'recover';
  patch?: { name?: string; language?: string;
    defaultRealm?: string | null; official?: Record<string, never> | null;
    presentation?: ZonePresentation | null;
    defaultContext?: ZoneConfiguration['defaultContext'] | null;
    budget?: ZoneConfiguration['budget']; queryBlocks?: ZoneQueryBlock[];
    advancedBase64?: string | null };
}

export async function changeZoneConfiguration(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'canMarkOfficialZone'>>,
  request: Request, input: ZoneRevisionInput) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  if (input.patch?.official !== undefined || input.patch?.defaultRealm !== undefined
    || input.patch?.presentation !== undefined) {
    const before = await readZoneConfiguration(env, input.zone);
    const priorTheme = typeof before.configuration.presentation === 'object'
      ? before.configuration.presentation.official?.theme : undefined;
    const nextTheme = typeof input.patch?.presentation === 'object' && input.patch.presentation
      ? input.patch.presentation.official?.theme : undefined;
    if (input.patch?.official !== undefined
      || (input.patch?.defaultRealm !== undefined && before.configuration.official)
      || (input.patch?.presentation !== undefined && priorTheme !== nextTheme)) {
      const official = await account.verify(request, ['owner:operate']);
      if (!await access.canMarkOfficialZone?.(official, input.actingSubject, input.zone)) {
        throw new ZoneOfficialDenied('Official Zone authority is unavailable');
      }
    }
  }
  const digest = hash(JSON.stringify({ family: 'zone-revision-v1', ...input,
    idempotencyKey: undefined }));
  const principal = await account.verify(request, ['zone:edit']);
  const scope = `zone:edit:${input.zone}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'zone.edit', idempotencyKey: input.idempotencyKey, requestDigest: digest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest, principal); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    }
  }
  if (admission.state !== 'sealed' && (!admission.dispatchEligible || admission.state === 'registered')) {
    await sealStructureAdmissionCancellation(env, admission);
  } else if (admission.state !== 'sealed'
    && !await readCompositionReceipt(env, admission.id, admission.action)) {
    const invalid = async (error: InvalidZoneConfiguration): Promise<never> => {
      const cancelled = await sealStructureAdmissionCancellation(env, admission);
      await access.recordGraphOutcome(admission.id, cancelled);
      throw error;
    };
    const head = await readZoneConfiguration(env, input.zone);
    if (head.revision !== input.expectedHead) {
      await sealStructureAdmissionCancellation(env, admission);
      await access.recordGraphOutcome(admission.id,
        (await readCompositionReceipt(env, admission.id, admission.action))!);
      throw new ZoneStale('Zone head changed');
    }
    if (input.operation === 'retire' && head.state !== 'active'
      || input.operation === 'recover' && head.state !== 'retired'
      || input.operation === 'configure' && head.state !== 'active') {
      return invalid(new InvalidZoneConfiguration('Zone state transition is invalid'));
    }
    if (input.operation === 'retire') {
      const dependents = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(head.navigation)} rv:selectedGeneration ?generation .
        ?generation rv:placementCount ?count . FILTER(?count > 0) } }`);
      if (dependents.boolean === true) return invalid(new InvalidZoneConfiguration('Zone still has mounts'));
    }
    const prior = head.configuration;
    const patch = input.patch;
    let name;
    try {
      // An unrelated edit retains metadata. A new name without a writer language is und.
      if (patch?.language !== undefined && patch.name === undefined) {
        throw new InvalidZoneConfiguration('Zone language requires a name');
      }
      name = patch?.name !== undefined ? readZoneName(patch.name, patch.language)
        : readZoneName(head.name ?? undefined, head.name === null ? undefined : head.language);
    } catch (error) {
      if (error instanceof InvalidZoneConfiguration) return invalid(error);
      throw error;
    }
    let advancedBase64 = head.advancedBase64;
    if (patch?.advancedBase64 === null) advancedBase64 = undefined;
    else if (patch?.advancedBase64 !== undefined) {
      const encoded = patch.advancedBase64;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        || Buffer.from(encoded, 'base64').length > ZONE_LIMITS.advancedBytes) {
        return invalid(new InvalidZoneConfiguration('Zone advanced configuration is invalid'));
      }
      advancedBase64 = encoded;
    }
    let config: ZoneConfiguration;
    try { config = checkZoneConfiguration(Buffer.from(JSON.stringify({ ...prior,
      state: input.operation === 'retire' ? 'retired'
        : input.operation === 'recover' ? 'active' : prior.state,
      ...(patch?.defaultRealm !== undefined
        ? patch.defaultRealm === null ? { defaultRealm: undefined } : { defaultRealm: patch.defaultRealm } : {}),
      ...(patch?.official !== undefined ? { official: patch.official ?? undefined } : {}),
      ...(patch?.presentation !== undefined
        ? patch.presentation === null ? { presentation: undefined } : { presentation: patch.presentation } : {}),
      ...(patch?.defaultContext !== undefined
        ? { defaultContext: patch.defaultContext ?? undefined } : {}),
      ...(patch?.budget ? { budget: patch.budget } : {}),
      ...(patch?.queryBlocks ? { queryBlocks: patch.queryBlocks } : {}),
      advanced: advancedBase64 ? `sha256:${hash(Buffer.from(advancedBase64, 'base64'))}` : undefined,
    }))); }
    catch (error) {
      if (error instanceof InvalidZoneConfiguration) return invalid(error);
      throw error;
    }
    if (config.defaultRealm) {
      const realm = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(config.defaultRealm)} a rv:Realm ; rv:space ${iri(head.space)} ; rv:realmState rv:Active . } }`);
      if (realm.boolean !== true) return invalid(new InvalidZoneConfiguration('default Realm is unavailable'));
    }
    if (config.defaultContext) {
      const selected = config.defaultContext;
      const available = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.current)} { ${iri(selected.context)} a rv:SemanticContext ;
          rv:contextState rv:Active ; rv:disclosure rv:Public . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(selected.semanticRevision)}
          a rv:ContextSemanticRevision ; rv:component ${iri(selected.context)} . }
        ${activeDefinitionDependenciesGuard(selected.semanticRevision)} }`);
      if (available.boolean !== true) return invalid(new InvalidZoneConfiguration('selected Context is unavailable'));
    }
    const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const operation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const manifest = prepareComponent(env.objectDirectory, input.zone, { configuration: config,
      ...(name.name !== null ? { name: name.name, language: name.language } : {}),
      ...(advancedBase64 ? { advancedBase64 } : {}) }, ZONE_PROFILE);
    const receipt = compositionReceiptIri(admission.id, admission.action);
    const batch = `urn:rezics:outbox:${hash(receipt)}`;
    const event = `urn:rezics:event:${hash(operation)}`;
    const kind = input.operation === 'retire' ? 'ZoneRetire'
      : input.operation === 'recover' ? 'ZoneRecover' : 'ZoneConfigure';
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:zoneHead ${iri(input.expectedHead)} ;
          rv:zoneState ?oldState ; rv:defaultRealm ?oldRealm ; rv:official ?oldOfficial ;
          rv:presentation ?oldPresentation ;
          rv:defaultContext ?oldContext ; rv:defaultContextRevision ?oldContextRevision . } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:zoneHead ${iri(revision)} ;
          rv:zoneState rv:${config.state === 'active' ? 'Active' : 'Retired'} .
          ${config.defaultRealm ? `${iri(input.zone)} rv:defaultRealm ${iri(config.defaultRealm)} .` : ''}
          ${config.official ? `${iri(input.zone)} rv:official true .` : ''}
          ${config.defaultContext ? `${iri(input.zone)} rv:defaultContext ${iri(config.defaultContext.context)} ;
            rv:defaultContextRevision ${iri(config.defaultContext.semanticRevision)} .` : ''}
          ${config.presentation ? `${iri(input.zone)} rv:presentation ${iri(typeof config.presentation === 'string'
            ? config.presentation : ZONE_PRESENTATION_PROFILE)} .` : ''} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ZoneRevision, rv:RevisionAnchor ;
          rv:component ${iri(input.zone)} ; rv:predecessor ${iri(input.expectedHead)} ;
          rv:operation ${iri(operation)} ; rv:zoneOperation rv:${kind} ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(ZONE_PROFILE)} ; rv:shapeRevision ${iri(ZONE_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(scope)} ; rv:outcome rv:Succeeded ;
          rv:structureOwner ${iri(input.zone)} ; rv:structureRevision ${iri(revision)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
          rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:${kind}Event ; rv:ordinal 0 ; rv:action "zone.edit" ;
            rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} . }
      }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:zoneHead ${iri(input.expectedHead)} ;
          rv:zoneState ?oldState .
          OPTIONAL { ${iri(input.zone)} rv:defaultRealm ?oldRealm }
          OPTIONAL { ${iri(input.zone)} rv:official ?oldOfficial }
          OPTIONAL { ${iri(input.zone)} rv:presentation ?oldPresentation }
          OPTIONAL { ${iri(input.zone)} rv:defaultContext ?oldContext }
          OPTIONAL { ${iri(input.zone)} rv:defaultContextRevision ?oldContextRevision } }
        ${input.operation === 'retire' ? `GRAPH ${iri(GRAPHS.current)} {
          ${iri(head.navigation)} rv:selectedGeneration ?generation .
          ?generation rv:placementCount 0 . }` : ''}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }`;
    const validations = await profileValidations(env.fuseki, 'zone-capability-v1', [
      { shape: `${ZONE_PROFILE}/zone-shape`, focus: [input.zone],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: `${ZONE_PROFILE}/revision-shape`, focus: [revision],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]);
    try { await validatedCommand(env, { receipt, digest, update, validations,
      deadlineMs: 10_000 }, admission); }
    catch { /* The receipt resolves an ambiguous graph response. */ }
    if (!await readCompositionReceipt(env, admission.id, admission.action)) {
      const current = await readZoneConfiguration(env, input.zone);
      if (current.revision !== input.expectedHead) {
        const cancelled = await sealStructureAdmissionCancellation(env, admission);
        await access.recordGraphOutcome(admission.id, cancelled);
        throw new ZoneStale('Zone head changed');
      }
    }
  }
  const terminal = await readCompositionReceipt(env, registered.id, registered.action);
  if (!terminal) throw new PendingActivation('Zone revision outcome is unknown');
  await access.recordGraphOutcome(registered.id, terminal);
  terminalResult(terminal, registered);
  if (terminal.owner !== input.zone || terminal.requestDigest !== digest || !terminal.revision) {
    throw new IdempotencyConflict('Zone revision receipt differs from intent');
  }
  return { zone: input.zone, revision: terminal.revision, receipt: terminal.receipt,
    replayed: registered.replayed, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
}
