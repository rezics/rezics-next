import { notifyCommand } from '../notify.ts';

export const usage = 'Usage: goalctl tell --event <start|pause|stop|fault|allowance|host> --goal <slug> [--task <id>] [--note <text>]';

export default async function tell(args: string[]): Promise<number> {
  try {
    for (const line of await notifyCommand(['tell', ...args])) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error && error.name === 'NotifyError' ? error.message : 'Telegram notification command failed');
    return 1;
  }
}
