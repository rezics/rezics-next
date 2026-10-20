import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import {
  ObjectIntegrityError,
  ObjectNotFound,
  type ImmutableObjects,
} from '../src/infrastructure/immutable-objects.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import {
  compositionReceiptIri,
  orderTree,
  recordTree,
  type CompositionTerminal,
} from '../src/modules/structure/change.ts';
import {
  STRUCTURE_MANIFEST_FORMAT,
  STRUCTURE_PAGE_FORMAT,
  STRUCTURE_PROFILE,
  type OccurrenceRecord,
  type OrderEntry,
  type StructureManifest,
} from '../src/modules/structure/format.ts';
import {
  COMPOSITION_PROFILE,
  derivedId,
  orderTreeKey,
  type CompositionHeader,
} from '../src/modules/structure/graph.ts';
import type { AcknowledgedStructureOccurrence } from '../src/modules/structure/native-basis.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import {
  prepareWorkComponent,
  RV,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { metadataWorkRequestDigest } from '../src/modules/work/activate.ts';
import { workReceiptIri } from '../src/modules/work/receipt.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { OpenLibraryConversionStore } from '../src/modules/source/open-library-conversion.ts';
import {
  OpenLibrarySourceGraph,
  sourceProjectionIdentity,
} from '../src/modules/source/graph-projection.ts';
import { SourceNativeWorkProposalStore } from '../src/modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore } from '../src/modules/source/native-work-adoption.ts';

type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const row = (values: Record<string, string>): Row =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { type: 'literal', value }]),
  );
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const structurePrincipal = { issuer: 'https://account.test', subject: 'structure-reader' };

interface Revision {
  header: CompositionHeader;
  operation: string;
  model: string;
  dataEpoch: string;
  sequence: string;
}

/** Source regression fixture derived from G-2799's Structure owner fixture.
 * Actual immutable trees, manifests and native receipt readers, with controlled
 * graph/Access transports. It establishes no public API or native command proof. */
export async function structureSourceFixture(sourceKey: string, externalId: string) {
  const profile = 'episode-list-v1';
  const seed = randomUUID();
  const id = (name: string) => derivedId(`${seed}:${name}`);
  const dataEpoch = randomUUID();
  let extraQuery: ((body: string) => Promise<SparqlResult | undefined>) | undefined;
  const owner = id('ack-owner'),
    component = id('ack-main'),
    structure = id('ack-structure');
  const group = id('ack-group'),
    first = id('ack-first'),
    second = id('ack-second');
  const episode = id('ack-episode');
  const bytes = new Map<string, Uint8Array>(),
    receipts = new Map<string, CompositionTerminal>();
  const operations = new Map<string, string>(),
    revisions = new Map<string, Revision>(),
    queries: string[] = [];
  let header: CompositionHeader;
  let writes = 0,
    active = true,
    readable = true,
    disclosed = true,
    terminalAvailable = true,
    sequence = 0;
  let ownerReads = 0,
    withdrawOwnerOnRead = Infinity;
  let objectRead: (() => void) | undefined;
  let targetTypes = ['https://schema.org/TVEpisode'],
    targetManifest = '',
    targetChecks = 0;
  let targetHead: string | undefined,
    targetVersion = 0;
  let targetCheck: ((count: number) => void) | undefined,
    targetUnavailable = false;
  const objects: ImmutableObjects = {
    async put(body) {
      writes++;
      const digest = sha256(body);
      bytes.set(digest, new Uint8Array(body));
      return digest;
    },
    async get(digest) {
      objectRead?.();
      const body = bytes.get(digest);
      if (!body) throw new ObjectNotFound('fixture object is absent');
      if (sha256(body) !== digest) throw new ObjectIntegrityError('fixture object digest differs');
      return new Uint8Array(body);
    },
  };
  const query = async (body: string): Promise<SparqlResult> => {
    queries.push(body);
    const extra = await extraQuery?.(body);
    if (extra) return extra;
    if (body.includes('SELECT ?provider ?namespace ?key'))
      return {
        results: {
          bindings: [row({ provider: 'bangumi', namespace: 'episode', key: externalId })],
        },
      };
    if (body.includes('ASK') && body.includes('rv:restoreHold')) return { boolean: true };
    let rows: Row[];
    if (body.includes('SELECT ?target WHERE')) {
      targetChecks++;
      targetCheck?.(targetChecks);
      if (targetUnavailable) throw new Error('Native target owner unavailable');
      rows =
        targetTypes.includes('https://schema.org/TVEpisode') &&
        !!targetHead &&
        !targetTypes.includes('https://schema.org/CreativeWork')
          ? []
          : [row({ target: episode })];
    } else if (body.includes('SELECT DISTINCT ?target ?head')) {
      const values = body.match(/VALUES \?target \{([^}]*)\}/)?.[1] ?? '';
      rows = [...new Set([...values.matchAll(/<([^>]+)>/g)].map((match) => match[1]!))].map(
        (target) => ({
          target: { type: 'uri', value: target },
          ...(target === episode && targetHead ? { head: { type: 'uri', value: targetHead } } : {}),
        }),
      );
    } else if (body.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
      rows = [
        row({
          epoch: dataEpoch,
          sequence: String(sequence),
          r: episode,
          type: 'resource',
          public: 'false',
          erased: 'false',
        }),
      ];
    } else if (body.includes('SELECT ?resource ?manifest')) {
      rows = [row({ resource: episode, manifest: targetManifest })];
    } else if (body.includes('SELECT ?main ?public ?structuredDecision')) {
      rows = body.includes(`<${owner}>`) ? [row({ main: component, public: 'false' })] : [];
    } else if (body.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      rows = body.includes(`<${episode}>`)
        ? [row({ work: episode, ...(targetHead ? { head: targetHead } : {}) })]
        : [
            row({
              work: owner,
              head: id('ack-work-head'),
              owningWork: owner,
              owningHead: id('ack-work-head'),
            }),
          ];
    } else if (body.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest')) {
      rows = body.includes(`<${structure}>`)
        ? [
            row({
              component: header.component,
              profile: structureProfileFor(header.profile).graphProfile,
              head: header.head,
              generation: header.generation,
              count: String(header.placementCount),
              manifest: header.manifest,
            }),
          ]
        : [];
    } else if (body.includes('SELECT ?owner WHERE')) {
      rows = [row({ owner: header.owner })];
    } else if (body.includes('SELECT ?admission ?operation WHERE')) {
      const receipt = [...receipts.values()].find((item) => body.includes(`<${item.receipt}>`));
      rows = receipt
        ? [
            row({
              admission: receipt.admissionId,
              ...(operations.has(receipt.receipt)
                ? { operation: operations.get(receipt.receipt)! }
                : {}),
            }),
          ]
        : [];
    } else if (body.includes('SELECT ?outcome ?reason ?kind ?action')) {
      const receipt = [...receipts.values()].find((item) => body.includes(`<${item.receipt}>`));
      rows =
        receipt && terminalAvailable
          ? [
              row({
                outcome: `${RV}${receipt.outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`,
                digest: receipt.requestDigest,
                admission: receipt.admissionId,
                epoch: receipt.authorityEpoch,
                scope: receipt.scope,
                dataEpoch: receipt.dataEpoch,
                sequence: receipt.sequence,
                ...(receipt.action ? { action: receipt.action } : {}),
                ...(receipt.structure ? { structure: receipt.structure } : {}),
                ...(receipt.revision ? { revision: receipt.revision } : {}),
                ...(receipt.owner ? { owner: receipt.owner } : {}),
                ...(receipt.component ? { component: receipt.component } : {}),
              }),
            ]
          : [];
    } else if (body.includes('SELECT ?model ?epoch ?sequence')) {
      const revision = [...revisions.values()].find((item) =>
        body.includes(`<${item.header.head}>`),
      );
      rows =
        revision &&
        [
          revision.header.structure,
          revision.header.manifest,
          revision.header.generation,
          revision.operation,
        ].every((value) => body.includes(`<${value}>`))
          ? [row({ model: revision.model, epoch: revision.dataEpoch, sequence: revision.sequence })]
          : [];
    } else if (body.includes('SELECT ?manifest ?predecessor ?count ?epoch ?sequence')) {
      const revision = [...revisions.values()].find((item) =>
        body.includes(`<${item.header.head}>`),
      );
      rows = revision
        ? [
            row({
              manifest: revision.header.manifest,
              count: String(revision.header.placementCount),
              epoch: revision.dataEpoch,
              sequence: revision.sequence,
            }),
          ]
        : [];
    } else throw new Error(`Unexpected owner query: ${body}`);
    return { results: { bindings: rows } };
  };
  const environment = {
    fuseki: {
      query,
      update: async () => {
        throw new Error('A read cannot mutate native state');
      },
    },
    lineage: { dataEpoch: dataEpoch, routingEpoch: '1' },
    structureObjects: objects,
    workObjects: objects,
  } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, {
    read: async (targets) =>
      targets.map((target) =>
        target.component === 'structure' && !disclosed ? 'hidden' : 'visible',
      ),
  });
  const dependencies = {
    environment,
    access: {
      activePrincipalId: async () => (active ? 'principal-1' : null),
      assertRecoveryOpen: async () => {},
      canReadWork: async () => {
        ownerReads++;
        return readable && ownerReads < withdrawOwnerOnRead;
      },
      canReadSemanticResource: async (_principal: unknown, _actor: string, resource: string) =>
        resource === episode,
    },
  } as unknown as MainWorkDependencies;
  const session = () => {
    const result = new WorkReadSession(
      dependencies,
      new Request('https://main.test/private-owner-read'),
      { actingSubject: id('ack-actor') },
      { dataEpoch: dataEpoch, sequence: String(sequence) },
    );
    result.principal = structurePrincipal;
    return result;
  };
  const install = async (
    records: OccurrenceRecord[],
    ordered?: OrderEntry[],
  ): Promise<AcknowledgedStructureOccurrence> => {
    sequence++;
    const revision = id(`ack-revision-${sequence}`),
      operation = id(`ack-operation-${sequence}`);
    const cost = newCost(),
      recordsTree = recordTree(objects),
      orderingTree = orderTree(objects);
    const root = await recordsTree.apply(
      await recordsTree.empty(cost),
      new Map(records.map((record) => [record.occurrence, record])),
      cost,
    );
    const entries =
      ordered ??
      records
        .filter((record) => record.state === 'active')
        .map((record) => ({
          occurrence: record.occurrence,
          parent: record.parent,
          segmentKey: record.segmentKey!,
          orderKey: record.orderKey!,
        }));
    const order = await orderingTree.apply(
      await orderingTree.empty(cost),
      new Map(entries.map((entry) => [orderTreeKey(entry), entry])),
      cost,
    );
    const manifest: StructureManifest = {
      format: STRUCTURE_MANIFEST_FORMAT,
      structure,
      structureOf: component,
      profile,
      generation: id('ack-generation'),
      pageFormat: STRUCTURE_PAGE_FORMAT,
      records: root,
      order,
      placementCount: entries.length,
      measures: [],
      model: STRUCTURE_PROFILE,
      shape: STRUCTURE_PROFILE,
    };
    const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
    header = {
      structure,
      profile,
      owner,
      component,
      mainVersion: component,
      work: owner,
      head: revision,
      generation: manifest.generation,
      placementCount: entries.length,
      manifest: `urn:rezics:sha256:${digest}`,
    };
    const admission = id(`ack-admission-${sequence}`).slice('https://rezics.com/id/'.length);
    const receipt = compositionReceiptIri(admission, structureProfileFor(profile).editAction);
    receipts.set(receipt, {
      outcome: 'succeeded',
      receipt,
      admissionId: admission,
      requestDigest: sha256(`command-${sequence}`),
      action: 'work.edit',
      authorityEpoch: '7',
      scope: `work:edit:${owner}`,
      dataEpoch: dataEpoch,
      sequence: String(sequence),
      structure,
      revision,
    });
    operations.set(receipt, operation);
    revisions.set(revision, {
      header: structuredClone(header),
      operation,
      model: COMPOSITION_PROFILE,
      dataEpoch: dataEpoch,
      sequence: String(sequence),
    });
    return {
      kind: 'structure-occurrence',
      owner: 'structure',
      target: owner,
      component,
      structure,
      profile,
      revision,
      receipt,
      occurrence: first,
    };
  };
  const introducedBy = id('ack-original-revision');
  const setTargetTypes = async (types: string[]) => {
    targetTypes = [...types];
    const state = checkedComponentState({
      component: 'resource',
      types,
      lifecycle: 'active',
      properties: [
        {
          predicate: 'https://schema.org/name',
          value: { kind: 'language-string', lexical: 'Retained episode', language: 'en' },
        },
        {
          predicate: 'https://schema.org/identifier',
          value: { kind: 'external', provider: 'bangumi', namespace: 'episode', key: externalId },
        },
      ],
    });
    const digest = await prepareWorkComponent(objects, episode, state, PROFILES.resource);
    targetManifest = `urn:rezics:sha256:${digest}`;
    targetHead = id(`ack-target-revision-${++targetVersion}`);
  };
  if (profile === 'episode-list-v1') await setTargetTypes(targetTypes);
  const records: OccurrenceRecord[] = [
    {
      occurrence: group,
      state: 'active',
      parent: structure,
      segmentKey: 'a',
      orderKey: 'a',
      role: 'group',
      labels: [],
      introducedBy,
    },
    ...[first, second].map((occurrence, ordinal): OccurrenceRecord => ({
      occurrence,
      state: 'active',
      parent: group,
      segmentKey: 'a',
      orderKey: ordinal ? 'b' : 'a',
      role: 'episode',
      target: episode,
      labels: [],
      introducedBy,
      sourceKey,
      qualifier: {
        type: 'fields',
        id: 'episode-order-v1',
        values: {
          position: { numerator: 1, denominator: ordinal ? 1 : 2 },
          disc: { numerator: 0, denominator: 1 },
          kindCode: '1',
          kindScheme: 'bangumi:episode:type',
        },
      },
    })),
  ];
  const basis = await install(records);
  return {
    basis,
    records,
    dataEpoch,
    environment,
    dependencies,
    actor: id('ack-actor'),
    addQuery: (fn: (body: string) => Promise<SparqlResult | undefined>) => {
      extraQuery = fn;
    },
    first,
    second,
    group,
    bytes,
    receipts,
    revisions,
    operations,
    queries,
    install,
    session,
    header: () => header,
    writes: () => writes,
    episode,
    setTargetTypes,
    targetChecks: () => targetChecks,
    onTargetCheck: (fn: (count: number) => void) => {
      targetCheck = fn;
    },
    targetTypes: (types: string[]) => {
      targetTypes = [...types];
    },
    targetUnavailable: (value: boolean) => {
      targetUnavailable = value;
    },
    active: (value: boolean) => {
      active = value;
    },
    readable: (value: boolean) => {
      readable = value;
    },
    disclosed: (value: boolean) => {
      disclosed = value;
    },
    terminalAvailable: (value: boolean) => {
      terminalAvailable = value;
    },
    withdrawOwnerAtCompletion: () => {
      ownerReads = 0;
      withdrawOwnerOnRead = 2;
    },
    onObjectRead: (fn: () => void) => {
      objectRead = fn;
    },
  };
}

/** Actual intake/conversion/proposal and Source binding readers. The SQL binding
 * and native terminal below are fixture prerequisites, explicitly not evidence
 * that a native create command ran. Their independent codecs must still agree. */
export async function structureParentBinding(
  pool: Pool,
  f: Awaited<ReturnType<typeof structureSourceFixture>>,
  subjectId: string,
  principalId: string,
) {
  const intake = new SourceIntakeStore(pool);
  const observed = (
    await intake.submit(principalId, randomUUID(), {
      provider: 'bangumi',
      namespace: 'subject',
      externalId: subjectId,
      sourceRevision: null,
      mediaType: 'application/json',
      retention: 'retained',
      rawBytesBase64: Buffer.from(
        JSON.stringify({ id: Number(subjectId), type: 2, name: 'Retained series' }),
      ).toString('base64'),
      coverage: { scope: 'bangumi-subject-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'facts', note: 'Isolated owner regression' },
    })
  ).observation;
  const conversions = new OpenLibraryConversionStore(pool, intake);
  const converted = (await conversions.convertMapped(
    principalId,
    observed.observation.slice(-36),
    'bangumi-subject-map-v1',
  ))!.conversion;
  const projection = sourceProjectionIdentity(converted),
    admission = randomUUID();
  const workRevision = derivedId(randomUUID()),
    mainRevision = derivedId(randomUUID());
  let available = true;
  f.addQuery(async (body) => {
    if (body.includes('SELECT ?digest ?epoch ?sequence'))
      return {
        results: {
          bindings: body.includes(`<${projection.receipt}>`)
            ? [row({ digest: projection.digest, epoch: f.dataEpoch, sequence: '1' })]
            : [],
        },
      };
    if (body.includes('ASK') && body.includes('<urn:rezics:graph:source>'))
      return {
        boolean:
          body.includes(`<${converted.conversion}>`) &&
          body.includes(`<${observed.record}>`) &&
          body.includes(`<${observed.observation}>`),
      };
    if (body.includes('SELECT ?outcome ?digest ?admissionId'))
      return {
        results: {
          bindings:
            available && body.includes(`<${workReceiptIri(admission)}>`)
              ? [
                  row({
                    outcome: `${RV}Succeeded`,
                    digest: metadataWorkRequestDigest(
                      'Retained series',
                      converted.projection.semanticTypes,
                      'en',
                    ),
                    admissionId: admission,
                    authorityEpoch: '1',
                    scope: 'work:create:root',
                    work: f.basis.target,
                    main: f.basis.component,
                    workRevision,
                    mainRevision,
                    epoch: f.dataEpoch,
                    sequence: '1',
                  }),
                ]
              : [],
        },
      };
    return undefined;
  });
  const graph = new OpenLibrarySourceGraph(
    f.environment.fuseki,
    f.environment.lineage,
    conversions,
  );
  const proposals = new SourceNativeWorkProposalStore(pool, graph, conversions);
  const proposal = (await proposals.propose(principalId, converted.conversion.slice(-36)))!
    .proposal;
  const intent = randomUUID(),
    bindingId = randomUUID();
  await pool.query(
    `INSERT INTO source.native_work_adoption_intent
    (id,proposal_id,principal_id,acting_subject,authority_path,confirmed_title,title_language,
      work_idempotency_key,title_language_basis,activation_language,request_title_language)
    VALUES ($1,$2,$3,$4,'direct-principal','Retained series','en',$5,'explicit','en','en')`,
    [intent, proposal.proposal.slice(-36), principalId, f.actor, `source-adopt-${intent}`],
  );
  await pool.query(
    `INSERT INTO source.native_work_binding
    (id,intent_id,proposal_id,principal_id,work,main_version,work_revision,main_revision,graph_receipt,admission_id,data_epoch,sequence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
    [
      bindingId,
      intent,
      proposal.proposal.slice(-36),
      principalId,
      f.basis.target,
      f.basis.component,
      workRevision,
      mainRevision,
      workReceiptIri(admission),
      admission,
      f.dataEpoch,
    ],
  );
  const adoptions = new SourceNativeWorkAdoptionStore(
    pool,
    proposals,
    f.environment,
    {
      verify: async () => {
        throw new Error('Fixture cannot authorize a command');
      },
    },
    {} as ConstructorParameters<typeof SourceNativeWorkAdoptionStore>[4],
  );
  return {
    adoptions,
    bindingId,
    available: (value: boolean) => {
      available = value;
    },
  };
}
