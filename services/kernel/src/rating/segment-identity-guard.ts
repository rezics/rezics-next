import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { createHash } from 'node:crypto';
import type { IdentityRepairPage } from './identity-work-frame.ts';

export type RatingIdentityMapping = Readonly<{ originalId: string; terminalId: string; epoch: string }>;
export type RatingIdentityAuthority =
  | Readonly<{ status: 'pending'; reason: string }>
  | Readonly<{ status: 'current'; obligationId: string; mappings: readonly RatingIdentityMapping[] }>;

/** Trusted producer composition only. Released Pool observations cannot implement this port.
 * hold must protect the exact original-to-visible-terminal mappings against change until this
 * voter transaction commits, and retain a repair obligation for later identity changes.
 * complete must bind that obligation to the native Rating receipt in the SAME transaction;
 * false rolls back vote effects, receipt and checkpoint. Neither method supplies authorization.
 */
export type RatingIdentityProducer = Readonly<{
  hold(tx: CommandTransaction, page: Readonly<IdentityRepairPage>): Promise<RatingIdentityAuthority>;
  complete(tx: CommandTransaction, input: Readonly<{
    page: Readonly<IdentityRepairPage>; obligationId: string; mappingDigest: string; transactionId: string;
  }>): Promise<boolean>;
}>;

export const unavailableRatingIdentityProducer: RatingIdentityProducer = {
  async hold() { return { status: 'pending', reason: 'semantic-exact-currentness-and-held-repair-obligation-unavailable' }; },
  async complete() { return false; },
};

export function validIdentityAuthority(page: IdentityRepairPage, authority: Extract<RatingIdentityAuthority, { status: 'current' }>): boolean {
  const originals = new Set(page.votes.map((vote) => vote.targetId));
  const seen = new Set<string>();
  if (!authority.obligationId || authority.obligationId.length > 255 || authority.mappings.length < originals.size || authority.mappings.length > 128)
    return false;
  for (const mapping of authority.mappings) {
    if (routeOf(mapping.originalId) === null || seen.has(mapping.originalId) || routeOf(mapping.terminalId) === null ||
      !/^(0|[1-9][0-9]{0,18})$/.test(mapping.epoch)) return false;
    seen.add(mapping.originalId);
  }
  return [...originals].every((id) => seen.has(id));
}

export function identityMappingDigest(mappings: readonly RatingIdentityMapping[]): string {
  return createHash('sha256').update(JSON.stringify([...mappings].sort((a, b) =>
    a.originalId.localeCompare(b.originalId)).map((mapping) =>
    [mapping.originalId, mapping.terminalId, mapping.epoch]))).digest('hex');
}

export class RatingIdentityVotePending extends Error {
  constructor(readonly reason: string) { super(reason); }
}
