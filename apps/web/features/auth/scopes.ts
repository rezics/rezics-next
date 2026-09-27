/**
 * OAuth scopes the main site asks Account for, on the Main resource. Account
 * declares every token (`services/account/src/oauth-scopes.ts` and
 * `oauth-scopes/*.ts`); `tests/session-scopes.test.ts` keeps this list inside
 * those declarations. The dev bootstrap registers the web client with exactly
 * this list, and registration installs it as the client's ceiling, so adding a
 * scope here needs a fresh `task dev:prepare` (or a reinstallation) to take
 * effect. A scope only lets the site ask: Access still admits every action.
 * Every declared scope is either here or in `SCOPES_NOT_REQUESTED`.
 */
export const MAIN_SITE_SCOPES = [
  // The Account user as `sub`, and a refresh token so a session outlives the
  // five-minute access token.
  'openid', 'offline_access',
  // Acting identity: discover and check the Agents a person may act as, and
  // create a new Agent.
  'agent:create',
  // Works and their content: read, create, edit, protect, correct, review.
  'work:read', 'work:create', 'work:edit', 'work:protect', 'work:correct', 'work:review',
  'content:protect', 'content:correct', 'content:review',
  // Wiki structure and semantic resources.
  'zone:edit', 'collection:edit', 'semantic:read',
  // Addresses (Work slugs).
  'address:claim', 'address:manage',
  // Community: comments, ratings, judgments, statements, events and claims.
  'comment:create', 'rating:read', 'rating:submit', 'rating:configure',
  'judgment:read', 'judgment:write', 'statement:write', 'statement:decide',
  'event:read', 'event:submit',
  'claim:read', 'claim:create', 'claim:evidence', 'claim:challenge', 'claim:lineage',
  'claim:assess', 'claim:reliability',
  // Spaces, Realms and their classification.
  'space:create', 'realm:adopt', 'realm:reject', 'realm:classify',
  'classification:define', 'classification:decide',
  // Shared Contexts and the reader's private selections.
  'context:read', 'context:write', 'context:select',
  // Sources as a reader and as an editor adopting them into native Works.
  'source:read', 'source:adopt',
  // Packages a person installs, revokes or recommends for a Work.
  'package:read', 'package:install', 'package:revoke', 'package:recommendation-set',
  // Governance: reports and decisions, polls and ballots.
  'governance:report', 'governance:decide',
  'vote:read', 'vote:cast', 'vote:manage', 'vote:invalidate',
  // Rights assessments, decisions and offerings.
  'rights:assess', 'rights:decide', 'rights:offer',
  // Themes a person inspects or approves.
  'theme:read', 'theme:approve',
  // Organization and Access management: memberships, grants, roles, representation.
  'access:manage', 'access:membership-consent', 'access:approve', 'access:grant',
  'access:represent', 'access:representation-manage', 'access:role',
  // A person's own notifications, subscription, exports and connected-app consent.
  'notification:manage', 'subscription:manage', 'export:create', 'export:read',
  'connected-app:read', 'connected-app:consent',
] as const;

/** Declared scopes no person uses through the site. */
export const SCOPES_NOT_REQUESTED = [
  // Source pipelines: intake, acquisition, conversion, correspondence, proposals.
  'source:intake', 'source:acquire', 'source:convert', 'source:correspond', 'source:propose',
  // Package tooling: capture, verification and resolution.
  'package:capture', 'package:verify', 'package:resolve',
  // A connected App's own calls, made with its own token.
  'connected-app:invoke', 'connected-app:observe',
  // Operator runbooks for owner reconciliation and relocation.
  'owner:operate',
] as const;

/** The space-separated `scope` parameter for authorization requests. */
export const MAIN_SITE_SCOPE = MAIN_SITE_SCOPES.join(' ');
