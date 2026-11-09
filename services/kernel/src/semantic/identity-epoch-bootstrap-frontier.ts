/** A closed topology still has work when a bootstrap home or dirty source needs repair. */
export async function bootstrapFrontierHasPendingWork(
  remaining: number,
  readRepairHome: () => Promise<number | null>,
): Promise<boolean> {
  if (remaining !== 0) return true;
  return (await readRepairHome()) !== null;
}
