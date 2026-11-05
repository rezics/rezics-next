/**
 * VIEWER_ACTIONS_SURFACES_DRIVER is an absolute path or file URL exporting
 * createViewerActionsSurfacesDriver(): Promise<ViewerActionsSurfacesDriver>.
 * This is a TEST transport contract, not an Access adapter or policy implementation.
 * Each factory owns an isolated migrated database and real createKernel/Auth/Access.
 * Requests traverse native bearer authentication and the mounted kernel router;
 * return original Responses without normalizing status, headers or bodies.
 * Setup, scope consent, grants, subject visibility and suspension use native commands.
 * Never assert actors, write grant SQL, model eligibility or fabricate viewer answers.
 * Failed setup cleans up its resources; close never removes another worker's resources.
 */
import type { Credential, Persona, ResourceReference } from './viewer-actions-driver.ts';
export type { Credential, Persona, ResourceReference, ViewerActionsResponse } from './viewer-actions-driver.ts';

export const VIEWER_ACTIONS_SURFACES_MISSING_DRIVER = 'Viewer actions surfaces outcome driver is required';
export const VIEWER_ACTIONS_SURFACES_ROUTE = '/v1/viewerActions';
export type SurfaceAction = 'follow:create' | 'follow:delete' | 'library_entry:update' | 'library_entry:delete';

export interface ViewerActionsSurfacesFixture {
  /** Native services/kernel/test/support/personas.ts identities and real issued bearers. */
  alice: Persona;
  bob: Persona;
  anonymous: { credential: null };
  /** Bearer issued before this account's native suspension, retained unchanged. */
  suspended: Persona;
  /**
   * Native unscoped persona: omit exactly action from consent, retaining its grant
   * and every other mounted scope. Use the real persona helper's resource/grantor
   * inputs as needed for the owning account authority; do not emulate scope checks.
   */
  unscoped(action: SurfaceAction): Promise<Persona>;
  /**
   * At least 20 distinct public catalogue subjects, all schema:Book from the active
   * bundled packages/definitions release. References use that released semantic type.
   * Alice and Bob start without follows or entries on these subjects. Both have the
   * four exact action scopes and native own-account authority; relevant gates are open.
   * No subject mutation grants or anonymous mutation floor are installed.
   */
  subjects: ResourceReference[];
  withheld: ResourceReference; // same type, withheld through native catalogue moderation
  concealed: ResourceReference; // same type, invisible to Alice, Bob and anonymous
  unknown: ResourceReference; // same type, well-formed ID with no subject
}

export interface ViewerActionsSurfacesDriver {
  /** Fresh resources and personas on each call, with native public subject read access. */
  fixture(): Promise<ViewerActionsSurfacesFixture>;
  request(credential: Credential | null, path: string, init?: RequestInit): Promise<Response>;
  /** Real issuance for the same account with precisely these consented scopes. */
  authenticate(persona: Persona, scopes: readonly string[]): Promise<Persona>;
  suspend(persona: Persona): Promise<void>;
  close(): Promise<void>;
}
