const secretKeys = String.raw`(?:access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|oauth[-_]?token|identity[-_]?token|xsts[-_]?token|session[-_]?token|client[-_]?secret|device[-_]?code|(?:x[-_])?api[-_]?key|token|password|passwd)`;
const quotedOrToken = String.raw`(?:\[redacted\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,"'}\]&;]+)`;
const args = new RegExp(
  String.raw`(--${secretKeys}(?:["']?[ \t]*,[ \t]*|[ \t]*=[ \t]*|[ \t]+))${quotedOrToken}`,
  'giu',
);
const fields = new RegExp(String.raw`((?:^|[\s,{?&])["']?${secretKeys}["']?[ \t]*[:=][ \t]*)${quotedOrToken}`, 'giu');
const privateHeaders =
  /(\b(?:authorization|proxy-authorization|set-cookie|cookie)["']?[ \t]*:[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/giu;
const awaitingValue = new RegExp(
  String.raw`(?:["']?${secretKeys}["']?[ \t]*[:=][ \t]*|--${secretKeys}[ \t]*|\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?[ \t]*:[ \t]*(?:bearer|basic)?[ \t]*)["']?$`,
  'iu',
);
const authSchemes = /(\b(?:Bearer|Basic)[ \t]+)[\da-z._~+/\-]{6,}={0,2}|\bXBL3\.0[ \t]+x=[^\s;]+;[^\s"',}\]]+/giu;
const authJwt = /\beyJ[\w-]{5,}\.[\w-]+\.[\w-]+\b/gu;
const copyIdentityArgs = new RegExp(
  String.raw`(--(?:uuid|xuid|username|playerName)(?:["']?[ \t]*,[ \t]*|[ \t]*=[ \t]*|[ \t]+))${quotedOrToken}`,
  'giu',
);

function visible(line: string) {
  return line
    .replace(/\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '');
}

/** One per stream, so a split authentication field cannot put its value in the next displayed line. */
export function credentialRedactor(secret?: string) {
  const known = secret
    ? [...new Set([secret, encodeURIComponent(secret.toWellFormed()), JSON.stringify(secret).slice(1, -1)])]
    : [];
  let continuation = false;
  return (line: string): string => {
    let value = visible(line);
    if (continuation) {
      if (!value.trim()) return '';
      continuation = false;
      return '[redacted]';
    }
    continuation = awaitingValue.test(value);
    for (const token of known) value = value.replaceAll(token, '[redacted]');
    return value
      .replace(privateHeaders, '$1[redacted]')
      .replace(args, '$1[redacted]')
      .replace(fields, '$1[redacted]')
      .replace(authSchemes, (_match, scheme: string | undefined) => `${scheme ?? 'XBL3.0 '}[redacted]`)
      .replace(authJwt, '[redacted]');
  };
}

export function redactLogText(text: string) {
  const redact = credentialRedactor();
  return text.split('\n').map(redact).join('\n');
}

function literal(value: string) {
  return value.replace(/[.*+?^\x24{}()|[\]\\]/gu, '\\$&');
}

export function redactDiagnosticCopy(text: string, privatePaths: readonly string[]) {
  let value = redactLogText(text).replace(copyIdentityArgs, '$1[redacted]');
  const paths = new Set<string>();
  for (const path of privatePaths) {
    if (path.length <= 3) continue;
    paths.add(path);
    paths.add(path.replaceAll('\\', '/'));
    paths.add(path.replaceAll('\\', '\\\\'));
  }
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    const fullPath = new RegExp(String.raw`(?:file:\/\/)?${literal(path)}[^\r\n"'<>;,|)\]]*`, 'giu');
    value = value.replace(fullPath, '[private path]');
  }
  return value
    .replace(/\bfile:\/{2,3}[^\r\n"'<>;,|)\]]+/giu, '[private path]')
    .replace(/(?<!\w)(?:[a-z]:[\\/]|\\{2,4}(?=[\da-z.?]))[^\r\n"'<>;,|)\]]+/giu, '[private path]')
    .replace(/(^|[\s("'=,\[])\/(?!\/)[^\r\n"'<>;,|)\]]+/gmu, '$1[private path]')
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]+/giu, '$1?[redacted]')
    .replace(/[\w.+-]+@[\da-z-]+(?:\.[\da-z-]+)+/giu, '[redacted]');
}
