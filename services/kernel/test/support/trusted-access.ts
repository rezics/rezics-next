import type { PasskeyTrustedAccessPorts, TrustedAccessPorts } from '@rezics/auth-contract';
import { createAuthBindings, type AuthBindingCapabilities } from '../../src/access/auth-bindings.ts';
import type { Access } from '../../src/request/access.ts';
import type { Pool } from 'pg';

type PlainPorts = Exclude<TrustedAccessPorts, PasskeyTrustedAccessPorts>;

/** The members a stub supplies itself. Every other required member of the trusted Access port is filled by the
 * factory, so a newly required port is added in `trustedAccessPorts` and nowhere else. */
export type StubAccessPorts = Pick<PlainPorts, 'readAccount' | 'authorizeProvisioning'> &
  Partial<Omit<PlainPorts, 'readFencedAccount'>> &
  Partial<Pick<PlainPorts, 'readFencedAccount'>>;

type BindingSource = { pool: Pool; access?: Access } & AuthBindingCapabilities;

/** Trusted Access ports for a test. With a pool, the real Access binding, bound to the test's Access when it has one.
 * Without a pool, a stub: the required members the test does not give come from its own fixture account, read
 * through the stub's `readAccount`. */
export function trustedAccessPorts(source: BindingSource): PasskeyTrustedAccessPorts;
export function trustedAccessPorts(stub: StubAccessPorts): PlainPorts;
export function trustedAccessPorts(source: BindingSource | StubAccessPorts): PasskeyTrustedAccessPorts | PlainPorts {
  if ('pool' in source) return createAuthBindings(source);
  return { confirmBarrier: async () => true, readFencedAccount: (id) => source.readAccount(id), ...source };
}
