import { expect, test } from 'bun:test';
import { MCP_COST } from '../src/modules/mcp/capabilities.ts';
import { mcpBody, LIBRARY_IMPORT_MCP_BYTES } from '../src/modules/mcp/body.ts';

test('G-854 review: only the actual library upload tool receives the larger MCP body budget', async () => {
  expect(MCP_COST.maxRequestBytes).toBe(1_048_576);
  const request = (name: string,hint?: string) => new Request('http://main.local/mcp',{ method: 'POST',headers: {
    'mcp-method': 'tools/call',...(hint ? { 'mcp-name': hint } : {}) },body: JSON.stringify({
    method: 'tools/call',params: { name,arguments: { file: 'x'.repeat(MCP_COST.maxRequestBytes) } } }) });
  const uploaded = await mcpBody(request('library_import_create','library_import_create'));
  expect(uploaded).toBeInstanceOf(Uint8Array);
  expect((await mcpBody(request('library_export'))) as Response).toHaveProperty('status',413);
  expect((await mcpBody(request('library_export','library_import_create'))) as Response).toHaveProperty('status',413);
  expect((await mcpBody(new Request('http://main.local/mcp',{ method: 'POST',headers: {
    'mcp-method': 'tools/call','mcp-name': 'library_import_create' },body: 'x'.repeat(LIBRARY_IMPORT_MCP_BYTES+1) }))) as Response)
    .toHaveProperty('status',413);
});
