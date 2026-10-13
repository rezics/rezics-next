import { notifyCommand } from '../notify.ts';

export const usage = 'Usage: goalctl ask --goal <slug> --question <text> --option <letter>=<text> --option <letter>=<text> --recommend <letter> [--task <id>] [--default <letter> --default-at <timestamp>]';

export default async function ask(args: string[]): Promise<number> {
  try {
    for (const line of await notifyCommand(['ask', ...args])) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error && error.name === 'NotifyError' ? error.message : 'Telegram notification command failed');
    return 1;
  }
}
