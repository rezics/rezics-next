import type { AuthoritativeTime, CommandAuthorization } from '../command/command.ts';
import type { Access, AccessClient, AccessContext, Actor, Resource } from '../request/access.ts';

/** Trusted server binding to the authorization resource. validate checks THAT
 * anchor's existence and domain prerequisites at command T on its supplied client;
 * it is never a request-supplied callback or an authorization formula.
 */
export type AuthorizationAnchor = Readonly<{
  resource: Readonly<Resource>;
  validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
}>;

export type ResourceAuthorizationContext = AccessContext & {
  /** Actual target command partition, independent of the authority anchor's partition. */
  partition: number;
};

export type ResourceAuthorizationInput = {
  access: Access;
  actor: Actor;
  action: string;
  anchor: AuthorizationAnchor;
  context: ResourceAuthorizationContext;
};

export class ResourceAuthorizationUnavailableError extends Error {
  constructor() {
    super('Resource authorization is unavailable');
    this.name = 'ResourceAuthorizationUnavailableError';
  }
}

/** Action-general authorization seam; the authority is input.anchor.resource.
 * Stable tuple/upsert targets need only their actual partition, with no new UUID,
 * unique INSERT or ResourceCreationPort. This never mints creationCapability or
 * grants initialization rights; parentCreationAuthorization retains that distinct
 * unique-resource creation proof and its strict owner-role initialization checks.
 *
 * The eventual implementation must bind identity/client/delegator, action, anchor,
 * target partition, attempt and deadline. At each attempt T it must validate the
 * anchor and use the SAME Access formula on an independently checked-out authority
 * resource connection, releasing it before target checkout. Denied replay must
 * disclose neither receipt nor body. No content-local policy belongs here.
 *
 * Platform gates use the existing Global Context anchor supplied by consumers:
 * { route: 0, id: '00000000-0000-8000-8000-000000000000' }. Consumers supply their
 * exact action (including subject:create, subject:batch_write, media:importFromUrl,
 * source_fence:read and takedown). This helper creates or seeds no other root.
 * New media placement follows its subject, without per-subject grants or new roles.
 *
 * This unavailable stub always throws synchronously: O(1), zero partitions, SQL
 * or callbacks, and no execute/receipt-only proof. Intended evaluation uses bounded
 * actor memberships K <= 1000 per identity, one authority resource probe at T and
 * matched-group anchored reads O((1 + K) log G + matches), with no ACL enumeration
 * or target query in the authority check. That implementation is a separate change.
 */
export function resourceAuthorization(_input: ResourceAuthorizationInput): CommandAuthorization {
  throw new ResourceAuthorizationUnavailableError();
}
