/** Installed GET /v1/zones/{id}/subjects while whole-Kernel declaration emission is pending.
 * Kernel `zones/http.ts` remains the wire authority. No runtime client is replaced.
 */
export type ZoneSubjectListItem = {
    id: string;
    type: string;
    labels: Record<string, string>;
    summary: unknown;
};
export type ZoneSubjectListPage = {
    subjects: ZoneSubjectListItem[];
    next: string | null;
};
export type ZoneSubjectListProgress = {
    next: string;
};
export type ZoneSubjectListQuery = {
    limit?: string;
    cursor?: string;
};
export type ZoneSubjectListRoutes = {
    ':id': {
        subjects: {
            get: {
                body: unknown;
                params: {
                    id: string;
                };
                query: ZoneSubjectListQuery;
                headers: unknown;
                response: {
                    200: ZoneSubjectListPage;
                    202: ZoneSubjectListProgress;
                    400: unknown;
                    401: unknown;
                    403: unknown;
                    404: unknown;
                    409: unknown;
                    503: unknown;
                };
            };
        };
    };
};
