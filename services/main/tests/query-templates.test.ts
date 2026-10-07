import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  CommandForbidden,
  FusekiClient,
  FusekiQueryResponseTooLarge,
  FusekiReadBudgetExceeded,
  fusekiReadBudget,
  type TemplateQueryEnvelope,
} from '../src/infrastructure/fuseki.ts';

const capability = 'a'.repeat(64);
const client = () => new FusekiClient('http://fuseki.invalid/rezics', undefined, capability);
const envelope = (): TemplateQueryEnvelope => ({
  query: 'SELECT ?id WHERE { GRAPH <urn:rezics:graph:current> { ?id <urn:label> ?_label } }',
  bindings: { _label: { type: 'literal', value: '名字 " } UNION { ?s ?p ?o } #', language: 'zh' } },
  tables: [],
  limit: 21,
});
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
afterEach(() => {
  fetchMock?.mockRestore();
  fetchMock = undefined;
});
const respond = (response: Response) => {
  fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(response);
  return fetchMock;
};

describe('Native template term transport', () => {
  test('sends RDF terms and server tuples without interpolating the reviewed query', async () => {
    const input = envelope();
    input.tables = [
      {
        columns: ['sourceId', 'sourceKey'],
        rows: [
          [
            { type: 'uri', value: 'urn:source:one' },
            { type: 'literal', value: 'OL1A' },
          ],
        ],
      },
    ];
    const result = { results: { bindings: [{ id: { type: 'uri', value: 'urn:item:one' } }] } };
    const fetch = respond(Response.json(result));
    expect(await client().templateQuery(input)).toEqual(result);
    const [url, request] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('http://fuseki.invalid/rezics/command');
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${capability}`);
    expect(JSON.parse(String(request?.body))).toEqual({ templateQuery: input });
    expect(input.query).not.toContain(input.bindings._label!.value);
  });

  test('requires the Main capability and propagates native capability refusal', async () => {
    const fetch = respond(new Response(null, { status: 403 }));
    await expect(
      new FusekiClient('http://fuseki.invalid', undefined, '').templateQuery(envelope()),
    ).rejects.toThrow('capability is required');
    expect(fetch).not.toHaveBeenCalled();
    await expect(client().templateQuery(envelope())).rejects.toBeInstanceOf(CommandForbidden);
  });

  test('enforces page lookahead and tuple budgets before transport', async () => {
    const fetch = respond(Response.json({ results: { bindings: [] } }));
    for (const limit of [0, 66, 1.5, NaN]) {
      await expect(client().templateQuery({ ...envelope(), limit })).rejects.toThrow('budget');
    }
    const table = {
      columns: ['id'],
      rows: Array.from({ length: 257 }, (_, index) => [
        { type: 'uri' as const, value: `urn:item:${index}` },
      ]),
    };
    await expect(client().templateQuery({ ...envelope(), tables: [table] })).rejects.toThrow(
      'budget',
    );
    expect(fetch).not.toHaveBeenCalled();
    table.rows.pop();
    await client().templateQuery({ ...envelope(), limit: 65, tables: [table] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('shares the enclosing call, byte and deadline budgets', async () => {
    const result = { results: { bindings: [] } };
    const fetch = respond(Response.json(result));
    const controller = new AbortController();
    const budget = { signal: controller.signal, callsLeft: 1, bytesLeft: 1024 };
    await fusekiReadBudget.run(budget, async () => {
      expect(await client().templateQuery(envelope())).toEqual(result);
      expect(budget.callsLeft).toBe(0);
      expect(budget.bytesLeft).toBe(1024 - Buffer.byteLength(JSON.stringify(result)));
      await expect(client().templateQuery(envelope())).rejects.toBeInstanceOf(
        FusekiReadBudgetExceeded,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0]![1]!.signal!;
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  test('bounds request and streamed response bytes', async () => {
    const fetch = respond(new Response('x'.repeat(1025)));
    const input = envelope();
    input.bindings._label!.value = 'x'.repeat(512 * 1024);
    await expect(client().templateQuery(input)).rejects.toThrow('request byte budget');
    expect(fetch).not.toHaveBeenCalled();
    await expect(client().templateQuery(envelope(), 1024)).rejects.toBeInstanceOf(
      FusekiQueryResponseTooLarge,
    );
  });
});
