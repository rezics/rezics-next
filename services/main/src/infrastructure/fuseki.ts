export interface SparqlResult {
  boolean?: boolean;
  results?: { bindings: Record<string, { type: string; value: string; datatype?: string }>[] };
}

export class FusekiClient {
  private readonly baseUrl: URL;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Fuseki URL must be HTTP(S)');
    }
    parsed.pathname = parsed.pathname.replace(/\/*$/, '/');
    this.baseUrl = parsed;
  }

  async query(sparql: string): Promise<SparqlResult> {
    const response = await fetch(new URL('query', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
      },
      body: sparql,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Fuseki query returned ${response.status}`);
    return response.json() as Promise<SparqlResult>;
  }

  async update(sparql: string): Promise<void> {
    const response = await fetch(new URL('update', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: sparql,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Fuseki update returned ${response.status}`);
  }
}
