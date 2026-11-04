/** An overview focus address identifies an assertion; it never authorizes disclosure or a native cursor. */
export type WorkFranchiseReturn = {
  stream: string;
  statement: string;
  holder: string;
  spoiler: number;
};

export function workFranchiseReturn(hash: string): WorkFranchiseReturn | undefined {
  if (!hash.startsWith('#work-franchise?') || hash.length > 1024) return;
  const params = new URLSearchParams(hash.slice('#work-franchise?'.length));
  const keys = [...params.keys()];
  if (
    keys.length !== 4 ||
    new Set(keys).size !== 4 ||
    keys.some((key) => !['stream', 'statement', 'holder', 'spoiler'].includes(key))
  )
    return;
  const stream = params.get('stream');
  const statement = params.get('statement');
  const holder = params.get('holder');
  const spoiler = params.get('spoiler');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !stream ||
    !/^(in|out):[^\s\u0000-\u001f\u007f]{1,256}$/u.test(stream) ||
    !statement ||
    !uuid.test(statement) ||
    !holder ||
    !uuid.test(holder) ||
    !/^[012]$/.test(spoiler ?? '')
  )
    return;
  return { stream, statement, holder, spoiler: Number(spoiler) };
}

export function workFranchiseFragment(value: WorkFranchiseReturn): string {
  const hash = `#work-franchise?${new URLSearchParams({ ...value, spoiler: String(value.spoiler) })}`;
  return workFranchiseReturn(hash) ? hash : '#connections';
}
