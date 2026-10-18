import { allowanceCommand } from '../allowance.ts';

export const usage = 'Usage: goalctl allowance <account> [--continue]';

export default function allowance(args: string[]): Promise<number> {
  return allowanceCommand(args);
}
