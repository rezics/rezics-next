import { notifyCommand } from '../notify.ts';

export const usage = 'Usage: goalctl flush';

export default async function flush(args: string[]): Promise<number> {
  try {
    for (const line of await notifyCommand(['flush', ...args])) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error && error.name === 'NotifyError' ? error.message : 'Telegram notification command failed');
    return 1;
  }
}
