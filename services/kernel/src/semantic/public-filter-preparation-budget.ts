// Per home: 15 Access enrollment keys, 3 original receipt verification
// keys, 9 receiver adoption keys and 7 Source cursor keys. Each compiler
// key has its enrollment edge and FK. Reserve misses and retention checks.
const homeInputs = 34;
const pageInputs = 5; // registration owner/row, preparation row, final Source reread
const maxKeysPerHome = 450;
export const maxPublicFilterEnrollmentHomes = Math.floor((1000 - pageInputs) / homeInputs);

export function planPublicFilterEnrollment(
  input: Readonly<{
    inputBudget: number;
    keyCount: number;
    homesLeft: number;
  }>,
): Readonly<{ homes: number; keyLimit: number }> {
  const available = input.inputBudget - pageInputs;
  const keyLimit = Math.min(maxKeysPerHome, Math.floor((available - homeInputs) / 2));
  if (input.homesLeft <= 0 || available < homeInputs || (keyLimit < 1 && input.keyCount > 0))
    return { homes: 0, keyLimit: 0 };
  const fullHomeInputs = homeInputs + 2 * input.keyCount;
  return {
    homes: Math.min(input.homesLeft, Math.max(1, Math.floor(available / fullHomeInputs))),
    keyLimit: Math.max(1, Math.min(keyLimit, input.keyCount)),
  };
}
