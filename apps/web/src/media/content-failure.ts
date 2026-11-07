import { MediaProblem } from './kernel';

export type ContentMediaFailure = {
  status: number;
  problem: { type: string; title: string; status: number; code: string };
  headers?: HeadersInit;
};

/** Project the Content-owned error into data without exposing its class across a module boundary. */
export function contentMediaFailure(error: unknown): ContentMediaFailure | undefined {
  if (!(error instanceof MediaProblem)) return undefined;
  return {
    status: error.problem.status,
    problem: error.problem,
    ...(error.headers === undefined ? {} : { headers: error.headers }),
  };
}
