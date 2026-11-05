import type { PasskeyTrustedAccessPorts, TrustedAccessPorts } from '@rezics/auth-contract';

type PlainPorts = Exclude<TrustedAccessPorts, PasskeyTrustedAccessPorts>;
type StubPorts<Ports extends TrustedAccessPorts> = Pick<Ports, 'readAccount' | 'authorizeProvisioning'> &
  Partial<Ports>;
type PasskeyStub = StubPorts<PasskeyTrustedAccessPorts> &
  Pick<PasskeyTrustedAccessPorts, 'passkeys' | 'consumePasskeyAuthorization'>;

/** Required test ports live here. A stub trusts its fixture's receipts unless the test overrides confirmation;
 * real Access bindings retain their own confirmation and reads. */
export function trustedAccessPorts<Stub extends PasskeyStub>(stub: Stub): PasskeyTrustedAccessPorts & Stub;
export function trustedAccessPorts<Stub extends StubPorts<PlainPorts>>(stub: Stub): PlainPorts & Stub;
export function trustedAccessPorts<Stub extends TrustedAccessPorts>(stub: Stub): Stub;
export function trustedAccessPorts(stub: PasskeyStub | StubPorts<PlainPorts>): TrustedAccessPorts {
  const defaults = {
    confirmBarrier: async () => true,
    readFencedAccount: (id: string) => stub.readAccount(id),
  };
  return { ...defaults, ...stub };
}
