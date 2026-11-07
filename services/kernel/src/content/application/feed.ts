import {
  FEED_CONTINUE_WIDTH,
  FEED_LANES,
  FeedBoundExceededError,
  FeedRefusedError,
  type FeedActor,
  type FeedApplicationPorts,
  type FeedContinuationSubject,
  type FeedItem,
  type FeedLane,
  type FeedLaneCandidate,
  type FeedPage,
  type FeedPosition,
  type FeedReadQuery,
  type FeedReads,
  type FeedSourceState,
  type FeedSpaceSession,
  type FeedStream,
} from '../contract/index.ts';
import {
  admitFeedCandidateReservation,
  admitFeedPageLimit,
  advanceFeedFrontier,
  feedHasReadyFrontier,
  feedLaneWidths,
  initialFeedPosition,
  initialFeedSources,
  mergeFeedLanes,
  rejectFeedKindMismatches,
  rewindFeedLanes,
} from '../core/index.ts';

function asAccount(actor: FeedActor) {
  return actor.kind === 'account' ? actor : undefined;
}

function mutableSources(value: ReturnType<typeof initialFeedSources>): {
  discovery: FeedSourceState;
  following: FeedSourceState;
  continue: FeedSourceState;
} {
  return { ...value };
}

function continueCandidate(
  row: FeedContinuationSubject,
  fingerprint: (value: unknown) => string,
  route: (id: string) => number,
): FeedLaneCandidate {
  const after = fingerprint([row.subjectId, row.lastActivityAt]);
  const summary = row.subject;
  if (!summary) return { after, item: null };
  return {
    after,
    item: {
      id: `continue:${summary.id}`,
      source: 'continue',
      key: { owner: 'semantic', kind: summary.type, route: route(summary.id), id: summary.id },
      occurredAt: row.lastActivityAt,
      summary,
      continue: row,
      destination: { kind: 'subject', id: summary.id, title: summary.label?.value ?? null },
    },
  };
}

/** One bounded mixed Home page. Foreign producers are ports; missing authority is unavailable. */
export function createFeedApplication(
  ports: FeedApplicationPorts,
  options: Readonly<{ route?(id: string): number }> = {},
): FeedReads {
  const routeOf = options.route ?? ((id: string) => Number.parseInt(id.replaceAll('-', '').slice(0, 4), 16) % 65536);

  return {
    async list(actor, query, deadline, languages): Promise<FeedPage> {
      const stream: FeedStream = query.stream ?? 'home';
      let limit: number;
      try {
        limit = admitFeedPageLimit(query.limit);
      } catch {
        return ports.refuse('invalid_request');
      }
      const personal = actor.kind === 'account';
      if (stream === 'following' && !personal) return ports.refuse('authentication_required');
      const account = asAccount(actor);
      if (account) {
        if (
          !account.scopes.includes('follow:list') ||
          (stream === 'home' &&
            (!account.scopes.includes('library_entry:list') || !account.scopes.includes('progress_session:list')))
        )
          return ports.refuse('forbidden');
        await ports.admission.following(account, deadline);
        if (stream === 'home') {
          await ports.admission.personalLibrary(account, deadline);
          await ports.admission.readingProgress(account, deadline);
        }
      }
      if (stream === 'home') await ports.admission.discovery(actor, deadline);
      const now = ports.now();
      const bindingQuery: FeedReadQuery = {
        ...query,
        stream,
        limit,
      };
      const position: FeedPosition = query.cursor
        ? await ports.cursor.decode(actor, bindingQuery, languages, query.cursor, now)
        : initialFeedPosition({ stream, personal, boundary: now.toISOString() });
      if (query.ratingQuestionId !== undefined) return ports.refuse('dependency_unavailable');
      let space: FeedSpaceSession | undefined;
      let spacePopulation: FeedSpaceSession | undefined;
      if (query.spaceId !== undefined) {
        space = await ports.space.open(actor, query.spaceId, deadline, now.toISOString());
        if (stream === 'home')
          spacePopulation = await ports.space.openPopulation(actor, space, deadline, now.toISOString());
      }
      const sources = mutableSources(initialFeedSources({ stream, personal }));
      const lanes: Record<FeedLane, FeedLaneCandidate[]> = { continue: [], following: [], discovery: [] };
      const next: {
        boundary: string;
        turn: number;
        discovery: FeedPosition['discovery'];
        following: FeedPosition['following'];
        continue: FeedPosition['continue'];
        resume: FeedPosition['resume'];
      } = { ...position };
      let continueFingerprint = '';
      let discoveryAsOf: string | undefined;
      const widths = feedLaneWidths({ stream, personal, limit });
      try {
        admitFeedCandidateReservation({
          discovery: widths.discovery,
          following: widths.following,
          continued: widths.continued,
          spaceSelected: space !== undefined,
        });
      } catch (error) {
        if (error instanceof FeedBoundExceededError) throw error;
        throw error;
      }

      const failLane = (lane: FeedLane, error: unknown) => {
        lanes[lane] = [];
        sources[lane] =
          error instanceof FeedRefusedError && error.code === 'dependency_unavailable'
            ? 'unavailable'
            : ports.classifyFailure(error);
        next[lane] = position[lane];
        if (lane === 'continue') next.resume = position.resume;
      };

      const loadLane = async (lane: FeedLane) => {
        if (position[lane] === false) return;
        try {
          if (lane === 'discovery') {
            if (!ports.discovery) throw new FeedRefusedError('dependency_unavailable');
            const page = await ports.discovery.page({
              actor,
              limit: widths.discovery,
              languages,
              deadline,
              ...(query.kind === undefined ? {} : { kind: query.kind }),
              ...(space ? { spaceId: space.spaceId } : {}),
              ...(position.discovery ? { cursor: position.discovery } : {}),
            });
            discoveryAsOf = page.asOf;
            lanes.discovery = [...page.candidates];
            next.discovery = page.next;
            return;
          }
          if (lane === 'continue') {
            if (!ports.continuation) throw new FeedRefusedError('dependency_unavailable');
            const page = await ports.continuation.page(
              actor,
              {
                limit: FEED_CONTINUE_WIDTH,
                view: 'FULL',
                ...(space ? { spaceId: space.spaceId } : {}),
                ...(space && query.kind !== undefined ? { kind: query.kind } : {}),
                ...(position.continue ? { cursor: position.continue } : {}),
              },
              deadline,
              languages,
            );
            const presented = ports.presentation
              ? page.subjects.map((row) => ports.presentation!.present(row))
              : page.subjects;
            continueFingerprint = ports.cursor.fingerprint(presented.map((row) => [row.subjectId, row.lastActivityAt]));
            if (position.resume && position.resume.fingerprint !== continueFingerprint)
              return ports.refuse('stale_cursor');
            const offset = position.resume
              ? presented.findIndex(
                  (row) =>
                    ports.cursor.fingerprint([row.subjectId, row.lastActivityAt]) === position.resume!.after,
                ) + 1
              : 0;
            if (position.resume && !offset) return ports.refuse('stale_cursor');
            lanes.continue = presented
              .slice(offset)
              .map((row) => continueCandidate(row, ports.cursor.fingerprint, routeOf));
            next.continue = page.next ?? false;
            next.resume = null;
            return;
          }
          if (!account) return;
          if (!ports.following) throw new FeedRefusedError('dependency_unavailable');
          const page = await ports.following.page({
            actor: account,
            limit: widths.following,
            languages,
            deadline,
            boundary: position.boundary,
            ...(query.kind === undefined ? {} : { kind: query.kind }),
            ...(position.following ? { cursor: position.following } : {}),
            ...(space ? { space } : {}),
          });
          lanes.following = [...page.candidates];
          next.following = page.next;
        } catch (error) {
          if (error instanceof FeedRefusedError) throw error;
          failLane(lane, error);
        }
      };

      await Promise.all(FEED_LANES.map(loadLane));
      const sourceWitnesses = new Map(
        FEED_LANES.flatMap((lane) =>
          lanes[lane].flatMap(({ item }) => (item ? [[item.id, JSON.stringify(item)] as const] : [])),
        ),
      );
      const filtered = rejectFeedKindMismatches(lanes, query.kind);
      lanes.continue = filtered.continue;
      lanes.following = filtered.following;
      lanes.discovery = filtered.discovery;
      const merged = mergeFeedLanes({ lanes, turn: position.turn, limit });
      let feedItems = merged.items;
      Object.assign(
        next,
        advanceFeedFrontier({
          position,
          lanes,
          offsets: merged.offsets,
          turn: merged.turn,
          continueFingerprint,
        }),
      );

      const rewind = (affected: ReadonlySet<FeedLane>, error: unknown) => {
        for (const lane of affected) failLane(lane, error);
        feedItems = rewindFeedLanes(feedItems, affected);
      };

      const conversation = await ports.finish.beginConversation(feedItems, deadline);
      if (conversation.rewind)
        rewind(conversation.rewind, conversation.error ?? new FeedRefusedError('dependency_unavailable'));

      const context = await ports.finish.contentContext(feedItems, actor, languages, deadline);
      feedItems = context.items;
      if (context.rewind) rewind(context.rewind, context.error ?? new FeedRefusedError('dependency_unavailable'));

      const reactions = await ports.finish.reactions(feedItems, actor, deadline);
      feedItems = reactions.items;
      let reactionsAsOf = reactions.reactionsAsOf;
      if (reactions.rewind) {
        rewind(reactions.rewind, reactions.error ?? new FeedRefusedError('dependency_unavailable'));
        reactionsAsOf = undefined;
      }

      const advice = await ports.finish.reactionAdvice(feedItems, actor, deadline, stream);
      feedItems = advice.items;

      const subject = await ports.finish.subjectReactions(feedItems, actor, deadline);
      feedItems = subject.items;
      if (subject.rewind) rewind(subject.rewind, subject.error ?? new FeedRefusedError('dependency_unavailable'));

      await space?.finish();
      await spacePopulation?.finish();

      const follows = await ports.finish.followSupport(feedItems, actor, deadline);
      feedItems = follows.items;
      if (follows.rewind) rewind(follows.rewind, follows.error ?? new FeedRefusedError('dependency_unavailable'));

      const confirmed = await ports.finish.confirmConversation(feedItems, deadline);
      feedItems = confirmed.items;
      if (confirmed.rewind)
        rewind(confirmed.rewind, confirmed.error ?? new FeedRefusedError('dependency_unavailable'));

      const reopenSelected = async () => {
        const retained = { ...next };
        const selected = [...new Set(feedItems.map((item) => item.source))];
        await space?.finish();
        if (query.spaceId !== undefined)
          space = await ports.space.open(actor, query.spaceId, deadline, now.toISOString());
        for (const lane of selected) await loadLane(lane);
        Object.assign(next, retained);
        const current = new Map(
          selected.flatMap((lane) =>
            lanes[lane].flatMap(({ item }) => (item ? [[item.id, JSON.stringify(item)] as const] : [])),
          ),
        );
        feedItems = feedItems.filter((item) => {
          if (current.get(item.id) === sourceWitnesses.get(item.id)) return true;
          next[item.source] = position[item.source];
          if (item.source === 'continue') next.resume = position.resume;
          return false;
        });
        feedItems = await ports.finish.reopenSelected(feedItems, actor, bindingQuery, languages, deadline);
        await space?.finish();
        await spacePopulation?.finish();
        return feedItems;
      };

      let viewerPersonalActions: FeedPage['viewerPersonalActions'];
      if (personal && stream === 'home') {
        const personalPage = await ports.finish.personalActions(
          feedItems,
          actor,
          languages,
          deadline,
          reopenSelected,
        );
        feedItems = personalPage.items;
        viewerPersonalActions = personalPage.viewerPersonalActions;
      } else if (stream === 'home' && advice.hasTargets) await reopenSelected();
      if (advice.finish) feedItems = await advice.finish(feedItems);

      return {
        feedItems,
        ...(viewerPersonalActions === undefined ? {} : { viewerPersonalActions }),
        sources,
        asOf: personal ? position.boundary : (discoveryAsOf ?? position.boundary),
        ...(reactionsAsOf === undefined ? {} : { reactionsAsOf }),
        next: feedHasReadyFrontier(next, sources)
          ? await ports.cursor.encode(actor, bindingQuery, languages, next, now)
          : null,
      };
    },
  };
}
