import { GrantDeniedError } from '../access/contract/errors.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/contract.ts';
import type { ProgressState } from './progress.ts';
import {
  normalizeHostedBookResumeAddress,
  resolveHostedBookResumeIdentity,
  selectHostedBookResume,
  type HostedBookResumeAddress,
} from './hosted-book-resume-identity.ts';
import type {
  HostedBookResumeCheckpointPort,
  HostedBookResumeContentPort,
  HostedBookResumeLease,
  HostedBookResumeSessions,
} from './hosted-book-resume-ports.ts';

export type HostedBookResumeResult =
  | Readonly<{
      state: 'available';
      origin: 'requested' | 'checkpoint';
      address: HostedBookResumeAddress;
      session: Readonly<{
        id: string;
        revision: number;
        state: Exclude<ProgressState, 'retired'>;
      }>;
    }>
  | Readonly<{ state: 'empty' | 'not-installed' | 'unavailable' | 'changed' | 'retired' }>;

/**
 * One selected chapter under the native private session lifecycle. This adapter neither writes progress nor
 * derives chapter completion, totals or positions from work-level measures, sparse units, titles or ordinals.
 * Missing checkpoint/Content composition is explicit. Existing Library corrections and retirement stay native.
 */
export function createHostedBookResumeReads(deps: {
  sessions: HostedBookResumeSessions;
  checkpoints?: HostedBookResumeCheckpointPort;
  content?: HostedBookResumeContentPort;
}) {
  return {
    async read(actor: Actor, input: {
      sessionId: string;
      catalogueId: string;
      /** Explicit reader selection; omitted means use the exact saved chapter checkpoint. */
      selection?: unknown;
      deadline: number;
    }): Promise<HostedBookResumeResult> {
      if (actor.kind !== 'account' || !actor.scopes.includes('progress_session:read')) throw new GrantDeniedError();
      const { sessionId, catalogueId, deadline } = input;
      // Copy the caller's selection before IO; later mutation cannot replace the requested operands.
      const requested = input.selection === undefined ? undefined : normalizeHostedBookResumeAddress(input.selection);
      if (routeOf(catalogueId) === null || !Number.isFinite(deadline))
        throw new ProblemError('invalid_request');
      // Session callbacks run after the native owner snapshot is released. Native final owner/account/session
      // checks still surround all checkpoint and Content work, including empty and unavailable outcomes.
      return deps.sessions.readPresentedSession<HostedBookResumeResult>(actor, sessionId, async (session) => {
        if (session.accountId !== actor.accountId || session.id !== sessionId) throw new GrantDeniedError();
        if (session.state === 'retired') return { state: 'retired' };
        if (Date.now() >= deadline) return { state: 'unavailable' };
        const owner = { actor, session, catalogueId, deadline };
        const leases: HostedBookResumeLease[] = [];
        async function finish(result: HostedBookResumeResult): Promise<HostedBookResumeResult> {
          // Do not short-circuit: every retained producer gets its final native check.
          let invalid: 'unavailable' | 'changed' | 'retired' | null = null;
          for (const lease of leases) {
            const state = await lease.verify();
            if (state === 'retired' || (state === 'changed' && invalid !== 'retired') ||
              (state === 'unavailable' && invalid === null)) invalid = state;
          }
          if (invalid !== null) return { state: invalid };
          return Date.now() >= deadline ? { state: 'unavailable' } : result;
        }

        let checkpoint: unknown | null = null;
        if (requested === undefined) {
          if (!deps.checkpoints) return { state: 'not-installed' };
          const saved = await deps.checkpoints.read(owner);
          if (saved.state !== 'selected' && saved.state !== 'empty') return { state: saved.state };
          leases.push(saved.lease);
          if (saved.state === 'selected') {
            if (saved.accountId !== actor.accountId || saved.sessionId !== session.id)
              return finish({ state: 'changed' });
            if (saved.address === null || saved.address === undefined) return finish({ state: 'unavailable' });
            checkpoint = saved.address;
          }
        }
        const selected = selectHostedBookResume({
          catalogueId,
          requested,
          checkpoint,
        });
        if (selected.state === 'invalid') {
          if (selected.field === 'selection') throw new ProblemError('invalid_request');
          return finish({ state: 'unavailable' });
        }
        if (selected.state !== 'selected') return finish({ state: selected.state });
        if (!deps.content) return finish({ state: 'not-installed' });
        const resolved = await deps.content.resolve({ ...owner, address: selected.address });
        if (resolved.state !== 'resolved') return finish({ state: resolved.state });
        leases.push(resolved.lease);
        const identity = resolveHostedBookResumeIdentity(selected.address, resolved.value);
        if (identity.state !== 'available') return finish({ state: identity.state });
        return finish({
          state: 'available',
          origin: selected.origin,
          address: identity.address,
          session: {
            id: session.id,
            revision: session.revision,
            state: session.state,
          },
        });
      });
    },
  };
}
