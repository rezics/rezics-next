import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { memberFixture } from '../../../services/main/tests/member-reply-fixture.ts';
import { AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { mainSelectionDigest, sealMainSelectionAdmission } from '../../../services/main/src/modules/work/select-main.ts';
import { assertCommandRace } from '../support/command-race.ts';

test('G265: creator and added/transferred maintainers select without grants; stale, concurrent, replay and erased targets', async () => {
  const h = await memberFixture();
  try {
    expect((await h.accessPool.query(`SELECT id FROM access.permission_grant WHERE recipient_subject = ANY($1)
      AND action <> 'access.membership.consent'`, [[h.actor, h.pen]])).rowCount).toBe(0);
    const view = await h.get(`/v1/works/${h.work.work.split('/').at(-1)}/maintainers`);
    expect(view.body).toMatchObject({ generation: '0', maintainers: [h.actor] });
    expect((await h.post('/v1/publication-selections', { ...h.selection, actingSubject: h.pen })).status).toBe(403);
    const key = randomUUID();
    const selected = await h.post('/v1/publication-selections', h.selection, key);
    expect(selected.status, JSON.stringify(selected.body)).toBe(201);
    expect((await h.post('/v1/publication-selections', h.selection, key)).body.selection).toBe(selected.body.selection);
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(409);
    const second = await h.contribution('Another public contribution.');
    const next = { ...h.selection, contribution: second.contribution, publicationDecision: second.publicationDecision,
      expectedSelectionHead: selected.body.selection };
    const racedCommands = [
      h.post.bind(h, '/v1/publication-selections', next, randomUUID()),
      h.post.bind(h, '/v1/publication-selections', next, randomUUID()),
    ];
    const raced = await assertCommandRace(
      await Promise.all(racedCommands.map((send) => send())),
      201,
      (index) => racedCommands[index]!(),
    );
    const add = { profile: 'work-maintainer-change-v1', work: h.work.work, actingSubject: h.actor,
      target: h.pen, action: 'add', expectedGeneration: '0' };
    const addKey = randomUUID();
    expect((await h.post('/v1/work-maintainer-changes', { ...add, actingSubject: h.pen, target: h.actor })).status).toBe(403);
    const added = await h.post('/v1/work-maintainer-changes', add, addKey);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.maintainers.sort()).toEqual([h.actor, h.pen].sort());
    expect((await h.post('/v1/work-maintainer-changes', add, addKey)).body.receipt).toBe(added.body.receipt);
    expect((await h.post('/v1/work-maintainer-changes', add)).status).toBe(409);
    const currentSelection = raced.find(result => result.status === 201)!.body.selection;
    const principal = await h.principal();
    const pendingInput = { ...next, expectedSelectionHead: currentSelection };
    const pending = await h.access.register({ principal, actingSubject: h.actor, action: 'publication.select',
      scope: `publication:select:${h.work.mainVersion}`, baselineRelatedWork: h.work.work,
      requestDigest: mainSelectionDigest(pendingInput as Parameters<typeof mainSelectionDigest>[0]), idempotencyKey: randomUUID() });
    await h.access.claim(pending.id, pending.requestDigest, principal);
    const transfer = { ...add, action: 'transfer', expectedGeneration: '1' };
    expect((await h.post('/v1/work-maintainer-changes', transfer)).status).toBe(409);
    await h.access.recordGraphOutcome(pending.id, await sealMainSelectionAdmission(h.env, pending));
    const registered = await h.access.register({ principal, actingSubject: h.actor, action: 'publication.select',
      scope: `publication:select:${h.work.mainVersion}`, baselineRelatedWork: h.work.work,
      requestDigest: pending.requestDigest, idempotencyKey: randomUUID() });
    expect((await h.post('/v1/work-maintainer-changes', transfer)).status).toBe(201);
    await expect(h.access.claim(registered.id, registered.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.post('/v1/publication-selections', pendingInput)).status).toBe(403);
    const byPen = await h.post('/v1/publication-selections', { ...pendingInput, actingSubject: h.pen });
    expect(byPen.status, JSON.stringify(byPen.body)).toBe(201);
    expect((await h.post('/v1/works', h.workBody, h.workKey)).status).toBe(200);
    expect((await h.maintainers.read(h.work.work)).maintainers).toEqual([h.pen]);
    const organization = await h.agent('Publisher', 'organization');
    expect((await h.post('/v1/work-maintainer-changes', { ...add, actingSubject: h.pen,
      target: organization, expectedGeneration: '2' })).status).toBe(201);
    const byOrganization = await h.post('/v1/publication-selections', { ...pendingInput,
      expectedSelectionHead: byPen.body.selection, actingSubject: organization });
    expect(byOrganization.status, JSON.stringify(byOrganization.body)).toBe(201);
    await h.fuseki.update(`INSERT DATA { GRAPH <urn:rezics:graph:revisions> {
      <${second.draftRevision}> a <https://rezics.com/vocab/ErasedRevision> } }`);
    expect((await h.post('/v1/publication-selections', { ...pendingInput,
      expectedSelectionHead: byOrganization.body.selection, actingSubject: h.pen })).status).toBe(404);
  } finally { await h.close(); }
}, 180_000);

test('G265: unverified and suspended Accounts cannot select or change Work maintainers', async () => {
  const h = await memberFixture();
  try {
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [h.user.id]);
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(403);
    const change = { profile: 'work-maintainer-change-v1', work: h.work.work, actingSubject: h.actor,
      target: h.pen, action: 'add', expectedGeneration: '0' };
    expect((await h.post('/v1/work-maintainer-changes', change)).status).toBe(403);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
    await h.accountPool.query('UPDATE rezics_account_security SET suspended_at = now(), generation = generation + 1 WHERE user_id = $1', [h.user.id]);
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(401);
    expect((await h.post('/v1/work-maintainer-changes', change)).status).toBe(401);
  } finally { await h.close(); }
}, 180_000);
