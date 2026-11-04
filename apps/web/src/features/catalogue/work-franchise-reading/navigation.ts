/** An overview focus address identifies an assertion; it never authorizes disclosure or a native cursor. */
export type WorkFranchiseReturn = {
  stream: string;
  statement?: string;
  holder?: string;
  node?: string;
  focus?: 'browse' | 'evidence';
  release?: string;
  revision?: number;
  spoiler: number;
};

export function workFranchiseReturn(hash: string): WorkFranchiseReturn | undefined {
  if (!hash.startsWith('#work-franchise?') || hash.length > 1024) return;
  const params = new URLSearchParams(hash.slice('#work-franchise?'.length));
  const keys = [...params.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['stream', 'statement', 'holder', 'spoiler', 'node', 'focus', 'release', 'revision'].includes(key))
  )
    return;
  const stream = params.get('stream');
  const statement = params.get('statement');
  const holder = params.get('holder');
  const spoiler = params.get('spoiler');
  const node = params.get('node');
  const focus = params.get('focus');
  const release = params.get('release');
  const revision = params.get('revision');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !stream ||
    !/^(in|out):[^\s\u0000-\u001f\u007f]{1,256}$/u.test(stream) ||
    ((statement === null) !== (holder === null)) ||
    (statement !== null && !uuid.test(statement)) ||
    (holder !== null && !uuid.test(holder)) ||
    (node !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(node)) ||
    (focus !== null && (!statement || (focus !== 'browse' && focus !== 'evidence'))) ||
    (release !== null && (!release || release.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(release))) ||
    (revision !== null && (!/^[1-9]\d{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision)))) ||
    !/^[012]$/.test(spoiler ?? '')
  )
    return;
  return {
    stream, spoiler: Number(spoiler),
    ...(statement && holder ? { statement, holder } : {}),
    ...(node ? { node } : {}),
    ...(focus ? { focus: focus as 'browse' | 'evidence' } : {}),
    ...(release ? { release } : {}),
    ...(revision ? { revision: Number(revision) } : {}),
  };
}

export function workFranchiseFragment(value: WorkFranchiseReturn): string {
  const params = new URLSearchParams();
  for (const [key, part] of Object.entries(value)) if (part !== undefined) params.set(key, String(part));
  const hash = `#work-franchise?${params}`;
  return workFranchiseReturn(hash) ? hash : '#connections';
}
