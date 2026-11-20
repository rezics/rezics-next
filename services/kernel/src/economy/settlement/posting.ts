const maxMinorUnits = 9_223_372_036_854_775_807n;

export function readMinorUnits(value: string): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= maxMinorUnits ? amount : null;
}

export type PostingAccount = Readonly<{
  role: 'wallet' | 'provider_clearing' | 'chargeback_receivable' | 'creator_expense' | 'creator_payable';
  id: string;
}>;

type Posting = Readonly<{ account: PostingAccount; side: 'debit' | 'credit'; units: string }>;

export type PostingGroup = Readonly<{
  assetId: string;
  postings: readonly Posting[];
}>;

export function balancedPair(
  assetId: string,
  units: string,
  debit: PostingAccount,
  credit: PostingAccount,
): PostingGroup {
  return {
    assetId,
    postings: [
      { account: debit, side: 'debit', units },
      { account: credit, side: 'credit', units },
    ],
  };
}

export function chargebackPosting(
  input: Readonly<{
    assetId: string;
    walletId: string;
    clearingId: string;
    units: bigint;
    recoverable: bigint;
  }>,
): Readonly<{ group: PostingGroup; shortfall: string }> {
  const recovered = input.recoverable < input.units ? input.recoverable : input.units;
  const shortfall = input.units - recovered;
  const postings: Posting[] = [];
  if (recovered > 0n) {
    postings.push({ account: { role: 'wallet', id: input.walletId }, side: 'debit', units: String(recovered) });
  }
  if (shortfall > 0n) {
    postings.push({
      account: { role: 'chargeback_receivable', id: input.walletId },
      side: 'debit',
      units: String(shortfall),
    });
  }
  postings.push({
    account: { role: 'provider_clearing', id: input.clearingId },
    side: 'credit',
    units: String(input.units),
  });
  return { group: { assetId: input.assetId, postings }, shortfall: String(shortfall) };
}

type CreatorPosting = Readonly<{ assetId: string; creatorId: string; units: string }> &
  (
    | Readonly<{ kind: 'accrual'; expenseAccountId: string }>
    | Readonly<{ kind: 'payout' | 'payout_return'; clearingAccountId: string }>
  );

/** The owner admits accrual and payout evidence under independent economic identities before posting. */
export function planCreatorPosting(input: CreatorPosting): PostingGroup | null {
  const units = readMinorUnits(input.units);
  if (units === null || units === 0n) return null;
  const payable: PostingAccount = { role: 'creator_payable', id: input.creatorId };
  if (input.kind === 'accrual') {
    return balancedPair(input.assetId, input.units, { role: 'creator_expense', id: input.expenseAccountId }, payable);
  }
  const clearing: PostingAccount = { role: 'provider_clearing', id: input.clearingAccountId };
  return input.kind === 'payout'
    ? balancedPair(input.assetId, input.units, payable, clearing)
    : balancedPair(input.assetId, input.units, clearing, payable);
}
