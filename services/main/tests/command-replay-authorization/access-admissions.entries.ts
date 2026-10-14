import { randomUUID } from 'node:crypto';
import { AdmissionConflict, AdmissionDenied } from '../../src/modules/access/admission.ts';
import { createAdmittedMetadataWork } from '../../src/modules/work/create-admitted.ts';
import { type ReplayEntry, stack, request, graphSnapshot, loseGrant } from './fixtures.ts';

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/works", authorityClass: 'domain-grant',
    scope: "work:create:root", action: "work.create", family: 'shared Access admissions', owners: ['modules/work/create-admitted.ts#createAdmittedMetadataWork'],
    subcases: ['represented Work creation'], denied: AdmissionDenied, conflict: AdmissionConflict,
    registration: 'registered-failing',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      const grant = await member.grant('work:create:root', 'work.create');
      const input = { actingSubject: member.actor, title: `Replay ${randomUUID()}`,
        language: 'en', idempotencyKey: randomUUID() };
      let saved: Awaited<ReturnType<typeof createAdmittedMetadataWork>>;
      return { command: async (fresh, changed) => {
        const result = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
          stack.access, request(member), { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
            ...(changed ? { title: 'Different binding' } : {}) });
        saved ??= result;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      snapshot: async () => ({ graph: await graphSnapshot(saved.work, saved.receipt),
        admissions: (await stack.accessPool.query(`SELECT to_jsonb(a) AS row FROM access.admission a
          WHERE principal_id = $1 ORDER BY id`, [member.principalId])).rows }) };
    } }
];
