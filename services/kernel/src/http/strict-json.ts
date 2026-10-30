/** Native syntax/decoding with an iterative guard over the still-available member names. */
export function parseStrictJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // Native parsing has established the grammar. Only object scopes and string boundaries
  // are needed here: in valid JSON, a string followed by a colon is a member name.
  // Sets keep prototype-sensitive names as data; arrays carry no member-name scope.
  const scopes: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '{') scopes.push(new Set());
    else if (character === '[') scopes.push(null);
    else if (character === '}' || character === ']') scopes.pop();
    else if (character === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (text[next] === ' ' || text[next] === '\t' || text[next] === '\r' || text[next] === '\n') next++;
      if (text[next] !== ':') continue;
      // Decode each member exactly as native JSON does, including UTF-16 surrogates.
      // Member slices are disjoint, so their total parsing work is bounded by text length.
      const name: string = JSON.parse(text.slice(start, i + 1));
      const names = scopes[scopes.length - 1]!;
      if (names.has(name)) throw new SyntaxError('Duplicate JSON member name');
      names.add(name);
    }
  }
  return value;
}
