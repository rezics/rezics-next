/**
 * VIEWER_ACTIONS_DRIVER is an absolute path or file URL exporting
 * createViewerActionsDriver(): Promise<ViewerActionsDriver>.
 * This is a TEST contract, not an Access adapter or product implementation.
 * Each factory owns an isolated migrated database and real createKernel/Auth/Access.
 * All requests traverse native bearer authentication and the mounted kernel router.
 * Return original Responses without status/header/body normalization.
 * Setup, grants, revocations, assignments, gates, suspension and bans use native
 * commands. Never write grant SQL, assert actors, model policy or fabricate answers.
 * Failed setup cleans up its own resources; close never removes another worker's.
 */
export const VIEWER_ACTIONS_MISSING_DRIVER = 'Viewer actions outcome driver is required';
export const VIEWER_ACTIONS_ROUTE = '/v1/viewerActions';
export type Credential = string; // actual bearer string, never an asserted actor
export type Persona = { accountId: string; credential: Credential };
export type ResourceReference = { type: string; id: string };
export type ViewerAction = { action: string; operations: string[] };
export type ViewerResource = ResourceReference &
  ({ viewerActions: ViewerAction[]; error?: never } | { error: 'not_found'; viewerActions?: never });
export type ViewerActionsResponse = { resources: ViewerResource[] };

export interface ViewerActionsFixture {
  /** Distinct accounts; editor is never curator. stranger has no collection/item mutation grant. */
  curator: Persona;
  editor: Persona;
  stranger: Persona;
  member: Persona;
  principal: Persona;
  /** Real authenticated requested_by assignment to principal, not a body principal. */
  assigned: Persona;
  collection: ResourceReference; // public library.collection, curator owns it
  otherCollection: ResourceReference; // public library.collection owned by stranger
  concealed: ResourceReference; // private Collection invisible to editor and stranger
  unknown: ResourceReference; // well-formed unknown ID of library.collection
  realm: ResourceReference; // public community.realm, member joined through native command
  /**
   * Ordinary mounted TEST module, type viewer_fixture.item. Its bounded native
   * existence/visibility read admits everyone, without an anonymous action floor.
   * These are real x-action/x-resource-types declarations, not driver policy:
   * viewer_fixture:inspect -> viewer_fixture.inspect (public exposure)
   * viewer_fixture:update -> viewer_fixture.alpha (gate:viewer_alpha)
   * viewer_fixture:update -> viewer_fixture.zulu (gate:viewer_zulu)
   * Commands use installed Access; declare zulu before alpha to exercise sorting.
   * editor has both exact actions and scopes; stranger has neither grant.
   */
  item: ResourceReference;
}

export type GrowthAxis = 'unrelated_grants' | 'unrelated_resources' | 'history';
export interface ViewerActionsTrace {
  statements: number;
  examinedRows: number; // actual plan rows * loops, including removed rows
  sharedBlocks: number; // shared hit + read blocks, never duration or returned rows
  sequentialRelations: string[]; // exclude only tiny core metadata
  /** Actual native preparation invocations, including failed preparations. */
  preparations: { actor: number; principal: number; gates: number };
  /** Native permission entry calls; invalid input must never reach them. */
  permissionCalls: number;
  /** Actual formula executions (including failed ones), never reconstructed expected decisions. */
  formulaPages: { type: string; action: string; ids: string[]; at: string }[];
  /** Native authoritative T values observed in preparation, gates and formulas. */
  readTimes: string[];
  /** Candidate action counts read from the composed metadata for selected types. */
  candidateActions: { type: string; count: number }[];
}

export interface ViewerActionsDriver {
  /**
   * Fresh unique resources/accounts on every call. Open collections/viewer_alpha/
   * viewer_zulu. editor and assigned actor/principal have collection:update;
   * all normal persona clients consent to the mounted fixture/native actions,
   * including collection:update for the ungranted stranger. member has realm:join
   * and realm:participate. authenticate is the explicit limited-scope variant.
   * Nobody starts with a gate bypass. Keep actor, principal, target and Global
   * authority on distinct physical partitions, each partition number <4096.
   */
  fixture(): Promise<ViewerActionsFixture>;
  request(credential: Credential | null, path: string, init?: RequestInit): Promise<Response>;
  /** Real client registration/consent/token issuance for the same account and exact scopes. */
  authenticate(persona: Persona, scopes: readonly string[]): Promise<Persona>;
  grant(persona: Persona, resource: ResourceReference, action: string): Promise<void>;
  revoke(persona: Persona, resource: ResourceReference, action: string): Promise<void>;
  grantGate(persona: Persona, group: string): Promise<void>; // 'any' means gate:any on Global
  gate(group: string, open: boolean): Promise<void>;
  suspend(persona: Persona): Promise<void>;
  ban(realm: ResourceReference, member: Persona): Promise<void>;
  revokeAssignment(assigned: Persona): Promise<void>;
  /**
   * Fail the actual Access dependency at this resource's formula, after earlier
   * resources can have positive decisions. Clear restores it. Never synthesize 503.
   */
  fault(resource: ResourceReference | null): Promise<void>;
  /** Native creates of public Collections; no editor update grants are added. */
  additionalCollections(curator: Persona, count: number): Promise<ResourceReference[]>;
  /**
   * Cumulative 128*scale rows at scales 1,4,16, added through native commands.
   * Grants/resources are unrelated to selected identities/anchors. History grows
   * closed grant/deny intervals on selected exact keys, keeping their live answers
   * unchanged. Grow axes independently; never enlarge selected neighbourhood or
   * admitted membership. Include unrelated route/partition data, not only one table.
   */
  seed(fixture: ViewerActionsFixture, scale: number, axis: GrowthAxis): Promise<void>;
  /** Observe ALL native request work, including failures, across authority connections. */
  measure<T>(read: () => Promise<T>): Promise<{ value: T; trace: ViewerActionsTrace }>;
  close(): Promise<void>;
}
