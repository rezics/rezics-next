import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { governedWiki, memberOf, policyHarness, realm, rule } from './access-policy-harness.ts';

test('IAM18 partial: mute, interaction block and resource exclusion keep separate owners and effects', async () => {
  const h = await policyHarness();
  try {
    const wiki = await governedWiki(h);
    const x = await realm(h);
    const recipient = await h.fixture.agent();
    const [a, b] = [await h.fixture.agent(), await h.fixture.agent()];
    await h.fixture.agentMember('realm', x, a);
    for (const agent of [a, b]) {
      for (const action of ['work.edit', 'interaction.message', 'interaction.mention']) {
        await h.fixture.mandate(h.reader, agent, action);
      }
      await h.fixture.grant(wiki.owner, agent, wiki.scope, 'work.edit');
    }
    await h.fixture.mandate(h.manager, recipient, 'access.interaction.manage');
    const excluded = await wiki.admit(x, 'acting_subject');
    const guards = [rule.guard({ op: 'represents' })];
    await wiki.published(guards, [rule.allow({ op: 'has-grant', action: 'work.edit' })]);
    const interact = async (actor: string, interaction = 'message') => (await h.ok<{ result: string }>(
      h.call('POST', '/v1/access/interaction-decisions', h.readerToken, {
        profile: 'access-interaction-decision-v1', recipientSubject: recipient, interaction,
        actingSubject: actor }))).result;
    const mutes = async () => (await h.ok<{ mutes: { target: string; revision: string }[] }>(
      h.call('GET', '/v1/me/interaction-mutes', h.readerToken))).mutes;
    const effects = async () => [await interact(a), await interact(a, 'mention'), await interact(b),
      (await wiki.decide(a)).result, (await mutes()).map(mute => mute.target)];

    // Presentation: a private mute is only the reader's selection preference.
    const mute = { profile: 'access-interaction-mute-v1', targetKind: 'realm', target: x,
      match: 'publishing-realm', muted: true, expectedRevision: null };
    const muteKey = randomUUID();
    const muted = await h.ok<{ revision: string; replayed: boolean }>(
      h.call('PUT', '/v1/me/interaction-mutes', h.readerToken, mute, muteKey));
    expect(await h.ok(h.call('PUT', '/v1/me/interaction-mutes', h.readerToken, mute, muteKey)))
      .toMatchObject({ revision: muted.revision, replayed: true });
    expect((await h.call('PUT', '/v1/me/interaction-mutes', h.readerToken, mute)).body.code).toBe('policy_stale');
    expect((await h.call('PUT', '/v1/me/interaction-mutes', h.readerToken,
      { ...mute, match: 'author' })).status).toBe(400);
    expect(await effects()).toEqual(['allow', 'allow', 'allow', 'allow', [x]]);

    // Interaction admission: the recipient blocks the Realm's selected members for
    // messages and replies only; mentions, other Agents and resource access remain.
    const block = { profile: 'access-interaction-block-change-v1', recipientSubject: recipient,
      expectedAuthorityEpoch: '0', action: 'block', blockId: randomUUID(),
      target: { kind: 'member-set', setKind: 'realm', setOwnerSubject: x, basis: 'acting_subject' },
      interactions: ['message', 'reply'] };
    expect((await h.call('POST', '/v1/access/interaction-blocks', h.readerToken, block)).status).toBe(403);
    const blockKey = randomUUID();
    const blocked = await h.ok<{ generation: string; authorityEpoch: string }>(
      h.call('POST', '/v1/access/interaction-blocks', h.managerToken, block, blockKey));
    expect(await h.ok(h.call('POST', '/v1/access/interaction-blocks', h.managerToken, block, blockKey)))
      .toMatchObject({ replayed: true, authorityEpoch: blocked.authorityEpoch });
    expect((await h.call('POST', '/v1/access/interaction-blocks', h.managerToken,
      { ...block, blockId: randomUUID() })).body.code).toBe('policy_stale');
    expect(await effects()).toEqual(['deny', 'allow', 'allow', 'allow', [x]]);
    const frames = await h.q(`SELECT d.kind, d.reason, array_agg(i.kind ORDER BY i.ordinal) AS inputs
      FROM access.decision_snapshot d JOIN access.decision_snapshot_input i ON i.decision_id = d.id
      WHERE d.recipient_subject = $1 AND d.reason = 'interaction-blocked' GROUP BY d.id`, [recipient]);
    expect(frames.rows[0]).toEqual({ kind: 'interaction', reason: 'interaction-blocked',
      inputs: ['representation', 'membership', 'interaction_block'] });

    // Resource access: the wiki's Realm exclusion changes neither interaction nor mute.
    await wiki.published(guards, [rule.deny(memberOf(excluded, 'acting_subject')),
      rule.allow({ op: 'has-grant', action: 'work.edit' })]);
    expect(await effects()).toEqual(['deny', 'allow', 'allow', 'deny', [x]]);
    // Unmuting is not unblocking, and unblocking does not lift the resource exclusion.
    await h.ok(h.call('PUT', '/v1/me/interaction-mutes', h.readerToken,
      { ...mute, muted: false, expectedRevision: muted.revision }));
    expect(await effects()).toEqual(['deny', 'allow', 'allow', 'deny', []]);
    await h.ok(h.call('POST', '/v1/access/interaction-blocks', h.managerToken, {
      profile: 'access-interaction-block-change-v1', recipientSubject: recipient,
      expectedAuthorityEpoch: blocked.authorityEpoch, action: 'unblock', blockId: block.blockId,
      expectedGeneration: '0' }));
    expect(await effects()).toEqual(['allow', 'allow', 'allow', 'deny', []]);
    // An actor must be represented for the exact interaction; the block owner never
    // learns anything from the interaction decision.
    expect((await h.call('POST', '/v1/access/interaction-decisions', h.readerToken, {
      profile: 'access-interaction-decision-v1', recipientSubject: recipient, interaction: 'reply',
      actingSubject: a })).status).toBe(403);
  } finally { await h.close(); }
}, 180_000);
