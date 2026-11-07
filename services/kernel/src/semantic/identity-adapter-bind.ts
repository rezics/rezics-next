import type { IdentityAdapterPort, NativeIdentityCapabilities } from './identity-adapter-port.ts';

let native: NativeIdentityCapabilities | undefined;
let port: IdentityAdapterPort | undefined;

/** Composition installs native read/command capabilities before any identity adapter runs. */
export function bindNativeIdentityCapabilities(value: NativeIdentityCapabilities): void {
  native = value;
}

export function nativeIdentityCapabilities(): NativeIdentityCapabilities {
  if (!native) throw new TypeError('Native identity capabilities are not installed');
  return native;
}

export function bindIdentityAdapterPort(value: IdentityAdapterPort): void {
  port = value;
}

export function identityAdapterPort(): IdentityAdapterPort {
  if (!port) throw new TypeError('Identity adapter runtime is not installed');
  return port;
}

export function tryIdentityAdapterPort(): IdentityAdapterPort | undefined {
  return port;
}
