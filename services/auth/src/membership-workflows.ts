import type {
  MembershipWorkInput,
  MembershipWorkReservation,
  MembershipWorkResult,
  MembershipWorkflowPorts,
} from '@rezics/auth-contract';
export type {
  MembershipPrincipal,
  MembershipWorkInput,
  MembershipWorkReservation,
  MembershipWorkResult,
  MembershipWorkflowPorts,
} from '@rezics/auth-contract';
import { DBOS } from '@dbos-inc/dbos-sdk';

/** Shared ordering for the Auth host and the kernel registrar. Every callback
 * is a registered durable step; this function performs no external I/O. */
export async function coordinateMembership<Reservation>(input: {
  leaving: boolean;
  reserve(): Promise<Reservation>;
  publish(reservation: Reservation): Promise<void>;
  release(reservation: Reservation): Promise<void>;
  compensate?(reservation: Reservation): Promise<void>;
}): Promise<Reservation> {
  const reservation = await input.reserve();
  try {
    await input.publish(reservation);
  } catch (error) {
    // The terminal barrier must commit before inverse cleanup. If publication
    // won the race, terminalization fails and the extra inverse is retained.
    if (!input.leaving && input.compensate) await input.compensate(reservation);
    throw error;
  }
  if (input.leaving) await input.release(reservation);
  return reservation;
}

/** Transport validation only; authority belongs exclusively to the native resolver.
 * One optional dot admits sealed locators while excluding three-part JWTs. */
export function isMembershipAuthorizationReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9][A-Za-z0-9:_/-]*(?:\.[A-Za-z0-9_-]+)?$/.test(value)
  );
}

export const MEMBERSHIP_WORKFLOW_NAME = 'accounts.membership';
/** Pure registration: uses the caller's configured SDK, never launches it,
 * creates a pool, accesses credentials, or installs queues/schedules. */
export function registerMembershipWorkflows<Context>(ports: MembershipWorkflowPorts<Context>) {
  const key = (phase: string) => `wf:${DBOS.workflowID!}:${phase}`;
  async function authorized(input: MembershipWorkInput) {
    if (!isMembershipAuthorizationReference(input.authorization)) throw new Error('Membership authorization denied');
    return ports.authorize(input.authorization, input);
  }
  const step = <A extends unknown[], R>(name: string, action: (...args: A) => Promise<R>) =>
    DBOS.registerStep(
      async (...args: A) => {
        try {
          return await action(...args);
        } catch (error) {
          console.error(
            new Error(`Membership workflow step failed: ${name} (workflow ${DBOS.workflowID})`, { cause: error }),
          );
          throw new Error(`Membership workflow step failed: ${name}`);
        }
      },
      { name: `accounts.membership.${name}`, retriesAllowed: false },
    );
  const reserve = step('reserve', async (input: MembershipWorkInput) => {
    const context = await authorized(input);
    const accountId = input.kind === 'organization' ? ports.actorAccountId(context) : input.memberAccountId;
    const principal =
      input.kind === 'organization' ? { kind: 'organization' as const, id: input.organizationId } : input.principal;
    if (input.kind === 'membership' && input.role === null && !input.reservationId)
      throw new Error('Missing reservation');
    if (input.kind === 'membership' && input.reservationId)
      return { accountId, principal, reservationId: input.reservationId };
    try {
      return (await ports.reserve({ accountId, principal, key: key('reserve') })).value;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'membership_limit')
        return { status: 'membership_limit' as const, code: 'membership_limit' as const };
      throw error;
    }
  });
  const publish = step('publish', async (input: MembershipWorkInput, reservation: MembershipWorkReservation) => {
    await ports.publish(await authorized(input), input, reservation, key('publish'));
  });
  // Cleanup carries only the exact native reservation. Its terminal proof,
  // rather than membership rights that publication may remove, permits release.
  const terminalize = step('terminalize', async (reservation: MembershipWorkReservation) => {
    await ports.terminalize(reservation, key('terminalize'));
  });
  const release = step('release', async (reservation: MembershipWorkReservation) => {
    await ports.release({ ...reservation, key: key('release') });
  });
  return DBOS.registerWorkflow(
    async (input: MembershipWorkInput): Promise<MembershipWorkResult> => {
      const reservation = await reserve(input);
      if ('status' in reservation) return reservation;
      await coordinateMembership({
        leaving: input.kind === 'membership' && input.role === null,
        reserve: async () => reservation,
        publish: (held) => publish(input, held),
        release,
        compensate: async (held) => {
          await terminalize(held);
          await release(held);
        },
      });
      return {
        status: 'completed',
        accountId: input.kind === 'organization' ? input.organizationId : input.memberAccountId,
        reservationId: reservation.reservationId,
      };
    },
    { name: MEMBERSHIP_WORKFLOW_NAME },
  );
}
