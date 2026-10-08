/** The owner tier's own limit. Absent, the historical 600s ceiling stands. */
export function ownerTierBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REZICS_QA_OWNER_BUDGET_MS;
  if (raw === undefined || raw === '') return 600_000;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('REZICS_QA_OWNER_BUDGET_MS must be a positive integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error('REZICS_QA_OWNER_BUDGET_MS must be a positive integer');
  return value;
}
