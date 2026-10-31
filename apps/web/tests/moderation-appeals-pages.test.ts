import { expect, test } from 'bun:test';

const source = await Bun.file(new URL('../src/stories/moderation-appeals.stories.tsx', import.meta.url)).text();

// Guard story composition here; the canonical plays exercise the real localized DOM at integration.
test('Canonical pending and empty appeal Page stories use the existing shell and one main while retaining native response details and meaningful localized keyboard focus assertions', () => {
  expect([...source.matchAll(/export const (\w+)/g)].map((match) => match[1])).toEqual(['Pending', 'Empty']);
  expect(source).toContain("title: 'Pages/Moderation appeals'");
  expect(source).toContain('component: ModerationAppealsView');
  expect(source).toMatch(
    /<PatternStory\b[^>]*>\s*<AppShell>\s*<Story\s*\/>\s*<\/AppShell>\s*<\/PatternStory>/,
  );
  expect(source).not.toMatch(/<main\b|\b(?:globals|defaultViewport|viewports)\s*:/);
  expect(source).toContain("canvas.findByRole('main')");
  expect(source).toContain("canvas.getByRole('heading', { level: 1 })");

  expect(source).toContain(`const pendingAppeal = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  appellantId: '0192f3a0-6c1e-7b2a-9d4e-000000000005',
  statement: 'I did not intend to share identifying information. Please review the decision independently.',
  createdAt: '2026-10-30T01:00:00.000Z',
  decision: {
    statement: 'The reply is withheld while its personal information is reviewed.',
    target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  },
  canResolve: true,
} satisfies Appeal;`);
  expect(source).toContain('key: `post:${pendingAppeal.decision.target.id}`');
  expect(source).toMatch(
    /const withheldTarget: ModerationTarget = \{\s*key: `post:\$\{pendingAppeal\.decision\.target\.id\}`,\s*kind: 'post',\s*value: null,\s*\};/,
  );

  const pending = source.slice(source.indexOf('export const Pending:'), source.indexOf('export const Empty:'));
  const empty = source.slice(source.indexOf('export const Empty:'));
  expect(pending).toContain('args: { appeals: [pendingAppeal], targets: [withheldTarget] }');
  expect(empty).toContain('args: { appeals: [], targets: [] }');
  expect(empty).toContain('view.getByText(m.moderation_appeals_empty())).toBeVisible()');
  for (const message of ['moderation_reports_tab', 'moderation_statement_label', 'moderation_appeal_uphold_action'])
    expect(pending).toContain(`name: m.${message}()`);

  expect(pending).toMatch(
    /main\.focus\(\);[\s\S]*userEvent\.tab\(\);\s*await expect\(reports\)\.toHaveFocus\(\);\s*await userEvent\.tab\(\);\s*await expect\(statement\)\.toHaveFocus\(\);/,
  );
  expect(pending).toMatch(
    /expect\(uphold\)\.toBeDisabled\(\);\s*await userEvent\.type\(statement, '[^']+'\);[\s\S]*expect\(uphold\)\.toBeEnabled\(\);\s*await userEvent\.tab\(\);\s*await expect\(uphold\)\.toHaveFocus\(\);/,
  );
  expect(pending).not.toMatch(/userEvent\.click|\.disabled\s*=/);
  for (const field of ['decision.statement', 'decision.target.id', 'statement'])
    expect(pending).toContain(`view.getByText(pendingAppeal.${field})).toBeInTheDocument()`);
  expect(pending).toContain("view.getByRole('blockquote').textContent).toBe(m.moderation_target_unavailable())");
});
