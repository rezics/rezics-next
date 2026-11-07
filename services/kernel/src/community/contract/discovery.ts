export function discoveryDescription(summary: string): string {
  return Array.from(summary.replace(/\s+/gu, ' ').trim()).slice(0, 160).join('');
}
