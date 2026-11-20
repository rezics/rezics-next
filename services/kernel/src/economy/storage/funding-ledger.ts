import type { EconomyResult } from '../contract.ts';
import { createEconomyLedger, type NativeFundingPosting } from '../ledger.ts';
import type { FundingIntent } from '../settlement/funding.ts';
import { readMinorUnits } from '../settlement/posting.ts';
import type { FundingLedgerBinder } from './funding-store.ts';

type FundingApplication = Parameters<FundingLedgerBinder['apply']>[1];
type Hold = Parameters<FundingLedgerBinder['reserve']>[1];

function checked<T>(result: EconomyResult<T>, operation: string): T {
  if (result.kind !== 'ok') throw new Error(`Native Economy funding ${operation} failed: ${result.kind}`);
  return result.value;
}

function checkedHold(intent: FundingIntent, hold: Hold): void {
  if (
    intent.direction !== 'withdrawal' ||
    hold.bookId !== intent.bookId ||
    hold.walletId !== intent.walletId ||
    hold.assetId !== intent.assetId ||
    hold.units !== intent.units ||
    hold.holdId !== `funding/${intent.bookId}/${intent.intentId}`
  )
    throw new Error('Economy funding effect has a different protected hold');
}

function posting({ intent, receipt, effect }: FundingApplication): NativeFundingPosting {
  const base = { accountId: intent.walletId, assetId: intent.assetId, proof: receipt.key };
  if (receipt.key.namespace !== intent.provider.namespace || receipt.key.mode !== intent.provider.mode)
    throw new Error('Economy funding evidence uses a different provider binding');
  if (effect.kind === 'release_hold') {
    checkedHold(intent, effect.reservation);
    return { ...base, kind: 'withdrawal_refusal', units: intent.units, holdId: effect.reservation.holdId };
  }

  const { assetId, postings } = effect.group;
  if (assetId !== intent.assetId || postings.length < 2 || postings.length > 3)
    throw new Error('Economy funding posting has a different asset or size');
  const clearingRef = `${intent.provider.mode}/${intent.provider.namespace}`;
  const deltas = new Map<string, bigint>();
  for (const leg of postings) {
    const { role, id } = leg.account;
    const amount = readMinorUnits(leg.units);
    if (
      (role !== 'wallet' && role !== 'provider_clearing' && role !== 'chargeback_receivable') ||
      id !== (role === 'provider_clearing' ? clearingRef : intent.walletId) ||
      deltas.has(role) ||
      amount === null ||
      amount === 0n ||
      (leg.side !== 'credit' && leg.side !== 'debit')
    )
      throw new Error('Economy funding posting uses an unexpected role or amount');
    deltas.set(role, leg.side === 'credit' ? amount : -amount);
  }
  const wallet = deltas.get('wallet') ?? 0n;
  const clearing = deltas.get('provider_clearing') ?? 0n;
  const receivable = deltas.get('chargeback_receivable') ?? 0n;
  if (wallet + clearing + receivable !== 0n || clearing === 0n)
    throw new Error('Economy funding posting does not balance');
  if (effect.capture) {
    checkedHold(intent, effect.capture);
    if (wallet !== -BigInt(intent.units) || receivable !== 0n || effect.chargebackShortfall !== undefined)
      throw new Error('Economy withdrawal posting does not match its held amount');
    return { ...base, kind: 'withdrawal', units: intent.units, holdId: effect.capture.holdId };
  }
  if (intent.direction === 'deposit' && clearing > 0n && wallet <= 0n && receivable <= 0n) {
    if (effect.chargebackShortfall !== (receivable === 0n ? undefined : String(-receivable)))
      throw new Error('Economy chargeback shortfall does not match its posting');
    return { ...base, kind: 'chargeback', units: String(clearing), recoverableUnits: String(-wallet) };
  }
  if (wallet <= 0n || receivable !== 0n || effect.chargebackShortfall !== undefined)
    throw new Error('Economy funding receipt cannot credit this wallet');
  return { ...base, kind: intent.direction === 'deposit' ? 'deposit' : 'withdrawal_return', units: String(wallet) };
}

/** Bound to the funding store's transaction. The protected allocation outlives ordinary hold expiry. */
export function createFundingLedgerBinder(bookId: string): FundingLedgerBinder {
  const ledger = (tx: Parameters<FundingLedgerBinder['reserve']>[0]) =>
    createEconomyLedger({ transaction: (work) => work(tx), read: (work) => work(tx) }, bookId);
  return {
    async reserve(tx, reservation) {
      if (reservation.bookId !== bookId) throw new Error('Economy funding reserve belongs to a different book');
      const { rows } = await tx.query<{ expiry: Date }>(`SELECT clock_timestamp() + interval '1 minute' AS expiry`);
      const native = ledger(tx);
      const money = { accountId: reservation.walletId, assetId: reservation.assetId, amount: reservation.units };
      const hold = { ...money, holdId: reservation.holdId };
      checked(
        await native.reserve({
          ...hold,
          operationId: `reserve/${reservation.holdId}`,
          expiresAt: rows[0]!.expiry.toISOString(),
        }),
        'reserve',
      );
      checked(
        await native.allocate({
          ...hold,
          operationId: `allocate/${reservation.holdId}`,
          purpose: 'withdrawal',
          reference: reservation.holdId,
        }),
        'protect',
      );
      return { ...reservation, protected: true };
    },
    async recoverableWalletUnits(tx, intent) {
      if (intent.bookId !== bookId) throw new Error('Economy chargeback belongs to a different book');
      return checked(
        await ledger(tx).lockRecoverableFundingWallet({
          accountId: intent.walletId,
          assetId: intent.assetId,
          provider: intent.provider,
        }),
        'lock recoverable wallet',
      );
    },
    async apply(tx, application) {
      if (application.intent.bookId !== bookId) throw new Error('Economy funding effect belongs to a different book');
      checked(await ledger(tx).postFunding(posting(application)), 'post evidence');
    },
  };
}
