/** Preparation remains bounded separately from harness shutdown and reader cleanup. */
export const SEED_RESTORE_PREPARATION_MS = 600_000;
export const SEED_RESTORE_RUN_CEILING_MS = SEED_RESTORE_PREPARATION_MS + 120_000;

/** Every selection proves a writable copy cannot mutate a later restore. */
export function seedVerificationPlan(selection = 'all') {
  if (selection !== 'all' && !['small', 'medium', 'large'].includes(selection))
    throw new Error('REZICS_SEED_VERIFY_CUT must be small, medium, large or all');
  const scales = selection === 'all' ? ['small', 'small', 'medium', 'large'] as const
    : [selection, selection] as readonly string[];
  return { scales, restoreCount: scales.length,
    budgetMs: scales.length * SEED_RESTORE_RUN_CEILING_MS };
}
