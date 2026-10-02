/** GreptimeDB success responses omit `code`; errors can carry it even on HTTP 200. */
export async function greptimeRows(response: Response): Promise<unknown[][] | undefined> {
  const data = (await response.json()) as {
    code?: number;
    output?: { records?: { rows: unknown[][] } }[];
  };
  if (!response.ok || (data.code !== undefined && data.code !== 0))
    throw new Error('Greptime SQL failed');
  return data.output?.[0]?.records?.rows;
}
