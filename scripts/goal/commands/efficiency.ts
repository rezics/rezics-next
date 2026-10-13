import { efficiencyCommand } from '../efficiency.ts';

export const usage = 'Usage: goalctl efficiency [--since <UTC time>] [--until <UTC time>] [--record] [--last] [--json]';

export default function efficiency(args: string[]): Promise<number> {
  return efficiencyCommand(args);
}
