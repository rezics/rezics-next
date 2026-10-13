import { notifyCommand } from '../notify.ts';

export const usage = 'Usage: goalctl decide <D-n> <letter> [--note <text>] [--replace]';

export default async function decide(args: string[]): Promise<number> {
  try {
    for (const line of await notifyCommand(['decide', ...args])) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error && error.name === 'NotifyError' ? error.message : 'Telegram notification command failed');
    return 1;
  }
}
