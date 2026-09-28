/** Where a published skill file is installed for the agents people actually use. */
export function skillName(content: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
  const name = /^name:\s*(\S+)/m.exec(front)?.[1];
  return name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : 'skill';
}

export function skillInstallPath(agent: 'claude' | 'cursor' | 'codex', content: string): string {
  const name = skillName(content);
  if (agent === 'claude') return `~/.claude/skills/${name}/SKILL.md`;
  if (agent === 'cursor') return `.cursor/skills/${name}/SKILL.md`;
  return `.agents/skills/${name}/SKILL.md`;
}

/** The file, plus the path that agent reads, so Install copies something that can be saved. */
export function skillInstallText(agent: 'claude' | 'cursor' | 'codex', content: string): string {
  return `Save as ${skillInstallPath(agent, content)}\n\n${content}`;
}

export interface PromptRequirement { name: string; description?: string; required: boolean }

export function promptRequirements(schema: Record<string, unknown>): PromptRequirement[] {
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown> : {};
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string') : []);
  return Object.entries(properties).map(([name, definition]) => {
    const field = definition && typeof definition === 'object' && !Array.isArray(definition)
      ? definition as Record<string, unknown> : {};
    return { name, ...(typeof field.description === 'string' ? { description: field.description } : {}),
      required: required.has(name) };
  });
}

function section(content: string, heading: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return new RegExp(`(?:^|\\n)## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`).exec(body)?.[1]?.trim() ?? '';
}

/** Lines under a `## Requirements` heading in SKILL.md. */
export function skillRequirements(content: string): string[] {
  return section(content, 'Requirements').split('\n').map(line => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
}

/** Bodies under `## Example` headings in SKILL.md. */
export function skillExamples(content: string): string[] {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return [...body.matchAll(/(?:^|\n)## Example(?: \d+)?\n([\s\S]*?)(?=\n## |\n# |$)/g)]
    .map(match => match[1]?.trim() ?? '').filter(Boolean);
}
