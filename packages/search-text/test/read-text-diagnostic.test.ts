import { expect, test } from 'bun:test';
import { diagnoseText, readTextDiagnostic, TEXT_LIMITS, type TextDiagnostic } from '../src/index.ts';

function admitted(input: string): TextDiagnostic {
  const diagnostic = diagnoseText(input);
  expect(diagnostic, input).toBeDefined();
  expect(readTextDiagnostic(diagnostic)).toEqual(diagnostic);
  return diagnostic!;
}

test('parser diagnostics stay admissible, including escapes and the byte ceiling', () => {
  const emoji = '😀';
  expect(admitted(`\\${emoji}`)).toMatchObject({
    reason: 'unsupported_escape',
    start: 0,
    end: 3,
    codePointStart: 0,
    codePointEnd: 2,
    byteOffset: 0,
  });
  expect(admitted(`${emoji} \\界`)).toMatchObject({
    reason: 'unsupported_escape',
    start: 3,
    end: 5,
    codePointStart: 2,
    codePointEnd: 4,
    byteOffset: 5,
  });
  expect(admitted(`${emoji.repeat(127)}\\${emoji}`)).toMatchObject({
    reason: 'unsupported_escape',
    start: 254,
    end: 257,
    codePointStart: 127,
    codePointEnd: 129,
    byteOffset: 508,
  });
  expect(admitted(`${'a'.repeat(TEXT_LIMITS.bytes - 1)}\\${emoji}`)).toMatchObject({
    reason: 'unsupported_escape',
    start: 511,
    end: 514,
    codePointStart: 511,
    codePointEnd: 513,
    byteOffset: 511,
  });
  expect(admitted(emoji.repeat(129))).toMatchObject({
    reason: 'byte_limit',
    start: 256,
    end: 258,
    codePointStart: 128,
    codePointEnd: 129,
    byteOffset: 512,
  });
  expect(admitted(`${'a'.repeat(TEXT_LIMITS.bytes)}${emoji}`)).toMatchObject({
    reason: 'byte_limit',
    start: 512,
    end: 514,
    codePointStart: 512,
    codePointEnd: 513,
    byteOffset: 512,
  });
  expect(admitted('界'.repeat(171))).toMatchObject({
    reason: 'byte_limit',
    start: 170,
    end: 171,
    codePointStart: 170,
    codePointEnd: 171,
    byteOffset: 510,
  });
  expect(admitted('\u07ff'.repeat(257))).toMatchObject({
    reason: 'byte_limit',
    start: 256,
    end: 257,
    byteOffset: 512,
  });
  const terms = Array.from({ length: TEXT_LIMITS.leaves + 1 }, (_, index) => `t${index}`).join(' ');
  for (const input of [
    '',
    '   ',
    '心 |',
    'a)',
    '(a',
    '"unclosed',
    '""',
    '-',
    '\\x',
    'a\\',
    '"\\a"',
    '(((((',
    terms,
    `"${'字'.repeat(TEXT_LIMITS.phraseTokens + 1)}"`,
    `${emoji} 心 "こころ`,
  ]) {
    admitted(input);
  }
});

test('readTextDiagnostic rejects coordinates the parser cannot emit', () => {
  const diagnostic = {
    reason: 'byte_limit' as const,
    unit: 'utf16' as const,
    start: 1,
    end: 2,
    codePointStart: 1,
    codePointEnd: 2,
    byteOffset: 1,
  };
  expect(readTextDiagnostic({ ...diagnostic, codePointStart: 2, codePointEnd: 3 })).toBeUndefined();
  expect(readTextDiagnostic({ ...diagnostic, start: 3, codePointStart: 1, byteOffset: 3 })).toBeUndefined();
  expect(
    readTextDiagnostic({ ...diagnostic, start: 0, end: 3, codePointStart: 0, codePointEnd: 1, byteOffset: 0 }),
  ).toBeUndefined();
  expect(
    readTextDiagnostic({ ...diagnostic, start: 2, end: 4, codePointStart: 1, codePointEnd: 2, byteOffset: 3 }),
  ).toBeUndefined();
  expect(
    readTextDiagnostic({
      ...diagnostic,
      reason: 'unsupported_escape',
      start: 511,
      end: 513,
      codePointStart: 511,
      codePointEnd: 513,
      byteOffset: TEXT_LIMITS.bytes,
    }),
  ).toBeUndefined();
  expect(readTextDiagnostic(diagnostic)).toEqual(diagnostic);
});
