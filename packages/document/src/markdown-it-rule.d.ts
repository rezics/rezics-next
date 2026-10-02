// SPDX-License-Identifier: Apache-2.0
// markdown-it exports its built-in rule modules; DefinitelyTyped only declares the rule API.
declare module 'markdown-it/lib/rules_block/blockquote.mjs' {
  import type { RuleBlock } from 'markdown-it/lib/parser_block.mjs';
  const blockquote: RuleBlock;
  export default blockquote;
}
