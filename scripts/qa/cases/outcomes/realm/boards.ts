import { proved, rowOutcomes } from '../../outcome-cells.ts';

const collectionGap = 'GET /v1/classification-vocabulary?context=<Realm classification context>&limit=1 returns 400 invalid_request; expected 200 bounded selected Concepts with continuation. GET /v1/realms/{realm}/threads?concept=<Concept>&sort=new&limit=1 returns 400 invalid_request; expected a board-filtered page (empty board: items [], count 0).';
const placementGap = 'POST /v1/realm-reply-placements with concepts and primaryConcept returns 400 invalid_request';
const lifecycleGap = 'POST /v1/classification-vocabulary with concept {id, expectedHead} and state=retired returns 400 invalid_request; expected retirement of that Concept. GET /v1/realms/{realm}/threads?concept=<retirement candidate>&sort=new&limit=1 returns 400 invalid_request; expected a gone board after retirement (retirement is currently blocked).';
const scopeGap = 'Owner POST /v1/realms/{realm}/role-impact with change.targetScope={kind:concept,id:<Concept>} returns 400 invalid_request; expected 200 before assigning a bounded jurisdiction or mandate.';

export default rowOutcomes('realm/boards', {
  visitor: proved(`${collectionGap} ${placementGap}; expected 401 for the signed-out mutation. ${lifecycleGap}`),
  stranger: proved(`${collectionGap} ${placementGap}; expected 403 without Realm authority. ${lifecycleGap}`),
  member: proved(`${collectionGap} ${placementGap}; expected 200/201 for the author where allowed, 403 for another author's conversation. ${lifecycleGap}`),
  owner: proved(`${collectionGap} ${placementGap}; expected 200/201 for Realm placement management. ${lifecycleGap}`),
  moderator: proved(`${collectionGap} ${placementGap}; expected 200/201 inside the assigned Realm moderation jurisdiction. ${scopeGap} ${lifecycleGap}`),
  operator: proved(`${collectionGap} ${placementGap}; expected 403 without a board mandate, 200/201 only under a bounded Realm/Concept/action mandate. ${scopeGap} ${lifecycleGap}`),
});
