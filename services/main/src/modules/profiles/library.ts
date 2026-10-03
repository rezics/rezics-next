import type { Static } from 'typebox';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { pageResult, unerased, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readComponentState } from '../work/history.ts';
import { globalContextPattern, globalRatingDigest, GLOBAL_OBSERVATION_PROFILE } from '../rating/global.ts';
import { standingRatingSlotIri } from '../rating/observation.ts';
import { field, nextPage, pageBasis, profileAccess, shelfWorks } from './read.ts';
import { libraryContribution, libraryRating } from './read-contract.ts';
import { pageDiscoveryPolicy } from '../space/visibility.ts';

async function libraryBasis(session: WorkReadSession, kind: 'contributions' | 'ratings') {
  if (!session.principal || !session.options.actingSubject) throw new AccountAssertionDenied('Library requires authentication');
  if (kind === 'ratings') {
    const principal = await session.deps.account.verify(session.request, ['rating:read']);
    if (principal.issuer !== session.principal.issuer || principal.subject !== session.principal.subject) {
      throw new AccountAssertionDenied('Principal changed');
    }
  }
  const access = profileAccess(session);
  const action = kind === 'contributions' ? 'contribution.read' : 'rating.observation.read';
  const before = await access.libraryFence(session.principal, session.options.actingSubject, action);
  const listing = await access.listing.read(session.options.actingSubject);
  const basis = pageBasis(session, kind, [before.principalId, session.options.actingSubject, before.stamp]);
  return { ...basis, access, principal: session.principal, actor: session.options.actingSubject,
    principalId: before.principalId,
    listing: listing.listing, discovery: pageDiscoveryPolicy('private', listing.listing),
    fence: async () => {
      const after = await access.libraryFence(session.principal!, session.options.actingSubject!, action);
      if (after.stamp !== before.stamp) throw new WorkReadMoved('Library authority changed');
      if ((await access.listing.read(session.options.actingSubject!)).version !== listing.version) {
        throw new WorkReadMoved('Agent listing changed');
      }
    } };
}

export async function readMyContributions(session: WorkReadSession) {
  const basis = await libraryBasis(session, 'contributions');
  const rows = await session.query(`SELECT ?id ?work ?revision ?language ?disclosure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?id a rv:TextContribution ; rv:author ${iri(basis.actor)} ;
      rv:work ?work ; rv:draftHead ?revision ; rv:language ?language .
      FILTER NOT EXISTS { ?id rv:protectionHead ?protection }
      OPTIONAL { ?id rv:publicationHead ?publication . GRAPH ${iri(GRAPHS.revisions)} {
        ?publication a rv:PublicationDecision ; rv:component ?id ; rv:disclosure ?disclosure . } } }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ?id .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    ${unerased('?work')}
    FILTER(STR(?id) > ${lit(basis.after)}) } ORDER BY STR(?id) LIMIT ${basis.limit + 1}`, basis.limit + 1);
  if (new Set(rows.map(row => field(row, 'id'))).size !== rows.length) throw new WorkReadUnavailable('Ambiguous contributions');
  const admitted = [];
  for (const row of rows.slice(0, basis.limit)) {
    if (await session.deps.access.canReadContributionDraft(basis.principal, basis.actor, field(row, 'id'))) admitted.push(row);
  }
  const cards = await shelfWorks(session, admitted.map(row => field(row, 'work')));
  const items: Static<typeof libraryContribution>[] = [];
  for (const row of admitted) {
    if (!await session.deps.access.canReadContributionDraft(basis.principal, basis.actor, field(row, 'id'))) {
      throw new WorkReadMoved('Contribution authority changed');
    }
    const disclosure = row.disclosure?.value;
    if (disclosure && ![`${RV}Public`, `${RV}Private`].includes(disclosure)) throw new WorkReadUnavailable('Invalid publication');
    items.push({ id: field(row, 'id'), revision: field(row, 'revision'),
      work: cards.get(field(row, 'work')) ?? null, language: field(row, 'language'),
      publication: disclosure === `${RV}Public` ? 'public' : disclosure === `${RV}Private` ? 'private' : 'draft' });
  }
  await basis.fence();
  return { ...pageResult(session, items, nextPage(session, basis.binding, rows.map(row => field(row, 'id')), basis.limit)),
    listing: basis.listing, discovery: basis.discovery };
}

export async function readMyRatings(session: WorkReadSession) {
  const basis = await libraryBasis(session, 'ratings');
  const heads = await basis.access.ratings(basis.principalId, basis.after, basis.limit + 1);
  const page = heads.slice(0, basis.limit);
  const items: Static<typeof libraryRating>[] = [];
  const admitted = [];
  const budget = { bytesLeft: 512 * 1024, signal: AbortSignal.timeout(5_000) };
  for (const head of page) {
    // Read another Agent's rating slot only when it belongs to this same Account
    // principal; no public Agent→principal lookup is exposed.
    if (head.slot !== standingRatingSlotIri(basis.principalId, head.context, head.mainVersion)) {
      throw new WorkReadUnavailable('Rating slot is not owned by this principal');
    }
    if (!await session.deps.access.canReadStandingRating(basis.principal, basis.actor, head.context)) continue;
    const rows = await session.query(`SELECT ?value ?availability ?manifest ?predecessor ?erased WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${globalContextPattern(head.context)} ; rv:head ${iri(head.contextRevision)} .
        ${iri(head.id)} a rv:GlobalRatingObservation ; rv:ratingContext ${iri(head.context)} ;
          rv:targetMainVersion ${iri(head.mainVersion)} ; rv:ratingSlot ${iri(head.slot)} ;
          rv:observationHead ${iri(head.revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(head.revision)} a rv:GlobalRatingObservationRevision ;
        rv:component ${iri(head.id)} ; rv:manifest ?manifest ; rv:ratingAvailability ?availability ;
        rv:dataEpoch ${lit(head.epoch)} ; rv:sequence ${head.sequence} .
        OPTIONAL { ${iri(head.revision)} rv:ratingValue ?value }
        OPTIONAL { ${iri(head.revision)} rv:predecessor ?predecessor } }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(head.receipt)} rv:outcome rv:Succeeded ;
        rv:ratingObservation ${iri(head.id)} ; rv:observationRevision ${iri(head.revision)} ;
        rv:requestDigest ${lit(head.digest)} . }
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head.revision)} a rv:ErasedRevision } }
        || NOT EXISTS { ${unerased(iri(head.work))} } AS ?erased)
    } LIMIT 2`, 2);
    if (rows.length !== 1) throw new WorkReadUnavailable('Rating graph differs from its sealed inventory');
    const row = rows[0]!;
    if (field(row, 'erased') === 'true') continue;
    const availability: 'available' | 'withdrawn' | null = field(row, 'availability') === `${RV}Available` ? 'available'
      : field(row, 'availability') === `${RV}Withdrawn` ? 'withdrawn' : null;
    const value = row.value ? Number(row.value.value) : null;
    if (!availability || (availability === 'available' && (!Number.isInteger(value) || value! < 1 || value! > 5))
      || (availability === 'withdrawn' && value !== null)) throw new WorkReadUnavailable('Invalid rating value');
    const state = readComponentState(session.deps.environment.objectDirectory, field(row, 'manifest'),
      head.id, GLOBAL_OBSERVATION_PROFILE, budget);
    if (state.revision !== head.revision || state.work !== head.work || state.mainVersion !== head.mainVersion
      || state.context !== head.context || state.contextRevision !== head.contextRevision
      || state.slot !== head.slot || state.value !== value
      || state.availability !== availability || state.predecessor !== (row.predecessor?.value ?? null)
      || globalRatingDigest({ context: head.context, work: head.work, mainVersion: head.mainVersion,
        value, expectedRevisionHead: row.predecessor?.value ?? null, actingSubject: head.actingSubject }) !== head.digest) {
      throw new WorkReadUnavailable('Rating manifest differs from its receipt');
    }
    admitted.push({ head, value, availability: availability as 'available' | 'withdrawn' });
  }
  const cards = await shelfWorks(session, admitted.map(item => item.head.work));
  for (const { head, value, availability } of admitted) {
    if (!await session.deps.access.canReadStandingRating(basis.principal, basis.actor, head.context)) {
      throw new WorkReadMoved('Rating authority changed');
    }
    items.push({ id: head.id, revision: head.revision, context: head.context, mainVersion: head.mainVersion,
      work: cards.get(head.work) ?? null, scope: 'global', value, availability,
      scale: { min: 1, max: 5, step: 1 } });
  }
  if (JSON.stringify(heads) !== JSON.stringify(await basis.access.ratings(basis.principalId, basis.after, basis.limit + 1))) {
    throw new WorkReadMoved('Rating inventory changed');
  }
  await basis.fence();
  return { ...pageResult(session, items, nextPage(session, basis.binding, heads.map(head => head.id), basis.limit)),
    listing: basis.listing, discovery: basis.discovery };
}
