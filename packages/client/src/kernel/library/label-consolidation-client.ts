type Identity = { id: string; revision: number };
type Selection = { subjectId: string; assignmentId: string; revision: number };
type Assignment = Identity & { effective: boolean };
type Problem = Response | {
  type: unknown;
  title: unknown;
  status: number;
  code: unknown;
  retryable: unknown;
  effect_status: 'not_applicable' | 'not_applied';
  request_id: string;
  detail?: unknown;
  errors?: unknown;
};
type Failures = { 400: Problem; 401: Problem; 403: Problem; 404: Problem; 409: Problem; 422: Problem; 503: Problem };
type Mutation<Body, Success, Status extends 200 | 201 = 200> = {
  post: {
    body: Body;
    params: { id: string };
    query: unknown;
    headers: { 'idempotency-key': string };
    response: (Status extends 201 ? { 201: Success } : { 200: Success }) & Failures;
    error: never;
  };
};
type Result = {
  confirmationId: string;
  sourceLabelId: string;
  targetLabelId: string;
  status: 'active' | 'completed' | 'cancelled';
  expiresAt: string;
  items: {
    item: number;
    selected?: Selection;
    status: 'pending' | 'processing' | 'moved' | 'target_applied_source_retained' | 'capacity_limited' | 'changed' | 'inaccessible';
    targetAssignment?: Identity;
    targetUnchanged?: boolean;
    sourceUnassignRevision?: number;
  }[];
};
type Review = {
  selection: string;
  sourceLabel: Identity & { name: string };
  targetLabel: Identity & { name: string };
  items: {
    selected: Selection;
    source: Assignment | null;
    target: Assignment | null;
    outcome: 'movable' | 'already_on_target' | 'missing' | 'changed' | 'inaccessible' | 'capacity_limited';
  }[];
  next: string | null;
};

/** Typed consolidation endpoints added to the client route tree. */
export type LabelConsolidationClientRoutes = {
  ':id': {
    $reviewConsolidation: {
      post: {
        body: { targetLabelId: string; items: Selection[]; limit?: number; cursor?: string };
        params: { id: string };
        query: unknown;
        headers: unknown;
        response: { 200: Review } & Failures;
        error: never;
      };
    };
    $confirmConsolidation: Mutation<{
      selection: string;
      sourceLabel: Identity & { name: string };
      targetLabel: Identity & { name: string };
      items: { selected: Selection; source: Assignment; target: Assignment | null; outcome: 'movable' | 'already_on_target' }[];
    }, { confirmationId: string; expiresAt: string; status: 'active'; itemCount: number }, 201>;
    $applyConsolidation: Mutation<{ confirmationId: string }, Result>;
    $retryConsolidation: Mutation<{ confirmationId: string; item: number }, Result>;
    $cancelConsolidation: Mutation<{ confirmationId: string }, Result>;
    consolidations: {
      ':confirmationId': {
        get: {
          body: unknown;
          params: { id: string; confirmationId: string };
          query: unknown;
          headers: unknown;
          response: { 200: Result } & Failures;
          error: never;
        };
      };
    };
  };
};
