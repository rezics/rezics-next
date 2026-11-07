import {
  createFilterConstruction,
  parseFilter,
  walkFilter,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import { posix } from 'node:path';
import { safePattern } from '../pattern-safety.ts';
import { createCompilerApplication, type CompilerApplication, type CompilerHost } from '../compiler/application.ts';

/** Bind Filter admission, POSIX path, YAML parse and isolated pattern evaluation. */
export function createCompilerHost(): CompilerHost {
  return {
    posixJoin: (...parts) => posix.join(...parts),
    posixDirname: (path) => posix.dirname(path),
    posixBasename: (path) => posix.basename(path),
    posixNormalize: (path) => posix.normalize(path),
    posixRelative: (from, to) => posix.relative(from, to),
    yamlParse: (text) => Bun.YAML.parse(text),
    safePattern,
    filterConstruction: (release) => createFilterConstruction(release as FilterRelease),
    parseFilter,
    walkFilter: (document) => walkFilter(document as FilterDocument),
  };
}

let native: CompilerApplication | undefined;

/** Existing compiler, CLI and native root bind this host once per process. Later compilers do not replace it. */
export function nativeCompiler(): CompilerApplication {
  native ??= createCompilerApplication(createCompilerHost());
  return native;
}
