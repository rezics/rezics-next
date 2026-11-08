import type { IdentityAdapterPort, NativeIdentityCapabilities } from './identity-adapter-port.ts';
/** Real native read/command/slot/review bodies. Composition installs them once. */
export declare function createNativeIdentityCapabilities(): NativeIdentityCapabilities;
/** One constructed Identity application. Its store, readers, admission, reviewed Person and Rating participant
 * close over this capability set, including nested, deferred and resume/replay paths. */
export declare function createIdentityAdapterApplication(capabilities: NativeIdentityCapabilities): IdentityAdapterPort;
/** Bind native capabilities and the constructed identity adapter port. */
export declare function installIdentityAdapterRuntime(capabilities?: NativeIdentityCapabilities): IdentityAdapterPort;
/** Ordinary Access/Semantic composition shares one default constructed instance. */
export declare function resolveIdentityAdapterRuntime(): IdentityAdapterPort;
export declare function identityAdapterRuntime(): IdentityAdapterPort;
export type { IdentityAdapterPort, NativeIdentityCapabilities };
