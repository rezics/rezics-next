import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditTriples } from '../../../services/main/src/modules/work/author-credit.ts';
import { seedHome, startHomeStack } from './feed-read-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
interface FeedItem { id: string; kind: string; card: { kind: string }; target: { work: string | null };
  reason: { kind: string; target?: string; targetKind?: string } }
interface FeedPage { items: FeedItem[]; nextCursor: string | null }
interface FollowState { target: { id: string; kind: string; name: { value: string }; href: string };
  following: boolean | null; revision: string | null; followers: { value: number; kind: string } }
interface FollowReceipt { target: string; kind: string; following: boolean; revision: string; replayed: boolean }
interface AuthorsPage { items: Array<{ id: string; kind: string; available: boolean; name: { value: string } | null;
  href: string | null; newestWork: { id: string; title: { value: string } } | null }>; nextCursor: string | null }

test('G-397 readers follow native and Open Library authors, hear of their new Works and chapters, and see only a count',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
    const home = await startHomeStack('follows-authors');
    try {
      const seeded = await seedHome(home);
      const { call, json, stack } = home;
      const token = home.reader.token;
      const base = Number(String(Date.now()).slice(-9));
      const key = `/authors/OL${base}A`, target = `open-library:OL${base}A`;
      const hiddenTarget = `open-library:OL${base + 1}A`;
      const [discussed, , book, novel, story] = seeded.works;
      // The Open Library author wrote the discussed Work, the book with chapters and a novel.
      const external = [discussed!, book!, novel!].map((work, ordinal) => authorCreditTriples({ work: work.work,
        credit: id(), revision: id(), expectedHead: id(), sourceKey: key, sourceRoleKey: null, nativeOrdinal: ordinal,
        actingSubject: seeded.author }, stack.env.lineage.dataEpoch, '1'));
      // A second Agent of the author's person is credited on a Work the first posted:
      // the follow answers to the credit, not to who posted it.
      const credited = await home.provision('Credited author', home.author.token);
      const credit = id(), creditRevision = id();
      await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${external.map(triples => triples.current).join('\n')}
          ${iri(credit)} a rv:NativeAgentCredit ; rv:creditRevision ${iri(creditRevision)} ;
            rv:work ${iri(story!.work)} ; rv:agent ${iri(credited)} ; schema:roleName "author" . }
        GRAPH ${iri(GRAPHS.revisions)} { ${external.map(triples => triples.revision).join('\n')}
          ${iri(creditRevision)} a rv:NativeAgentCreditRevision, rv:RevisionAnchor ; rv:component ${iri(credit)} ;
            rv:work ${iri(story!.work)} ; rv:agent ${iri(credited)} ; schema:roleName "author" . } }`);

      const follow = (followTarget: string, kind: string, following: boolean, expectedRevision: string | null,
        key = randomUUID()) => call('POST', '/v1/follows', { profile: 'follow-command-v1', target: followTarget, kind,
        actingSubject: seeded.reader, following, expectedRevision }, token, key);
      const state = (path: string, signed = false) => call('GET', signed ? seeded.signed(path) : path, undefined,
        signed ? token : undefined);
      // The feed is global across the QA project's files. Reading only the kinds asserted on keeps
      // another file's cards, whose owners this stack does not wire, out of the hydrated page.
      const news = ['work', 'added', 'contribution'], talk = ['discussion', 'reply'];
      const followingFeed = async (kinds = news) => {
        const items: FeedItem[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 12; page++) {
          const read: FeedPage = await json<FeedPage>(await call('GET', seeded.signed(`/v1/feed?scope=following&sort=new${
            kinds.map(kind => `&kinds=${kind}`).join('')}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
          undefined, token));
          items.push(...read.items);
          if (!read.nextCursor) return items;
          cursor = read.nextCursor;
        }
        throw new Error('Following feed exceeded its fixture pages');
      };
      const becauseOf = (items: FeedItem[], followTarget: string) => items.filter(item => item.reason.kind === 'followed'
        && item.reason.target === followTarget);

      // Invalid: a keyed target must name its kind and a real Open Library author ID.
      expect((await follow(target, 'agent', true, null)).status).toBe(400);
      expect((await follow(credited, 'external-author', true, null)).status).toBe(400);
      expect((await follow('open-library:OL0A', 'external-author', true, null)).status).toBe(400);
      expect((await call('GET', '/v1/authors/open-library/OL1W/follow')).status).toBe(400);
      // Denied: an author no public Work credits has no page, so cannot be followed.
      expect((await follow(hiddenTarget, 'external-author', true, null)).status).toBe(404);
      expect((await state(`/v1/authors/open-library/OL${base + 1}A/follow`)).status).toBe(404);

      // Nothing answers to either author before the reader follows them.
      const before = await followingFeed();
      expect(becauseOf(before, target)).toEqual([]);
      expect(becauseOf(before, credited)).toEqual([]);

      // The public count starts at zero; anonymously there is no reader state at all.
      const anonymous = await json<FollowState>(await state(`/v1/authors/open-library/OL${base}A/follow`));
      expect(anonymous).toMatchObject({ target: { id: target, kind: 'external-author', name: { value: `OL${base}A` },
        href: `/authors/open-library/OL${base}A` }, following: null, revision: null,
      followers: { value: 0, kind: 'exact' } });

      // Following is idempotent under its key, and stale under a changed revision.
      const key1 = randomUUID();
      const followed = await json<FollowReceipt>(await follow(target, 'external-author', true, null, key1));
      expect(followed).toMatchObject({ target, kind: 'external-author', following: true, replayed: false });
      expect(await json<FollowReceipt>(await follow(target, 'external-author', true, null, key1)))
        .toEqual({ ...followed, replayed: true });
      expect((await follow(target, 'external-author', false, null, key1)).status).toBe(409);
      expect((await follow(target, 'external-author', true, null)).status).toBe(409);
      const native = await json<FollowReceipt>(await follow(credited, 'agent', true, null));
      expect(native).toMatchObject({ target: credited, kind: 'agent', following: true });

      // Privacy: every reader sees the same number and nothing else; only the follower sees their own follow.
      const counted = await json<FollowState>(await state(`/v1/authors/open-library/OL${base}A/follow`));
      expect(counted.followers).toEqual({ value: 1, kind: 'exact' });
      expect(counted.following).toBeNull();
      const anonymousText = JSON.stringify(counted);
      for (const identity of [seeded.reader, home.reader.principal.subject, home.reader.principalId]) {
        expect(anonymousText).not.toContain(identity);
      }
      const own = await json<FollowState>(await state(`/v1/authors/open-library/OL${base}A/follow`, true));
      expect(own).toMatchObject({ following: true, revision: followed.revision, followers: { value: 1, kind: 'exact' } });
      expect((await state(`/v1/follows/${credited.slice(-36)}?kind=agent`).then(response =>
        json<FollowState>(response))).followers).toEqual({ value: 1, kind: 'exact' });
      // The reader state needs the reader's bearer; an actingSubject alone is refused.
      expect((await call('GET', `/v1/authors/open-library/OL${base}A/follow?actingSubject=${
        encodeURIComponent(seeded.reader)}`)).status).toBe(400);

      // Both kinds read the same in the follow list and as authors with their newest Work.
      const listed = await json<{ items: Array<{ id: string; kind: string; available: boolean; href: string | null }> }>(
        await call('GET', seeded.signed('/v1/me/follows?kind=external-author'), undefined, token));
      expect(listed.items).toEqual([expect.objectContaining({ id: target, kind: 'external-author', available: true,
        href: `/authors/open-library/OL${base}A` })]);
      const authors = await json<AuthorsPage>(await call('GET', seeded.signed('/v1/me/follows/authors'), undefined, token));
      expect(authors.items.map(item => [item.id, item.kind, item.available, item.newestWork?.id]).sort()).toEqual([
        [credited, 'agent', true, story!.work], [target, 'external-author', true, novel!.work]].sort());
      expect(authors.items.find(item => item.id === credited)?.name?.value).toBe('Credited author');

      // The Following feed carries each author's news with the author as its reason:
      // a new Work by either, and the new chapters of the Open Library author's book.
      const after = await followingFeed();
      const authorNews = becauseOf(after, target);
      expect(authorNews.filter(item => item.target.work === novel!.work).map(item => item.reason.targetKind))
        .toEqual(['external-author']);
      expect(authorNews.some(item => item.target.work === book!.work && item.card.kind === 'chapter')).toBe(true);
      expect(becauseOf(after, credited).map(item => [item.target.work, item.reason.targetKind]))
        .toEqual([[story!.work, 'agent']]);
      // Talk about an author's Work is not their news: it answers to the followed Realm alone.
      const discussion = (await followingFeed(talk)).filter(item => item.target.work === discussed!.work);
      expect(discussion.length).toBeGreaterThan(0);
      expect(discussion.every(item => item.reason.kind === 'followed' && item.reason.targetKind === 'realm')).toBe(true);

      // Unfollowing both takes them out of the feed, the list and the count.
      await json(await follow(target, 'external-author', false, followed.revision));
      await json(await follow(credited, 'agent', false, native.revision));
      const gone = await followingFeed();
      expect([...becauseOf(gone, target), ...becauseOf(gone, credited)]).toEqual([]);
      expect((await json<AuthorsPage>(await call('GET', seeded.signed('/v1/me/follows/authors'), undefined, token))).items)
        .toEqual([]);
      expect((await json<FollowState>(await state(`/v1/authors/open-library/OL${base}A/follow`))).followers)
        .toEqual({ value: 0, kind: 'exact' });
    } finally {
      await home.stop();
    }
  }, 300_000);
