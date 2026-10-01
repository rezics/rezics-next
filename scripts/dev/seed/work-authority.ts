import { workKinds } from '../../../services/main/src/modules/work/work-kinds.ts';

/** Follow the served registry when a type's creation class changes. */
export function requiresSeedAdministrator(types: readonly string[]): boolean {
  return types.some((type) => workKinds[type]?.creation === 'administrator');
}
