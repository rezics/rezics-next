import { Type } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const revision = Type.Integer({ minimum: 1 });
const verification = Type.Object(
  { account: UUID, receipt: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);
const linkChange = Type.Object(
  {
    context_id: Type.Optional(UUID),
    suppressed: Type.Optional(Type.Boolean()),
    property: Type.String({ minLength: 1 }),
    statement: UUID,
    target: Type.Union([UUID, Type.Null()]),
    present: Type.Boolean(),
    project_outbound: Type.Optional(Type.Boolean()),
    relation: Type.Optional(Type.Boolean()),
    slot_id: Type.Optional(UUID),
    external: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    value: Type.Optional(Type.Union([Type.Literal('value'), Type.Literal('somevalue'), Type.Literal('novalue')])),
    outbound_order: Type.Optional(
      Type.Union([Type.Literal('position'), Type.Literal('date'), Type.Literal('name'), Type.Null()]),
    ),
    outbound_order_key: Type.Optional(Type.String()),
    source_type: Type.Optional(Type.String()),
    order_key: Type.Optional(Type.String()),
    filter_value: Type.Optional(UUID),
  },
  { additionalProperties: false },
);

export const CATALOGUE_ARTIFACT = 'com.rezics.definitions.catalogue.artifact.v1' as const;
export const CATALOGUE_BUILD_REQUESTED = 'com.rezics.definitions.catalogue.build-requested.v1' as const;
export const CATALOGUE_ACTIVATION_REQUESTED = 'com.rezics.definitions.catalogue.activation-requested.v1' as const;
export const CATALOGUE_PROGRESS = 'com.rezics.definitions.catalogue.progress.v1' as const;
export const CATALOGUE_ACTIVATED = 'com.rezics.definitions.catalogue.activated.v1' as const;

export const SUBJECT_MERGED = 'com.rezics.subject.merged.v1' as const;
export const SUBJECT_REVISED = 'com.rezics.subject.revised.v1' as const;
export const LINKS_MOVING = 'com.rezics.semantic.links.moving.v1' as const;

export const LINKS_CHANGED = 'com.rezics.semantic.links.changed.v1' as const;
export const LINK_KEYS_CHANGED = 'com.rezics.semantic.links.keys-changed.v1' as const;
export const LINKS_VISIBILITY_CHANGED = 'com.rezics.semantic.links.visibility-changed.v1' as const;
export const LINKS_PROJECTED = 'com.rezics.semantic.links.projected.v1' as const;
export const IDENTITY_SCOPE_NATIVE_ASSOCIATED = 'com.rezics.semantic.identity-scope.native-associated.v1' as const;
export const IDENTITY_SCOPE_DIRECTORY_ENROLLED = 'com.rezics.semantic.identity-scope.directory-enrolled.v1' as const;
export const IDENTITY_EPOCH_ADMITTED = 'com.rezics.semantic.identity-epoch.admitted.v1' as const;
export const IDENTITY_EPOCH_HOME_AVAILABLE = 'com.rezics.semantic.identity-epoch.home-available.v1' as const;
export const IDENTITY_EPOCH_PROGRESS = 'com.rezics.semantic.identity-epoch.progress.v1' as const;
export const IDENTITY_EPOCH_BOOTSTRAP = 'com.rezics.semantic.identity-epoch.bootstrap.v1' as const;
export const IDENTITY_EPOCH_BOOTSTRAP_SCHEDULED = 'com.rezics.semantic.identity-epoch.bootstrap-scheduled.v1' as const;

export const RECORD_DELETED = 'com.rezics.semantic.record.deleted.v1' as const;
export const RECORD_RESTORED = 'com.rezics.semantic.record.restored.v1' as const;
const contextLifecycle = Type.Object(
  { kind: Type.Literal('context'), id: UUID, version: Type.String({ pattern: '^[1-9][0-9]*$' }) },
  { additionalProperties: false },
);
const candidateLifecycle = Type.Object(
  {
    kind: Type.Literal('candidate'),
    id: UUID,
    subject: UUID,
    version: Type.String({ pattern: '^[1-9][0-9]*$' }),
    deletedAt: Type.Union([Type.String(), Type.Null()]),
    purgeAfter: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const SUBJECT_PAGE_DEPENDENCIES_CHANGED = 'com.rezics.semantic.subject_page.dependencies_changed.v1' as const;
export const SUBJECT_PAGE_REPAIR_QUEUED = 'com.rezics.semantic.subject_page.repair_queued.v1' as const;
export const SUBJECT_PAGE_REPAIR_REQUESTED = 'com.rezics.semantic.subject_page.repair_requested.v1' as const;
export const SUBJECT_PAGE_WORK_COMMITTED = 'com.rezics.semantic.subject_page.work_committed.v1' as const;
const publicationSubject = Type.Object(
  { route: Type.Integer({ minimum: 0, maximum: 65535 }), id: UUID },
  { additionalProperties: false },
);
const publicationOwner = Type.Object(
  {
    kind: Type.Union([Type.Literal('subject'), Type.Literal('source-fence')]),
    route: Type.Integer({ minimum: 0, maximum: 65535 }),
    key: Type.String(),
  },
  { additionalProperties: false },
);
const publicationTime = Type.Object(
  {
    effectiveAt: Type.Union([Type.String(), Type.Null()]),
    evidence: Type.Union([Type.Literal('known'), Type.Literal('missing')]),
  },
  { additionalProperties: false },
);
const publicationComponent = Type.Object(
  { kind: Type.Union(['label', 'fact', 'cover', 'relation'].map((value) => Type.Literal(value))), key: Type.String() },
  { additionalProperties: false },
);

/** Closed semantic event catalogue. Envelope identity and ordering belong to the kernel. */
export const SEMANTIC_EVENTS = {
  [IDENTITY_SCOPE_NATIVE_ASSOCIATED]: Type.Object(
    {
      sourceKey: Type.String({ minLength: 1, maxLength: 256 }),
      scope: Type.String({ minLength: 1, maxLength: 256 }),
      phase: Type.Union(
        ['registration', 'capture', 'enrollment', 'ready', 'progress', 'finish'].map((p) => Type.Literal(p)),
      ),
      transactionId: UUID,
    },
    { additionalProperties: false },
  ),
  [IDENTITY_SCOPE_DIRECTORY_ENROLLED]: Type.Object(
    {
      sourceKey: Type.String({ minLength: 1, maxLength: 256 }),
      scope: Type.String({ minLength: 1, maxLength: 256 }),
      transactionId: UUID,
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.public-output.capture.v1': Type.Object({ captureId: UUID }, { additionalProperties: false }),
  [CATALOGUE_ARTIFACT]: Type.Object(
    {
      digest: Type.String(),
      kind: Type.Union(['root', 'node', 'release', 'declaration'].map((value) => Type.Literal(value))),
    },
    { additionalProperties: false },
  ),
  [CATALOGUE_BUILD_REQUESTED]: Type.Object({ rootDigest: Type.String() }, { additionalProperties: false }),
  [CATALOGUE_ACTIVATION_REQUESTED]: Type.Object(
    { rootDigest: Type.String(), activationId: UUID },
    { additionalProperties: false },
  ),
  [CATALOGUE_PROGRESS]: Type.Object(
    {
      rootDigest: Type.String(),
      state: Type.Union(['building', 'incomplete', 'refused', 'ready'].map((value) => Type.Literal(value))),
      steps: Type.String(),
    },
    { additionalProperties: false },
  ),
  [CATALOGUE_ACTIVATED]: Type.Object(
    {
      rootDigest: Type.String(),
      head: Type.Integer({ minimum: 1 }),
      kindSpec: Type.Literal('https://rezics.com/definitions/kind/1'),
      reduction: Type.Literal('https://rezics.com/definitions/kind-reduction/1'),
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.public-source.advanced.v1': Type.Object(
    { id: UUID, bootstrap: UUID, execution: Type.String({ minLength: 1, maxLength: 4096 }) },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.context-directory.changed.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.semantic.provider-review.projected.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.semantic.composite.registered.v1': Type.Object(
    { context: UUID, digest: Type.String() },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.erasure.scheduled.v1': Type.Object({ accountId: UUID }, { additionalProperties: false }),
  'com.rezics.semantic.erasure.locator-scheduled.v1': Type.Object(
    { position: Type.String({ pattern: '^[0-9]+$' }) },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.erasure.locator-advanced.v1': Type.Object(
    { position: Type.String({ pattern: '^[0-9]+$' }) },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.erasure.progress.v1': Type.Object({ accountId: UUID }, { additionalProperties: false }),
  [IDENTITY_EPOCH_HOME_AVAILABLE]: Type.Object(
    { partition: Type.Integer({ minimum: 0, maximum: 4095 }), after: UUID },
    { additionalProperties: false },
  ),
  [IDENTITY_EPOCH_BOOTSTRAP_SCHEDULED]: Type.Object(
    { partition: Type.Integer({ minimum: 0, maximum: 4095 }) },
    { additionalProperties: false },
  ),
  [IDENTITY_EPOCH_ADMITTED]: Type.Object(
    {
      jobId: UUID,
      epoch: Type.String({ pattern: '^[1-9][0-9]*$' }),
      partition: Type.Integer({ minimum: 0, maximum: 4095 }),
    },
    { additionalProperties: false },
  ),
  [IDENTITY_EPOCH_PROGRESS]: Type.Object(
    { partition: Type.Integer({ minimum: 0, maximum: 4095 }), generation: Type.String({ pattern: '^[1-9][0-9]*$' }) },
    { additionalProperties: false },
  ),
  [IDENTITY_EPOCH_BOOTSTRAP]: Type.Object(
    { partition: Type.Integer({ minimum: 0, maximum: 4095 }), generation: Type.String({ pattern: '^[1-9][0-9]*$' }) },
    { additionalProperties: false },
  ),
  [RECORD_DELETED]: Type.Union([contextLifecycle, candidateLifecycle]),
  [RECORD_RESTORED]: Type.Union([contextLifecycle, candidateLifecycle]),
  'com.rezics.source-record.metadata-changed.v1': Type.Object(
    {
      source: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
      external_id: Type.String({ minLength: 1, maxLength: 255 }),
      metadata_revision: revision,
    },
    { additionalProperties: false },
  ),
  [SUBJECT_PAGE_WORK_COMMITTED]: Type.Object(
    {
      partition: Type.Integer({ minimum: 0, maximum: 4095 }),
      kind: Type.Union(
        ['bootstrap', 'subject', 'fanout', 'dependency', 'owner', 'delivery'].map((value) => Type.Literal(value)),
      ),
    },
    { additionalProperties: false },
  ),
  [SUBJECT_PAGE_REPAIR_QUEUED]: Type.Object(
    { subject: publicationSubject, cause: Type.Union([Type.Literal('missing-proof'), Type.Literal('explicit')]) },
    { additionalProperties: false },
  ),
  [SUBJECT_PAGE_DEPENDENCIES_CHANGED]: Type.Object(
    {
      deltas: Type.Array(
        Type.Object(
          {
            subject: publicationSubject,
            component: publicationComponent,
            owner: publicationOwner,
            sourceVersion: Type.String({ pattern: '^[0-9]+$' }),
            eventId: Type.String(),
            changeId: Type.String(),
            present: Type.Boolean(),
            time: publicationTime,
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 16 },
      ),
    },
    { additionalProperties: false },
  ),
  [SUBJECT_PAGE_REPAIR_REQUESTED]: Type.Object(
    {
      subject: publicationSubject,
      owner: publicationOwner,
      changeId: Type.String(),
      eventId: Type.String(),
      time: publicationTime,
    },
    { additionalProperties: false },
  ),
  [SUBJECT_MERGED]: Type.Object({ id: UUID, survivor: UUID }, { additionalProperties: false }),
  [SUBJECT_REVISED]: Type.Object(
    {
      id: UUID,
      revision,
      kind: Type.Union([
        Type.Literal('create'),
        Type.Literal('terms'),
        Type.Literal('propose'),
        Type.Literal('accept'),
        Type.Literal('reject'),
        Type.Literal('adopt'),
        Type.Literal('merge'),
        Type.Literal('retract'),
        Type.Literal('identity'),
      ]),
    },
    { additionalProperties: false },
  ),
  [LINKS_MOVING]: Type.Object(
    {
      id: UUID,
      survivor: UUID,
      cursor: Type.Array(Type.Union([Type.String(), Type.Integer()])),
      verification: Type.Optional(verification),
    },
    { additionalProperties: false },
  ),
  [LINK_KEYS_CHANGED]: Type.Object(
    {
      subject: UUID,
      direction: Type.Union([Type.Literal('holder'), Type.Literal('target')]),
      revision,
      security_revision: Type.Integer({ minimum: 0 }),
      cursor: Type.Array(Type.Union([Type.String(), Type.Integer()])),
    },
    { additionalProperties: false },
  ),
  [LINKS_VISIBILITY_CHANGED]: Type.Object(
    {
      subject: UUID,
      revision,
      security_revision: Type.Integer({ minimum: 0 }),
      release: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
      visible: Type.Boolean(),
      cursor: Type.Array(Type.Union([Type.String(), Type.Integer()])),
    },
    { additionalProperties: false },
  ),
  'com.rezics.subject.statement_disclosed.v1': Type.Object(
    { id: UUID, candidate: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.statement.retracted.v1': Type.Object({ candidate: UUID, revision }, { additionalProperties: false }),
  'com.rezics.statement.proposed.v1': Type.Object({ candidate: UUID, revision }, { additionalProperties: false }),
  'com.rezics.statement.accepted.v1': Type.Object(
    { candidate: UUID, context: UUID, revision, head: revision },
    { additionalProperties: false },
  ),
  'com.rezics.statement.rejected.v1': Type.Object(
    { candidate: UUID, context: UUID, revision, head: revision },
    { additionalProperties: false },
  ),
  'com.rezics.subject.adopted.v1': Type.Object(
    {
      context: UUID,
      property: Type.String({ minLength: 1 }),
      mode: Type.Union([Type.Literal('inherit'), Type.Literal('replace'), Type.Literal('suppress')]),
      revision,
      head: revision,
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.links.changed.v1': Type.Object(
    {
      subject: UUID,
      revision,
      security_revision: Type.Integer({ minimum: 0 }),
      changes: Type.Array(linkChange, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.links.projected.v1': Type.Object(
    { subjects: Type.Array(UUID, { minItems: 1 }) },
    { additionalProperties: false },
  ),
} as const;
