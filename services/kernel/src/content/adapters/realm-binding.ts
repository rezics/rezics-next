import type { NativeContentRealmApplication } from './realm.ts';

let bound: NativeContentRealmApplication | undefined;
/** Uses the same process lifetime as the existing Content application binding. */
export function bindContentRealmApplication(application: NativeContentRealmApplication): void {
  bound = application;
}
export function contentRealmApplication(): NativeContentRealmApplication {
  if (!bound) throw new Error('Content Realm application is not bound');
  return bound;
}
export function unbindContentRealmApplication(): void {
  bound = undefined;
}
