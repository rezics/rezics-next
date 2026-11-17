export const mountedSubjectReadHeader = 'x-rezics-dev-subject-read';

const routes = {
  subject: 'GET /v1/subjects/:id',
  page: 'POST /v1/pages:read',
  links: 'GET /v1/subjects/:id/links',
} as const;

const reasons = [
  'deadline_exceeded',
  'dependency_unavailable',
  'not_found',
  'overloaded',
  'platform_closed',
  'presentation_not_ready',
  'semantic_not_ready',
] as const;

export type MountedSubjectReadStage = keyof typeof routes;
export const mountedSubjectReadLimit = 4;

type NativeRoute = (typeof routes)[MountedSubjectReadStage];
type NativeObservation =
  | { route: NativeRoute; stage: 'transport' }
  | { route: NativeRoute; stage: 'response'; status: number; reason?: (typeof reasons)[number] };

export function mountedSubjectReadReason(value: unknown) {
  return reasons.find((reason) => reason === value);
}

/** The walk only retains known native routes, HTTP statuses and recognized problem codes. */
export function mountedSubjectReads(value: string | null): NativeObservation[] {
  if (!value || value.length > 256) return [];
  return value.split(',', mountedSubjectReadLimit).flatMap<NativeObservation>((entry) => {
    const [stage, code, detail, extra] = entry.trim().split(' ');
    if (!stage || !Object.hasOwn(routes, stage) || extra !== undefined) return [];
    const route = routes[stage as MountedSubjectReadStage];
    if (code === 'transport' && detail === undefined) return [{ route, stage: 'transport' }];
    if (!code || !/^[1-5][0-9]{2}$/.test(code)) return [];
    const reason = mountedSubjectReadReason(detail);
    if (detail !== undefined && reason === undefined) return [];
    return [{ route, stage: 'response', status: Number(code), ...(reason ? { reason } : {}) }];
  });
}
