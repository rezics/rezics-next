/** The subset of the Workers runtime this site touches. */
export interface D1Database {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface AboutEnv {
  ASSETS: Fetcher;
  DB: D1Database;
}
