import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { FeedItem, FeedVoteResult } from '../../../services/main/src/modules/feed/contract.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import {
  mainSelectionDigest,
  selectMainDefault,
} from '../../../services/main/src/modules/work/select-main.ts';
import { HOME_VOTE_BUDGET, meterStatements, startHomeStack } from './feed-read-support.ts';

test('a listed group member shares its leader vote, revision and stable retry receipt', async () => {
  const home = await startHomeStack('feed-group-votes', { projectionStart: 'current' });
  try {
    const { stack, call, json } = home;
    const author = await home.provision('Group author', home.author.token);
    const reader = await home.provision('Group reader', home.reader.token);
    const work = await stack.publicWork(author, ['en'], 'Grouped publications');
    for (const text of ['First selected contribution', 'Second selected contribution']) {
      const contribution = await stack.contribution(work.work, author, 'en', text);
      const head = (
        await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work.mainVersion)} rv:selectionHead ?head } } LIMIT 1`)
      ).results!.bindings[0]!.head!.value;
      const selection = {
        context: { kind: 'main-version-default' as const, id: work.mainVersion },
        work: work.work,
        contribution: contribution.contribution,
        publicationDecision: contribution.decision,
        expectedSelectionHead: head,
        selectionBasis: 'main-maintainer' as const,
        actingSubject: author,
      };
      expect(
        (
          await selectMainDefault(
            stack.env,
            stack.admission(
              author,
              `publication:select:${work.mainVersion}`,
              'publication.select',
              mainSelectionDigest(selection),
            ),
            selection,
          )
        ).outcome,
      ).toBe('succeeded');
    }
    await home.project();
    const listPath = `/v1/feed?scope=all&sort=new&kinds=contribution&actingSubject=${encodeURIComponent(reader)}`;
    const listed = async () =>
      (
        await json<{ items: FeedItem[]; nextCursor: string | null }>(
          await call('GET', listPath, undefined, home.reader.token),
        )
      ).items.filter((item) => item.target.work === work.work);
    const [leader] = await listed();
    expect(leader).toBeDefined();
    expect(leader!.group.count).toBe(2);
    const groupRows = (
      await stack.accessPool.query<{ id: string; group_leader: boolean }>(
        'SELECT id, group_leader FROM access.feed_item WHERE data_epoch=$1 AND group_key=$2',
        [stack.env.lineage.dataEpoch, leader!.group.key],
      )
    ).rows;
    const member = groupRows.find((row) => !row.group_leader)!.id;
    expect(groupRows.find((row) => row.group_leader)!.id).toBe(leader!.id);
    const vote = (value: -1 | 0 | 1, expectedRevision: string | null = null) => ({
      profile: 'feed-vote-command-v1',
      actingSubject: reader,
      value,
      expectedRevision,
    });
    const votePath = (target: string) => `/v1/feed/${target.slice(-36)}/vote`;
    const up = await json<FeedVoteResult>(
      await call('POST', leader!.links.vote, vote(1), home.reader.token),
    );
    expect(up).toMatchObject({ target: leader!.id, score: 1, value: 1, replayed: false });

    // The request hides only the anchor; its public sibling must remain actionable
    // without exposing the filtered identity or losing the group's existing vote.
    const hide = { actingSubject: reader, kind: 'activity', target: leader!.id, strength: 'hide' };
    await json(await call('POST', '/v1/me/feed-feedback', hide, home.reader.token));
    const [visible] = await listed();
    expect(visible).toMatchObject({
      id: member,
      group: { count: 1 },
      score: 1,
      vote: 1,
      voteRevision: up.revision,
      links: { vote: votePath(member) },
    });
    expect(JSON.stringify(visible)).not.toContain(leader!.id);
    expect((await call('POST', votePath(member), vote(1), home.reader.token)).status).toBe(409);
    const key = randomUUID(),
      meter = meterStatements(),
      queries = stack.fuseki.queries;
    let down: FeedVoteResult;
    try {
      down = await json<FeedVoteResult>(
        await call('POST', visible!.links.vote, vote(-1, up.revision), home.reader.token, key),
      );
      expect(stack.fuseki.queries - queries).toBeLessThanOrEqual(HOME_VOTE_BUDGET.graphQueries);
      expect(meter.count()).toBeLessThanOrEqual(HOME_VOTE_BUDGET.statements);
    } finally {
      meter.restore();
    }
    expect(down).toMatchObject({ target: member, score: -1, value: -1, replayed: false });
    expect(
      await json(
        await call('POST', votePath(member), vote(-1, up.revision), home.reader.token, key),
      ),
    ).toMatchObject({ target: member, score: -1, revision: down.revision, replayed: true });
    expect(
      (await call('POST', votePath(leader!.id), vote(-1, up.revision), home.reader.token, key))
        .status,
    ).toBe(409);
    expect((await listed())[0]).toMatchObject({
      id: member,
      score: -1,
      vote: -1,
      voteRevision: down.revision,
    });

    // Aliases serialize to the same revision: one winner and one stale command.
    const race = await Promise.all(
      [leader!.id, member].map((target) =>
        call('POST', votePath(target), vote(1, down.revision), home.reader.token),
      ),
    );
    expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await json<FeedVoteResult>(race.find((response) => response.status === 200)!);
    expect(winner.score).toBe(1);
    expect(
      (
        await stack.accessPool.query(
          'SELECT target FROM access.feed_post_vote_event WHERE voter_principal=$1',
          [home.reader.principalId],
        )
      ).rows,
    ).toEqual([{ target: leader!.id }, { target: leader!.id }, { target: leader!.id }]);
    expect(
      (
        await stack.accessPool.query(
          'SELECT target, value, revision FROM access.feed_vote WHERE principal_id=$1',
          [home.reader.principalId],
        )
      ).rows,
    ).toEqual([{ target: leader!.id, value: 1, revision: winner.revision }]);
    expect(
      (
        await stack.accessPool.query(
          'SELECT id, score FROM access.feed_item WHERE data_epoch=$1 AND id=ANY($2::text[]) ORDER BY score DESC',
          [stack.env.lineage.dataEpoch, [leader!.id, member]],
        )
      ).rows,
    ).toEqual([
      { id: leader!.id, score: 1 },
      { id: member, score: 0 },
    ]);
    await json(
      await call('POST', '/v1/me/feed-feedback', { ...hide, strength: 'clear' }, home.reader.token),
    );
    expect((await listed())[0]).toMatchObject({
      id: leader!.id,
      group: { count: 2 },
      score: 1,
      vote: 1,
      voteRevision: winner.revision,
    });

    // A hidden source anchor stays internal; the surviving member still carries
    // the group's state and accepts a vote. This is distinct from a reader filter.
    await home.project();
    const draft = (
      await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?draft WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(leader!.id)} rv:selectedDraft ?draft } } LIMIT 1`)
    ).results!.bindings[0]!.draft!.value;
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(draft)} a rv:ErasedRevision } }`);
    const [survivor] = await listed();
    expect(survivor).toMatchObject({
      id: member,
      group: { count: 1 },
      score: 1,
      vote: 1,
      voteRevision: winner.revision,
      links: { vote: votePath(member) },
    });
    expect(JSON.stringify(survivor)).not.toContain(leader!.id);
    expect(
      (await call('POST', votePath(leader!.id), vote(0, winner.revision), home.reader.token))
        .status,
    ).toBe(404);
    const removed = await json<FeedVoteResult>(
      await call('POST', survivor!.links.vote, vote(0, winner.revision), home.reader.token),
    );
    expect(removed).toMatchObject({ target: member, value: 0, score: 0 });
    expect((await listed())[0]).toMatchObject({
      id: member,
      score: 0,
      vote: 0,
      voteRevision: removed.revision,
    });

    // An admitted source missing from the projection keeps its unavailable result;
    // the historical receipt still replays without resolving current membership.
    await stack.accessPool.query('DELETE FROM access.feed_item WHERE data_epoch=$1 AND id=$2', [
      stack.env.lineage.dataEpoch,
      member,
    ]);
    expect(
      (await call('POST', votePath(member), vote(1, removed.revision), home.reader.token)).status,
    ).toBe(503);
    expect(
      await json(
        await call('POST', votePath(member), vote(-1, up.revision), home.reader.token, key),
      ),
    ).toMatchObject({ target: member, score: -1, revision: down.revision, replayed: true });

    // Lost-response replay also survives later disclosure loss.
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:protectionHead ${iri(`https://rezics.com/id/${randomUUID()}`)} } }`);
    expect((await listed()).length).toBe(0);
    expect(
      (await call('POST', votePath(member), vote(1, removed.revision), home.reader.token)).status,
    ).toBe(404);
    expect(
      await json(
        await call('POST', votePath(member), vote(-1, up.revision), home.reader.token, key),
      ),
    ).toMatchObject({ target: member, score: -1, revision: down.revision, replayed: true });
    expect(
      (
        await call(
          'POST',
          votePath(`https://rezics.com/id/${randomUUID()}`),
          vote(1),
          home.reader.token,
        )
      ).status,
    ).toBe(404);
  } finally {
    await home.stop();
  }
}, 180_000);
