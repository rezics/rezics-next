import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  REVISION_DISCLOSURE_AUDIENCE,
  REVISION_DISCLOSURE_POLICY_VERSION,
  isRevisionDisclosureDigest,
  isRevisionDisclosureUuid,
  revisionDisclosureState,
  type RevisionDisclosureCatalogue,
  type RevisionDisclosureIncarnation,
  type RevisionDisclosureObservation,
  type RevisionDisclosureRow,
  type RevisionDisclosureSource,
  type RevisionDisclosureTarget,
} from './revision-disclosure-model.ts';
import readDisclosure from './revision-disclosure-read.sql';
import lookupDisclosure from './revision-disclosure-lookup.sql';
import lockDisclosure from './revision-disclosure-lock.sql';

export function revisionDisclosureDigest(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new TypeError('Revision disclosure digest requires canonical JSON');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function revisionDisclosureHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function sameRevisionDisclosureTarget(
  a: RevisionDisclosureTarget | null | undefined,
  b: RevisionDisclosureTarget,
): a is RevisionDisclosureTarget {
  return (
    !!a && a.threadId === b.threadId && a.postId === b.postId && a.revisionId === b.revisionId && a.sha256 === b.sha256
  );
}

export function sameRevisionDisclosureIncarnation(
  a: RevisionDisclosureIncarnation | null | undefined,
  b: RevisionDisclosureIncarnation,
): a is RevisionDisclosureIncarnation {
  return (
    !!a &&
    a.postTransactionId === b.postTransactionId &&
    a.threadTransactionId === b.threadTransactionId &&
    a.postSecurityRevision === b.postSecurityRevision &&
    a.threadSecurityRevision === b.threadSecurityRevision
  );
}

export function sameRevisionDisclosureSource(
  a: RevisionDisclosureSource | null | undefined,
  b: RevisionDisclosureSource,
): a is RevisionDisclosureSource {
  return (
    !!a &&
    sameRevisionDisclosureTarget(a, b) &&
    a.licence === b.licence &&
    a.creatorAccountId === b.creatorAccountId &&
    sameRevisionDisclosureIncarnation(a.incarnation, b.incarnation)
  );
}

export function targetOf(row: RevisionDisclosureRow): RevisionDisclosureTarget {
  return {
    threadId: row.thread_id,
    postId: row.post_id,
    revisionId: row.revision_id,
    sha256: row.sha256,
  };
}

export function catalogueOf(row: RevisionDisclosureRow): RevisionDisclosureCatalogue {
  return { catalogueId: row.catalogue_id, catalogueRoute: row.catalogue_route };
}

export function incarnationOf(row: RevisionDisclosureRow): RevisionDisclosureIncarnation {
  return {
    postTransactionId: row.source_post_transaction_id,
    threadTransactionId: row.source_thread_transaction_id,
    postSecurityRevision: row.source_post_security_revision,
    threadSecurityRevision: row.source_thread_security_revision,
  };
}

export function sourceOf(row: RevisionDisclosureRow): RevisionDisclosureSource {
  return {
    ...targetOf(row),
    licence: row.licence,
    creatorAccountId: row.issuer_account_id,
    incarnation: incarnationOf(row),
  };
}

export function observationOf(row: RevisionDisclosureRow): RevisionDisclosureObservation {
  return {
    disclosureId: row.disclosure_id,
    state: revisionDisclosureState(row),
    catalogue: catalogueOf(row),
    target: targetOf(row),
    licence: row.licence,
    incarnation: incarnationOf(row),
    issuerAccountId: row.issuer_account_id,
    issuedAt: row.issued_at,
    audienceKind: REVISION_DISCLOSURE_AUDIENCE,
    policyVersion: REVISION_DISCLOSURE_POLICY_VERSION,
    revokedAt: row.revoked_at,
  };
}

export function sameRevisionDisclosureRow(
  a: RevisionDisclosureRow | null | undefined,
  b: RevisionDisclosureRow,
): a is RevisionDisclosureRow {
  return (
    !!a &&
    a.disclosure_id === b.disclosure_id &&
    a.route === b.route &&
    a.operation_id === b.operation_id &&
    a.issuer_account_id === b.issuer_account_id &&
    a.issued_transaction_id === b.issued_transaction_id &&
    a.revoked_at === b.revoked_at &&
    a.revocation_transaction_id === b.revocation_transaction_id &&
    sameRevisionDisclosureSource(sourceOf(a), sourceOf(b)) &&
    a.catalogue_id === b.catalogue_id &&
    a.catalogue_route === b.catalogue_route &&
    a.source_digest === b.source_digest
  );
}

export function routedRevisionDisclosureId(id: string, expected?: number): number | null {
  const route = routeOf(id);
  if (route === null || !isRevisionDisclosureUuid(id)) return null;
  if (expected !== undefined && route !== expected) return null;
  return route;
}

export function revisionDisclosureSourceHome(target: RevisionDisclosureTarget): number | null {
  const route = routedRevisionDisclosureId(target.postId);
  if (
    route === null ||
    routedRevisionDisclosureId(target.threadId, route) === null ||
    routedRevisionDisclosureId(target.revisionId, route) === null ||
    !isRevisionDisclosureDigest(target.sha256)
  )
    return null;
  return route;
}

export function revisionDisclosureCatalogueHome(catalogueId: string): number | null {
  return routedRevisionDisclosureId(catalogueId);
}

type RevisionDisclosureSqlRow = {
  [K in keyof RevisionDisclosureRow]: K extends 'actor_scopes' ? readonly (string | null)[] : RevisionDisclosureRow[K];
};

/** Compiled SQL types `text[]` as `(string | null)[]`; stored scopes match AccountActor. */
export function revisionDisclosureFromSql(
  row: RevisionDisclosureSqlRow | null | undefined,
): RevisionDisclosureRow | null {
  if (!row) return null;
  const actor_scopes = row.actor_scopes;
  if (!actor_scopes.every((scope): scope is string => scope !== null)) return null;
  const {
    route,
    disclosure_id,
    operation_id,
    thread_id,
    post_id,
    revision_id,
    sha256,
    licence,
    catalogue_id,
    catalogue_route,
    source_post_transaction_id,
    source_thread_transaction_id,
    source_post_security_revision,
    source_thread_security_revision,
    issuer_account_id,
    issued_transaction_id,
    issued_at,
    audience_kind,
    policy_version,
    actor_client_id,
    actor_requested_by,
    actor_authn_epoch,
    original_minimum_authn_epoch,
    original_operator_account_id,
    original_delegation_transaction_id,
    original_delegation_issued_valid,
    source_digest,
    creation_idempotency_key,
    creation_request_digest,
    revoked_at,
    revocation_transaction_id,
    revoker_account_id,
  } = row;
  return {
    route,
    disclosure_id,
    operation_id,
    thread_id,
    post_id,
    revision_id,
    sha256,
    licence,
    catalogue_id,
    catalogue_route,
    source_post_transaction_id,
    source_thread_transaction_id,
    source_post_security_revision,
    source_thread_security_revision,
    issuer_account_id,
    issued_transaction_id,
    issued_at,
    audience_kind,
    policy_version,
    actor_client_id,
    actor_scopes,
    actor_requested_by,
    actor_authn_epoch,
    original_minimum_authn_epoch,
    original_operator_account_id,
    original_delegation_transaction_id,
    original_delegation_issued_valid,
    source_digest,
    creation_idempotency_key,
    creation_request_digest,
    revoked_at,
    revocation_transaction_id,
    revoker_account_id,
  };
}

export async function revisionDisclosureRow(
  client: AccessClient,
  disclosureId: string,
): Promise<RevisionDisclosureRow | null> {
  const route = routedRevisionDisclosureId(disclosureId);
  if (route === null) return null;
  return revisionDisclosureFromSql(await readDisclosure.run(client, { route, disclosure_id: disclosureId }));
}

export async function lockRevisionDisclosureRow(
  client: AccessClient,
  disclosureId: string,
): Promise<RevisionDisclosureRow | null> {
  const route = routedRevisionDisclosureId(disclosureId);
  if (route === null) return null;
  return revisionDisclosureFromSql(await lockDisclosure.run(client, { route, disclosure_id: disclosureId }));
}

export async function lookupIssuedRevisionDisclosure(
  client: AccessClient,
  catalogueId: string,
  target: RevisionDisclosureTarget,
): Promise<RevisionDisclosureRow | null> {
  const route = revisionDisclosureSourceHome(target);
  const catalogueRoute = revisionDisclosureCatalogueHome(catalogueId);
  if (route === null || catalogueRoute === null) return null;
  return revisionDisclosureFromSql(
    await lookupDisclosure.run(client, {
      route,
      catalogue_id: catalogueId,
      thread_id: target.threadId,
      post_id: target.postId,
      revision_id: target.revisionId,
      sha256: target.sha256,
    }),
  );
}

export function revisionDisclosurePartition(route: number): number {
  return partitionOf(route);
}
