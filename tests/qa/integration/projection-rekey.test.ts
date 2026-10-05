import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { resolveProjection } from '../../../services/main/src/modules/projection/validate.ts';
import { targetRead } from '../../../services/main/src/modules/target/resolve.ts';
import type { ProjectionKey } from '../../../services/main/src/modules/projection/schema.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}

test('stored projection identities keep their key when resolved again from owner storage', async () => {
  const stack = await startMediaStack('projection-rekey');
  try {
    const owner = await stack.member('identity-auditor');
    const work = await stack.publicWork(owner.actor);
    for (const [scope, action] of [[`work:read:${work.work}`, 'work.read'], [`work:edit:${work.work}`, 'work.edit'],
      ['semantic:create:root', 'semantic.change'], ['projection:create:root', 'projection.create']]) {
      await owner.grant(scope!, action!);
    }
    const subject = (await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: owner.actor, expectedHead: null,
      state: { component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [{
        predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: work.work } }] },
    }), 201)).component;
    const realization = `https://rezics.com/id/${randomUUID()}`;
    await json(await owner.send('PUT', `/v1/works/${work.work.slice(-36)}/realizations/${realization.slice(-36)}`, {
      profile: 'realization-v1', expectedHead: null, actingSubject: owner.actor, id: realization,
      language: 'en', kind: 'translation', translators: [owner.actor], publishers: [owner.actor],
      source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence: work.work,
    }));
    // This spelling once produced a separate identity; the implied Work must be dropped before reservation.
    await json(await owner.send('POST', '/v1/projections', {
      subject, frames: [work.work, realization], actingSubject: owner.actor,
    }), 201);
    await json(await owner.send('POST', '/v1/projections', { subject, frames: [work.work], actingSubject: owner.actor }), 201);
    const rows = (await stack.accessPool.query<ProjectionKey>(`SELECT p.subject, p.frames, p.key
      FROM access.projection_identity p JOIN access.admission a ON a.id = p.admission_id
      WHERE a.principal_id = $1 ORDER BY p.projection`, [owner.principalId])).rows;
    const changed: string[] = [];
    for (const row of rows) {
      const normalized = await targetRead(stack.env, { access: stack.access, principal: owner.principal,
        actingSubject: owner.actor }, session => resolveProjection(session, row));
      if (normalized.key !== row.key) changed.push(row.key);
    }
    expect(rows.length).toBe(2);
    expect(changed).toEqual([]);
    console.log(`Projection identity normalization audit: ${rows.length} stored identities, ${changed.length} changed keys`);
  } finally { await stack.stop(); }
}, 240_000);
