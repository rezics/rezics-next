import type { NativeContentRealmApplication } from './realm.ts';
/** Uses the same process lifetime as the existing Content application binding. */
export declare function bindContentRealmApplication(application: NativeContentRealmApplication): void;
export declare function contentRealmApplication(): NativeContentRealmApplication;
export declare function unbindContentRealmApplication(): void;
