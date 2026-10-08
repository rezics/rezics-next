const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hiddenKey = /^(actingSubject|acting_subject|decider|deciderId|moderator|moderatorId|principalId|principal_id)$/i;

/** One ban receipt, as the member may see it. The decider is never part of this shape. */
export interface BanReading {
  realm: string;
  receiptId: string;
  action: 'ban';
  reason: string;
  bannedUntil: string | null;
  permanent: boolean;
  happenedAt: string;
  appeal: { state: 'none' }
    | { state: 'open'; caseId: string; statement: string }
    | {
      state: 'decided';
      caseId: string;
      statement: string;
      outcome: 'dismiss' | 'restore';
      rationale: string | null;
      /** When the resolution was recorded. Absent until the appeal read carries it. */
      decidedAt: string | null;
    };
  /**
   * A reversed appeal lifts the ban in the same operation. Both are null unless
   * the outcome is restore. The lifting receipt is not shown to the member.
   */
  liftedAt: string | null;
  liftingReceiptId: string | null;
}

function stripIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIdentity);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !hiddenKey.test(key))
    .map(([key, item]) => [key, stripIdentity(item)]));
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length >= 1 && value.length <= max ? value : null;
}

function whenOf(value: unknown): string | null {
  return bounded(value, 64);
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && uuid.test(value) ? value : null;
}

function appealOf(value: unknown): BanReading['appeal'] | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.state === 'none') return { state: 'none' };
  const caseId = typeof item.caseId === 'string' && uuid.test(item.caseId) ? item.caseId : null;
  const statement = bounded(item.statement, 2000);
  if (!caseId || !statement) return null;
  if (item.state === 'open') return { state: 'open', caseId, statement };
  if (item.state !== 'decided' || (item.outcome !== 'dismiss' && item.outcome !== 'restore')) return null;
  const rationale = typeof item.rationale === 'string' && item.rationale.length > 0
    ? item.rationale.slice(0, 8000) : null;
  const decidedAt = whenOf(item.decidedAt);
  return { state: 'decided', caseId, statement, outcome: item.outcome, rationale, decidedAt };
}

/**
 * A member-ban response. 404 is the same for no ban, an expired ban, and every
 * other caller, so none of those render. Any other failure stays quiet too.
 */
export function readingFromBanResponse(status: number, body: unknown): BanReading | null {
  if (status !== 200) return null;
  return parseBanReading(body);
}

/** Keep a ban reading and drop any decider identity a caller attached beside it. */
export function parseBanReading(value: unknown): BanReading | null {
  const source = stripIdentity(value);
  if (!source || typeof source !== 'object') return null;
  const item = source as Record<string, unknown>;
  const receiptId = typeof item.receiptId === 'string' && uuid.test(item.receiptId) ? item.receiptId : null;
  const reason = bounded(item.reason, 8000);
  const happenedAt = bounded(item.happenedAt, 64);
  const appeal = appealOf(item.appeal);
  if (item.action !== 'ban' || typeof item.realm !== 'string' || !receiptId || !reason || !happenedAt || !appeal)
    return null;
  const appealRecord = item.appeal && typeof item.appeal === 'object' ? item.appeal as Record<string, unknown> : {};
  const lifted = appeal.state === 'decided' && appeal.outcome === 'restore';
  const bannedUntil = item.bannedUntil === null || typeof item.bannedUntil === 'string' ? item.bannedUntil : null;
  return {
    realm: item.realm, receiptId, action: 'ban', reason, happenedAt, appeal,
    bannedUntil: typeof bannedUntil === 'string' ? bannedUntil : null,
    permanent: item.permanent === true || bannedUntil === null,
    liftedAt: lifted ? whenOf(item.liftedAt) ?? whenOf(appealRecord.liftedAt) : null,
    liftingReceiptId: lifted ? idOf(item.liftingReceiptId) ?? idOf(appealRecord.liftingReceiptId) : null,
  };
}

/** Strings the member is shown. Receipt and case ids, including the lifting receipt, stay off the page. */
export function memberFacingText(reading: BanReading): string[] {
  const parts = [reading.reason, reading.happenedAt];
  if (reading.bannedUntil) parts.push(reading.bannedUntil);
  if (reading.liftedAt) parts.push(reading.liftedAt);
  if (reading.appeal.state !== 'none') parts.push(reading.appeal.statement);
  if (reading.appeal.state === 'decided') {
    if (reading.appeal.rationale) parts.push(reading.appeal.rationale);
    if (reading.appeal.decidedAt) parts.push(reading.appeal.decidedAt);
  }
  return parts;
}
