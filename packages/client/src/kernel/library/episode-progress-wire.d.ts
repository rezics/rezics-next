/** Wire contract for the installed native canonical checklist methods. */
export type EpisodeCompletion = {
    episodeSubjectId: string | null;
    completed: boolean | null;
    membership: 'member' | 'detached' | 'unavailable';
    ordinal: string | null;
};
export type EpisodeProgressView = { revision: number; episodes: EpisodeCompletion[]; next: string | null };
type Problem = Response | {
    type: unknown;
    title: unknown;
    status: number;
    code: unknown;
    retryable: unknown;
    effect_status: 'not_applicable' | 'not_applied';
    request_id: string;
    detail: unknown;
    errors: unknown;
};
type Errors = { 400: Problem; 401: Problem; 403: Problem; 404: Problem; 409: Problem; 503: Problem };
export type EpisodeProgressWireRoutes = {
    v1: {
        progressSessions: {
            ':sessionId': {
                episodes: {
                    get: {
                        body: unknown;
                        params: { sessionId: string };
                        query: { ids?: string; cursor?: string; limit?: string | number };
                        headers: unknown;
                        response: { 200: EpisodeProgressView } & Errors;
                        error: never;
                    };
                };
                $recordEpisodes: {
                    post: {
                        body: { revision: number; clear?: true; add?: string[]; remove?: string[] };
                        params: { sessionId: string };
                        query: unknown;
                        headers: { 'idempotency-key': string };
                        response: { 200: { revision: number }; 422: Problem } & Errors;
                        error: never;
                    };
                };
            };
        };
    };
};
