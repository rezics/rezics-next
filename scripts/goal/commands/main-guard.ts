import { installMainGuard, mainGuardStatus, removeMainGuard } from '../main-guard.ts';

export const usage = 'Usage: goalctl main-guard install|status|remove';

export default function mainGuard(args: string[]): number {
  const [action] = args;
  if (args.length !== 1 || !['install', 'status', 'remove'].includes(action ?? '')) {
    console.error(usage);
    return 2;
  }
  const status = action === 'install' ? installMainGuard()
    : action === 'remove' ? removeMainGuard() : mainGuardStatus();
  console.log(`main-guard ${status.state}: ${status.hook}`
    + (status.previousHook ? `; existing hook preserved at ${status.previousHook} and run alongside the guard` : '')
    + (status.reason ? `; ${status.reason}` : ''));
  return status.state === 'modified' || status.state === 'inactive' ? 1 : 0;
}
