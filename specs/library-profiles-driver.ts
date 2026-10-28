/**
 * TEST-ONLY NATIVE BINDING. LIBRARY_PROFILES_DRIVER is an absolute path or file
 * URL exporting createLibraryProfilesDriver(): Promise<LibraryProfilesDriver>.
 * Each factory owns an isolated migrated PostgreSQL database, a real kernel,
 * signed account/session tokens, real Access grants, and the production durable
 * work executor. close() stops only its executor and removes only its fixtures.
 *
 * request() passes every API operation through createKernel(...).handle and
 * returns the raw Response. The driver provisions definitions with the real
 * @rezics/definitions compiler and the existing Global definitions publish /
 * activate routes; it provisions subjects and facts through production
 * commands. It never models policy, normalizes product outcomes, writes source
 * truth with SQL, or manufactures migration counts. Inspection reads actual
 * rows/receipts/events. Faults and pauses target named production persistence
 * and worker boundaries. SQL measurements count actual result rows and bytes;
 * seeding, inspection, compiler setup, and async worker work are reported apart
 * from the measured request.
 */
export type LibraryProfilePersona = 'owner' | 'other' | 'anonymous' | 'suspended' | 'steward';
export type LibraryProfileVertical =
  | 'game'
  | 'recipe'
  | 'record'
  | 'book'
  | 'book-edition'
  | 'anime'
  | 'people'
  | 'concept'
  | 'inheritance-child';

/** Consumer pin shape used by inspection; this is not a definitions profile schema. */
export type StoredLibraryProfilePin =
  | { provenance: 'profile'; releaseDigest: string; acceptingType: string; profileId: string }
  | {
      provenance: 'legacy';
      releaseDigest: string;
      acceptingType: string | null;
      profileId: 'legacy-fixed-v1';
    };

export interface ProfileEntryRow {
  accountId: string;
  subjectId: string;
  state: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  activityAt: string | null;
  finishedAt: string | null;
  transactionId: string;
  pin: StoredLibraryProfilePin | null;
}

export interface ProfileSessionRow {
  accountId: string;
  id: string;
  subjectId: string;
  versionSubjectId: string | null;
  mode: string;
  unit: string;
  total: string | null;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: string;
  revision: number;
  startedAt: string;
  completedAt: string | null;
  lastChangedAt: string | null;
  transactionId: string;
  pin: StoredLibraryProfilePin | null;
}

export interface ProfileCopyRow {
  accountId: string;
  id: string;
  subjectId: string;
  /** Absent in the pre-profile row shape; migrated rows use legacy-unspecified. */
  kind?: string;
  status: string;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  transactionId: string;
  pin: StoredLibraryProfilePin | null;
}

export interface ProfileReceiptRow {
  accountId: string;
  requestKey: string;
  digest: string;
  status: number;
  response: unknown;
}

export interface ProfileMigrationPage {
  transactionId: string;
  /** Aggregate across entry/session/copy rows in this page transaction. */
  ownerRowsRead: number;
  /** Actual native source scan keys including filtered pinned rows and loops, not changed/result row counts. */
  sourceRowsExamined: number;
  sourcePlans: { relation: string; indexName: string; rowsExamined: number; rowsRemovedByFilter: number }[];
  ownerRowsChanged: number;
  bytesRead: number;
  bytesWritten: number;
  statements: number;
  /** Actual SQL tuples returned/changed by relation; omitted relations have zero. */
  relationRowsRead: Record<string, number>;
  relationRowsWritten: Record<string, number>;
  checkpointBefore: unknown;
  checkpointAfter: unknown;
  committed: boolean;
  ownerFenceChecked: boolean;
}

export interface LibraryProfilesInspection {
  entries: ProfileEntryRow[];
  independentLabels: unknown[];
  ratings: unknown[];
  sessions: ProfileSessionRow[];
  completedUnits: { sessionId: string; unitId: string }[];
  changes: { sessionId: string; changeNo: number; intent: unknown; recordedAt: string; transactionId: string }[];
  copies: ProfileCopyRow[];
  receipts: ProfileReceiptRow[];
  migration: {
    jobs: unknown[];
    checkpoints: unknown[];
    pages: ProfileMigrationPage[];
  };
  events: { type: string; subject: string; data: unknown }[];
  importRuns: unknown[];
}

/**
 * Named compiler inputs, not mocked releases: v2 replaces the `in_progress`
 * state ID with `reading` while retaining `planned`; v3 removes `planned`.
 * Numeric boundaries have absent precision on the page pair. The inheritance
 * fixture gives a child distinct profiles at two ancestors so its compiled
 * type pointer proves nearest-declaration selection.
 */
export type ProfileReleaseScenario =
  | 'profile-v1'
  | 'profile-v2-changed-ids'
  | 'profile-v3-removed-ids'
  | 'profile-absent'
  | 'profile-inheritance-conflict'
  | 'profile-inheritance-nearest'
  | 'profile-import-declaration-only'
  | 'profile-numeric-boundaries'
  | 'profile-fixture-verticals'
  | 'profile-manifests-10'
  | 'profile-manifests-100';

export type ProfileCompilation =
  | { valid: true; digest: string; release: Record<string, unknown> }
  | { valid: false; errors: { pointer: string; code: string }[] };

export type ProfileMigrationBoundary =
  | 'after-page-read-before-cas'
  | 'before-page-commit'
  | 'after-page-commit-before-ack'
  | 'before-owner-ready';

export interface LibraryProfilesFixture {
  accounts: Record<Exclude<LibraryProfilePersona, 'anonymous'>, { accountId: string; signedToken: string }>;
  subjects: Partial<Record<LibraryProfileVertical, string>>;
  globalContext: string;
}

export interface ProfileSqlMeasurement {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface LibraryProfilesDriver {
  /** Creates a real kernel fixture. Existing bundle head is not changed by fixture compilation. */
  fixture(): Promise<LibraryProfilesFixture>;
  /** Uses the actual package compiler; scenarios contain schema/presentation data, never compiler output. */
  compile(scenario: ProfileReleaseScenario): Promise<ProfileCompilation>;
  /** Uses semantic subject commands to create a fixture vertical or a bundled type. */
  provisionSubject(fixture: LibraryProfilesFixture, vertical: LibraryProfileVertical): Promise<string>;
  /** Reads the actual current subject type through production semantic reads for pin assertions. */
  readAcceptingType(fixture: LibraryProfilesFixture, subjectId: string): Promise<string>;
  /** Calls the current independent-label production API and returns its raw response. */
  addLabel(fixture: LibraryProfilesFixture, subjectId: string, labelId: string): Promise<Response>;
  /** Calls the separate rating production API and returns its raw response. */
  rateSubject(fixture: LibraryProfilesFixture, subjectId: string, value: number): Promise<Response>;
  /** Raw production HTTP transport with the named persona's real signed identity and Access result. */
  request(
    fixture: LibraryProfilesFixture,
    persona: LibraryProfilePersona,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /**
   * Fixture creation through real old-version/current production commands, never raw fact INSERTs. Without an
   * explicit count, seed the five legacy entry states, all 18 mode/unit pairs, all four copy statuses, sparse IDs
   * {1,3,7}, the 12-integer/6-fraction scalar boundary, and existing receipt rows. Explicit counts request exact
   * relation sizes for migration-scale cases.
   */
  seedLegacyFacts(
    fixture: LibraryProfilesFixture,
    rows?: { entries: number; sessions: number; copies: number },
  ): Promise<void>;
  /** Ensures exactly this many unrelated owner facts through production APIs; it never seeds the measured subject. */
  ensureUnrelatedFacts(fixture: LibraryProfilesFixture, totalCount: number): Promise<void>;
  /** Runs the production owner migration command/worker for the captured immutable target digest. */
  migrateOwner(fixture: LibraryProfilesFixture, releaseDigest: string): Promise<void>;
  pauseNextMigration(
    fixture: LibraryProfilesFixture,
    boundary: ProfileMigrationBoundary,
  ): Promise<{ reached: Promise<void>; resume(): Promise<void> }>;
  crashNextMigration(fixture: LibraryProfilesFixture, boundary: ProfileMigrationBoundary): Promise<void>;
  /** Restarts only this fixture's real durable executor and replays persisted work/receipts. */
  recoverMigration(fixture: LibraryProfilesFixture): Promise<void>;
  /** Current grant revocation through the real Access grant-admin command. */
  revoke(fixture: LibraryProfilesFixture, persona: 'owner', action: string, resourceId: string): Promise<void>;
  /** Removes only the owner's current subject-read membership through real Access administration. */
  revokeSubjectRead(fixture: LibraryProfilesFixture, subjectId: string): Promise<void>;
  /** Account deletion through the real account lifecycle API and its authoritative tombstone. */
  deleteOwner(fixture: LibraryProfilesFixture): Promise<void>;
  /** Reads actual immutable release bytes and counts from the published definition row. */
  inspectRelease(
    fixture: LibraryProfilesFixture,
    digest: string,
  ): Promise<{ canonicalBytes: number; typeCount: number; propertyCount: number; profileRegistryBytes: number }>;
  inspect(fixture: LibraryProfilesFixture): Promise<LibraryProfilesInspection>;
  /** Measures actual SQL around one HTTP operation; setup, inspection and background work are excluded. */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; sql: ProfileSqlMeasurement }>;
  close(): Promise<void>;
}
