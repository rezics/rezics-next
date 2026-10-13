import { notifyCommand } from '../notify.ts';

export const usage = 'Usage: goalctl decisions [--all]';

export default async function decisions(args: string[]): Promise<number> {
  try {
    for (const line of await notifyCommand(['decisions', ...args])) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error && error.name === 'NotifyError' ? error.message : 'Telegram notification command failed');
    return 1;
  }
}
