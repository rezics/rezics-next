import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync as fsLstatSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Budget = { path: string; kind: "file" | "directory"; bytes: number };
type BudgetFile = { version: 1; budgets: Budget[] };
type Baseline = { version: 1; entries: { path: string; bytes: number }[] };
type Link = { target: string; line: number };
type ParsedMarkdown = { links: Link[]; anchors: string[] };
type DiffEntry = { status: string; oldPath: string; newPath?: string };
type RunResult = { exitCode: 0 | 1 | 2; lines: string[] };

const BUDGETS_PATH = "docs/budgets.json";
const BASELINE_PATH = "docs/budgets-baseline.json";
const REGISTRY_PATH = "docs/research/registry.json";
const CACHE_PATH = ".cache/docs-check/links";
const RESEARCH_STATES = new Set(["open", "adopted", "rejected"]);
const RESEARCHER_SUFFIXES = [
  "claude-opus-5-5",
  "gpt-6-astra",
  "opus-5-5",
  "sol-xhigh",
  "independent",
  "current",
  "deep",
  "default",
  "xhigh",
  "high",
  "sol",
];

function runGit(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runGitInput(root: string, args: string[], input: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function splitGitPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function parseDiff(root: string, base: string): DiffEntry[] {
  const value = runGit(root, ["diff", "--name-status", "-z", "--find-renames", base, "--"]);
  const parts = splitGitPaths(value);
  const result: DiffEntry[] = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      result.push({ status, oldPath: parts[index++] ?? "", newPath: parts[index++] });
    } else {
      result.push({ status, oldPath: parts[index++] ?? "" });
    }
  }
  return result;
}

function parseGlob(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function matches(pattern: string, file: string): boolean {
  return parseGlob(pattern).test(file);
}

function json<T>(text: string, file: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${String(error)})`);
  }
}

function ownerDocument(file: string): boolean {
  if (file === "AGENTS.md" || file === "docs/architecture.md" || file === "docs/scope.md") return true;
  if (file.startsWith("docs/development/") && file.endsWith(".md")) return true;
  if (file.startsWith("docs/goals/") && file.endsWith(".md")) return true;
  if (file.startsWith("docs/") && file.endsWith(".md") && file.split("/").length === 2) return true;
  if (file === "tools/goal/README.md" || file.startsWith("tools/goal/prompts/")) return true;
  if (/^(apps|packages|services)\/.+\/README\.md$/.test(file)) return true;
  if (/^(apps|packages|services)\/.+\/src\/.+-contract\.md$/.test(file)) return true;
  if (file.startsWith(".agents/skills/") && (file.endsWith("/SKILL.md") || file.includes("/references/"))) return true;
  return false;
}

function extractOwnerViolations(text: string): { rule: string; detail: string }[] {
  const errors: { rule: string; detail: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (/^\s{0,3}#{1,6}\s+.*\b\d{4}-\d{2}-\d{2}\b/.test(line)) {
      errors.push({ rule: "owner-dated-heading", detail: `line ${index + 1} has a dated heading` });
    }
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(line) || /\b(?:TASK|GOAL|TICKET|ISSUE)[-_][A-Z0-9]{4,}(?:-[A-Z0-9]+)*\b/i.test(line)) {
      errors.push({ rule: "owner-task-id", detail: `line ${index + 1} contains a task ID` });
    }
    if (/(?:^|[\s(`'"=])\.temp\//.test(line)) {
      errors.push({ rule: "owner-temp-path", detail: `line ${index + 1} contains a temporary path` });
    }
  }
  return errors;
}

function slugHeading(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, "")
    .replace(/\{#[^}]+\}\s*$/, "")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
    .replace(/\s/g, "-");
}

function parseMarkdown(text: string): ParsedMarkdown {
  const links: Link[] = [];
  const anchors: string[] = [];
  const lines = text.split(/\r?\n/);
  let fence: string | undefined;
  const definitions = new Map<string, { target: string; line: number }>();
  const visibleLines = lines.map((line, index) => {
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open) {
      if (!fence) fence = open[1][0];
      else if (open[1][0] === fence) fence = undefined;
      return "";
    }
    if (fence) return "";
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const explicit = heading[1].match(/\s*\{#([^}]+)\}\s*$/)?.[1];
      let base = explicit ?? slugHeading(heading[1]);
      if (base) {
        let value = base;
        let suffix = 0;
        while (anchors.includes(value)) value = `${base}-${++suffix}`;
        anchors.push(value);
      }
    }
    for (const match of line.matchAll(/<([a-zA-Z][\w+.-]*):\/\/[^>]*>|\bid=["']([^"']+)["']|\bname=["']([^"']+)["']/g)) {
      const id = match[2] ?? match[3];
      if (id) anchors.push(id);
    }
    const definition = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/);
    if (definition) {
      const target = definition[2].replace(/^<|>$/g, "");
      definitions.set(definition[1].trim().toLocaleLowerCase("en"), { target, line: index + 1 });
    }
    return line.replace(/`+[^`]*`+/g, "").replace(/<!--.*?-->/g, "");
  });

  for (const value of definitions.values()) links.push(value);
  for (const [lineIndex, line] of visibleLines.entries()) {
    for (const match of line.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g)) {
      links.push({ target: match[1].replace(/^<|>$/g, ""), line: lineIndex + 1 });
    }
    const reference = /!?\[([^\]]+)\](?:\[([^\]]*)\])?/g;
    for (const match of line.matchAll(reference)) {
      const label = (match[2] || match[1]).trim().toLocaleLowerCase("en");
      const definition = definitions.get(label);
      if (definition && !line.slice(Math.max(0, (match.index ?? 0) - 1), (match.index ?? 0) + match[0].length + 1).includes("(")) {
        links.push({ target: definition.target, line: lineIndex + 1 });
      }
    }
  }
  return { links, anchors: [...new Set(anchors)] };
}

function gitBlobHash(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

async function parsedMarkdown(root: string, file: string, memory: Map<string, ParsedMarkdown>): Promise<ParsedMarkdown> {
  const present = memory.get(file);
  if (present) return present;
  const fullPath = path.join(root, file);
  const info = await lstat(fullPath);
  if (!info.isFile() || info.isSymbolicLink()) return { links: [], anchors: [] };
  const bytes = await readFile(fullPath);
  const hash = gitBlobHash(bytes);
  const cacheFile = path.join(root, CACHE_PATH, `${hash}.json`);
  let parsed: ParsedMarkdown;
  try {
    parsed = JSON.parse(await readFile(cacheFile, "utf8")) as ParsedMarkdown;
  } catch {
    parsed = parseMarkdown(bytes.toString("utf8"));
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(parsed));
  }
  memory.set(file, parsed);
  return parsed;
}

function isExternal(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function linkTarget(root: string, source: string, target: string): { file: string; anchor: string } | undefined {
  if (isExternal(target)) return undefined;
  const hashAt = target.indexOf("#");
  const rawPath = (hashAt < 0 ? target : target.slice(0, hashAt)).split("?")[0];
  const anchor = hashAt < 0 ? "" : decoded(target.slice(hashAt + 1));
  const sourceDir = path.dirname(path.join(root, source));
  let resolved = path.resolve(sourceDir, decoded(rawPath || source.split("/").pop() || source));
  if (!rawPath) resolved = path.join(root, source);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { file: relative, anchor };

  const candidates = [resolved];
  if (!path.extname(resolved)) candidates.push(`${resolved}.md`);
  candidates.push(path.join(resolved, "README.md"), path.join(resolved, "index.md"));
  for (const candidate of candidates) {
    try {
      if (candidate === resolved && (candidate.endsWith(".md") || !path.extname(candidate))) {
        // Keep Markdown paths exact; extensionless links may use the .md candidate.
      }
      const candidateStat = statSync(candidate);
      if (candidateStat.isFile()) return { file: path.relative(root, candidate).split(path.sep).join("/"), anchor };
      if (candidateStat.isDirectory()) continue;
    } catch {
      // Try the next conventional Markdown target.
    }
  }
  return { file: path.relative(root, resolved).split(path.sep).join("/"), anchor };
}

function statSync(file: string): { isFile(): boolean; isDirectory(): boolean } {
  return fsLstatSync(file);
}

function currentMainCheckout(root: string): string | undefined {
  const match = root.replaceAll("\\", "/").match(/^(.*)\/worktrees\/[^/]+$/);
  return match ? `${match[1]}/rezics-next` : undefined;
}

async function checkBrief(root: string, file: string): Promise<RunResult> {
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { exitCode: 2, lines: [`brief-path | ${file} | brief must be inside the worktree | remedy: copy it into the worktree`] };
  }
  if (relative.startsWith(`.temp${path.sep}`) || relative === ".temp") {
    return { exitCode: 2, lines: [`brief-path | ${file} | temporary state files cannot be read as briefs | remedy: copy the brief into a normal worktree path`] };
  }
  let bytes: Buffer;
  try {
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("brief must be a regular file");
    bytes = await readFile(resolved);
  } catch (error) {
    return { exitCode: 2, lines: [`brief-read | ${file} | ${String(error).split("\n")[0]} | remedy: provide a readable worktree file`] };
  }
  const content = bytes.toString("utf8");
  const lines: string[] = [];
  if (bytes.byteLength > 12_288) lines.push(`brief-size | ${file} | size ${bytes.byteLength} bytes exceeds 12288 bytes | remedy: shorten the brief`);
  if (/\.temp\/goal\//.test(content)) lines.push(`brief-private-state | ${file} | target .temp/goal/ is present | remedy: quote the needed state in an owner document or the brief`);
  const main = currentMainCheckout(root);
  const absoluteMain = main && content.includes(main);
  const genericMain = /(?:^|[\s("'])\/[A-Za-z0-9._/-]*\/rezics-next(?:\/|(?=$|[\s)"']))/m.test(content);
  if (absoluteMain || genericMain) lines.push(`brief-main-checkout | ${file} | an absolute main-checkout path is present | remedy: use a worktree-relative owner-document link`);
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (/docs\/research\/[^\s)\]]+/.test(line) && /\b(?:authority|authoritative|source of truth|specification)\b/i.test(line)) {
      lines.push(`brief-research-authority | ${file} | line ${index + 1} cites research as authority | remedy: cite the owner document and keep research as background`);
    }
  }
  return { exitCode: lines.length ? 1 : 0, lines };
}

function baselineMap(baseline: Baseline): Map<string, number> {
  return new Map(baseline.entries.map((entry) => [entry.path, entry.bytes]));
}

function normalizeResearcher(file: string): { topic: string; researcher: string } {
  const name = path.basename(file, ".md");
  for (const suffix of RESEARCHER_SUFFIXES) {
    if (name.endsWith(`-${suffix}`)) return { topic: name.slice(0, -(suffix.length + 1)), researcher: suffix };
  }
  return { topic: name, researcher: "unknown" };
}

function safeLine(rule: string, file: string, detail: string, remedy: string): string {
  return `${rule} | ${file} | ${detail} | remedy: ${remedy}`;
}

export async function runDocsCheck(root = process.cwd(), argv = process.argv.slice(2)): Promise<RunResult> {
  const mode = argv[0];
  if (mode === "--brief") return argv[1] && argv.length === 2 ? checkBrief(root, argv[1]) : { exitCode: 2, lines: ["usage | --brief | expected: --brief <file>"] };
  if (mode !== undefined && mode !== "--changed" && mode !== "--update-baseline") {
    return { exitCode: 2, lines: ["usage | docs-check | expected --changed <base>, --brief <file> or --update-baseline"] };
  }
  if (mode === "--changed" && (!argv[1] || argv.length !== 2)) {
    return { exitCode: 2, lines: ["usage | --changed | expected: --changed <base>"] };
  }
  if (mode === "--update-baseline" && argv.length !== 1) {
    return { exitCode: 2, lines: ["usage | --update-baseline | does not accept other arguments"] };
  }

  const violations: string[] = [];
  const changedMode = mode === "--changed";
  const baselineRef = changedMode ? argv[1] : "HEAD";
  let tracked: string[];
  let untracked: string[];
  let diff: DiffEntry[];
  try {
    tracked = splitGitPaths(runGit(root, ["ls-files", "-z"]));
    untracked = splitGitPaths(runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
    diff = parseDiff(root, baselineRef);
    if (!changedMode) {
      try {
        diff.push(...parseDiff(root, "HEAD^"));
      } catch {
        // A one-commit repository has no prior committed changes to inspect.
      }
    }
  } catch (error) {
    return { exitCode: 2, lines: [`git | repository | ${String(error).split("\n")[0]} | remedy: run from a Git worktree`] };
  }

  const allFiles = [...new Set([...tracked, ...untracked])].sort();
  const sizes = new Map<string, number>();
  await Promise.all(allFiles.map(async (file) => {
    if (file.startsWith(".temp/")) return;
    try {
      const info = await lstat(path.join(root, file));
      if (info.isFile()) sizes.set(file, info.size);
    } catch {
      // A tracked deletion has no current size.
    }
  }));
  try {
    const stagedTemp = runGit(root, ["ls-files", "-s", "-z", "--", ".temp"]);
    const objectIds = stagedTemp.split("\0").filter(Boolean).map((entry) => entry.match(/^\d+ ([0-9a-f]+) \d+\t/)?.[1]).filter((value): value is string => Boolean(value));
    if (objectIds.length) {
      const objectSizes = runGitInput(root, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], `${objectIds.join("\n")}\n`);
      const sizeByObject = new Map(objectSizes.trim().split("\n").map((line) => {
        const [object, bytes] = line.split(" ");
        return [object, Number(bytes)] as const;
      }));
      for (const entry of stagedTemp.split("\0").filter(Boolean)) {
        const match = entry.match(/^\d+ ([0-9a-f]+) \d+\t(.*)$/);
        if (match) sizes.set(match[2], sizeByObject.get(match[1]) ?? 0);
      }
    }
  } catch {
    return { exitCode: 2, lines: [`git | .temp | unable to read tracked blob sizes | remedy: repair the Git index`] };
  }
  const budgetsPath = path.join(root, BUDGETS_PATH);
  const baselinePath = path.join(root, BASELINE_PATH);
  const registryPath = path.join(root, REGISTRY_PATH);
  let budgetFile: BudgetFile;
  let baseline: Baseline;
  let registry: { reports: { path: string; topic: string; researcher: string; state: string; decision?: string }[] };
  try {
    for (const configPath of [budgetsPath, baselinePath, registryPath]) {
      const info = await lstat(configPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path.relative(root, configPath)} must be a regular file`);
    }
    budgetFile = json<BudgetFile>(await readFile(budgetsPath, "utf8"), BUDGETS_PATH);
    baseline = json<Baseline>(await readFile(baselinePath, "utf8"), BASELINE_PATH);
    registry = json(await readFile(registryPath, "utf8"), REGISTRY_PATH);
  } catch (error) {
    return { exitCode: 2, lines: [`configuration | docs | ${String(error).split("\n")[0]} | remedy: repair the budgets, baseline and registry JSON`] };
  }
  if (budgetFile.version !== 1 || !Array.isArray(budgetFile.budgets) || baseline.version !== 1 || !Array.isArray(baseline.entries)) {
    return { exitCode: 2, lines: ["configuration | docs/budgets.json | unsupported data version | remedy: use version 1 budgets and baseline files"] };
  }

  const entries = baselineMap(baseline);
  const baseEntries = new Map<string, number>();
  let baseBaselineExists = false;
  try {
    const baseText = runGit(root, ["show", `${baselineRef}:${BASELINE_PATH}`]);
    const parsed = json<Baseline>(baseText, `${baselineRef}:${BASELINE_PATH}`);
    for (const entry of parsed.entries) baseEntries.set(entry.path, entry.bytes);
    baseBaselineExists = true;
  } catch {
    // The first tracked baseline has no prior budget state to raise.
  }
  const baselineModified = (() => {
    try {
      return runGit(root, ["status", "--porcelain", "--", BASELINE_PATH]).trim().length > 0;
    } catch {
      return true;
    }
  })();
  let headMessage = "";
  try {
    headMessage = runGit(root, ["log", "-1", "--format=%B", changedMode ? "HEAD" : "HEAD"]);
  } catch {
    // Initial repository fixture.
  }
  const hasRaiseTrailer = /^Budget-Raise:\s*\S.*$/m.test(headMessage);

  for (const [file, bytes] of entries) {
    const previous = baseEntries.get(file);
    if (baseBaselineExists && previous !== undefined && bytes > previous && !(hasRaiseTrailer && !baselineModified)) {
      violations.push(safeLine("baseline-raise", file, `size ${bytes} bytes raises the committed baseline from ${previous} bytes`, "add a Budget-Raise: <reason> commit trailer"));
    } else if (baseBaselineExists && previous === undefined && bytes > 0 && !(hasRaiseTrailer && !baselineModified)) {
      violations.push(safeLine("baseline-raise", file, `size ${bytes} bytes adds a committed baseline entry`, "add a Budget-Raise: <reason> commit trailer"));
    }
  }
  if (baseBaselineExists && !baselineModified && !hasRaiseTrailer) {
    let parentBaseline = "";
    try {
      parentBaseline = runGit(root, ["show", `HEAD^:${BASELINE_PATH}`]);
    } catch {
      parentBaseline = "";
    }
    if (parentBaseline) {
      try {
        const parent = baselineMap(json<Baseline>(parentBaseline, `HEAD^:${BASELINE_PATH}`));
        for (const [file, bytes] of entries) {
          if (bytes > (parent.get(file) ?? 0)) {
            violations.push(safeLine("baseline-raise", file, `committed size ${bytes} bytes exceeds the parent baseline`, "add a Budget-Raise: <reason> commit trailer"));
          }
        }
      } catch {
        // The current baseline is validated above; a malformed parent is unrelated to this change.
      }
    }
  }

  const fileBudgets = budgetFile.budgets.filter((budget) => budget.kind === "file");
  const directoryBudgets = budgetFile.budgets.filter((budget) => budget.kind === "directory");
  for (const [file, size] of sizes) {
    if (file.startsWith(".temp/")) continue;
    const applicable = fileBudgets.filter((budget) => matches(budget.path, file));
    if (!applicable.length) continue;
    const specificity = Math.max(...applicable.map((budget) => budget.path.replace(/[?*]/g, "").length));
    const budget = applicable.filter((candidate) => candidate.path.replace(/[?*]/g, "").length === specificity).sort((a, b) => a.bytes - b.bytes)[0]!;
    const current = entries.get(file);
    if (current !== undefined) {
      if (size > current) violations.push(safeLine("budget-growth", file, `size ${size} bytes exceeds baseline ${current} bytes`, "shrink the file or raise the baseline with a reason trailer"));
      else if (size < current) {
        if (mode === "--update-baseline") entries.set(file, size);
        else violations.push(safeLine("budget-shrank", file, `size ${size} bytes is below baseline ${current} bytes`, "run bun scripts/docs-check.ts --update-baseline and commit"));
      }
    } else if (size > budget.bytes) {
      violations.push(safeLine("budget-cap", file, `size ${size} bytes exceeds cap ${budget.bytes} bytes`, "reduce the file to its cap"));
    }
  }
  for (const budget of directoryBudgets) {
    const size = [...sizes].reduce((sum, [file, bytes]) => sum + (matches(budget.path, file) ? bytes : 0), 0);
    const previous = entries.get(budget.path);
    if (previous !== undefined) {
      if (size > previous) violations.push(safeLine("budget-growth", budget.path, `size ${size} bytes exceeds baseline ${previous} bytes`, "shrink the directory total or raise the baseline with a reason trailer"));
      else if (size < previous) {
        if (mode === "--update-baseline") entries.set(budget.path, size);
        else violations.push(safeLine("budget-shrank", budget.path, `size ${size} bytes is below baseline ${previous} bytes`, "run bun scripts/docs-check.ts --update-baseline and commit"));
      }
    } else if (size > budget.bytes) {
      violations.push(safeLine("budget-cap", budget.path, `size ${size} bytes exceeds cap ${budget.bytes} bytes`, "reduce the directory total to its cap"));
    }
  }
  for (const [file, previous] of [...entries]) {
    if (file.includes("*") || sizes.has(file)) continue;
    if (mode === "--update-baseline") entries.set(file, 0);
    else violations.push(safeLine("budget-shrank", file, `size 0 bytes is below baseline ${previous} bytes`, "run bun scripts/docs-check.ts --update-baseline and commit"));
  }
  if (mode === "--update-baseline") {
    const lowered = baseline.entries.filter((entry) => (entries.get(entry.path) ?? entry.bytes) < entry.bytes);
    for (const entry of lowered) entry.bytes = entries.get(entry.path) ?? entry.bytes;
    if (lowered.length) {
      baseline.entries.sort((a, b) => a.path.localeCompare(b.path));
      await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      for (const entry of lowered) violations.push(safeLine("baseline-lowered", entry.path, `size lowered to ${entry.bytes} bytes`, "commit the lower baseline"));
    }
    violations.splice(0, violations.length, ...violations.filter((line) => !line.startsWith("budget-shrank |")));
  }

  const diffPaths = new Set<string>();
  const deletedOrRenamed = new Set<string>();
  for (const entry of diff) {
    if (entry.newPath) {
      diffPaths.add(entry.oldPath);
      diffPaths.add(entry.newPath);
      if (entry.status.startsWith("R")) deletedOrRenamed.add(entry.oldPath);
    } else {
      diffPaths.add(entry.oldPath);
      if (entry.status.startsWith("D")) deletedOrRenamed.add(entry.oldPath);
    }
  }
  const newlyTrackedTemp = diff.filter((entry) => (entry.status.startsWith("A") || entry.status.startsWith("R")) && (entry.newPath ?? entry.oldPath).startsWith(".temp/"));
  for (const entry of newlyTrackedTemp) {
    const file = entry.newPath ?? entry.oldPath;
    violations.push(safeLine("tracked-temp", file, "newly tracked temporary file", "remove it from the index and keep temporary state untracked"));
  }

  const researchFiles = allFiles.filter((file) => file.startsWith("docs/research/") && file.endsWith(".md") && sizes.has(file));
  const registryRows = Array.isArray(registry.reports) ? registry.reports : [];
  const registryPaths = new Map<string, typeof registryRows[number]>();
  for (const row of registryRows) {
    if (!row || typeof row.path !== "string") {
      violations.push(safeLine("research-registry", REGISTRY_PATH, "entry has no report path", "add a valid registry record"));
      continue;
    }
    if (registryPaths.has(row.path)) violations.push(safeLine("research-registry", row.path, "duplicate report entry", "keep one registry entry per report"));
    else registryPaths.set(row.path, row);
    if (!RESEARCH_STATES.has(row.state)) violations.push(safeLine("research-state", row.path, `invalid state ${String(row.state)}`, "use open, adopted or rejected"));
    if (!row.topic || !row.researcher) violations.push(safeLine("research-registry", row.path, "topic and researcher are required", "derive the topic and researcher from the report name"));
    if (row.state === "adopted" && !row.decision) violations.push(safeLine("research-registry", row.path, "adopted report has no owner decision", "link the owner section that records the decision"));
  }
  for (const file of researchFiles) {
    if (!registryPaths.has(file)) violations.push(safeLine("research-unregistered", file, "research report is missing from the registry", "add it to docs/research/registry.json with state open"));
  }
  for (const row of registryRows) {
    if (typeof row?.path === "string" && !researchFiles.includes(row.path)) violations.push(safeLine("research-missing", row.path, "registry report does not exist", "restore the report or remove its registry entry"));
  }

  const allMarkdown = allFiles.filter((file) => !file.startsWith(".temp/") && file.endsWith(".md") && sizes.has(file));
  const changedMarkdown = new Set<string>();
  if (changedMode) {
    for (const file of diffPaths) if (file.endsWith(".md") && sizes.has(file)) changedMarkdown.add(file);
    for (const file of untracked) if (file.endsWith(".md")) changedMarkdown.add(file);
  }
  const ownerFiles = changedMode ? [...changedMarkdown].filter(ownerDocument) : allMarkdown.filter(ownerDocument);
  for (const file of ownerFiles) {
    try {
      const text = await readFile(path.join(root, file), "utf8");
      for (const error of extractOwnerViolations(text)) violations.push(safeLine(error.rule, file, error.detail, "remove the dated heading, task ID or temporary path"));
      const marker = /<!-- generated: ([^\s]+) -->\r?\n([\s\S]*?)<!-- \/generated -->/g;
      const generatedBlocks = [...text.matchAll(marker)];
      const openMarkers = [...text.matchAll(/<!-- generated:/g)].length;
      const closeMarkers = [...text.matchAll(/<!-- \/generated -->/g)].length;
      if (openMarkers !== generatedBlocks.length || closeMarkers !== generatedBlocks.length) {
        violations.push(safeLine("generated-block", file, "generated block markers are incomplete", "pair each generated marker around its rendered source bytes"));
      }
      for (const match of generatedBlocks) {
        const source = match[1];
        const sourcePath = path.resolve(root, source);
        const sourceRelative = path.relative(root, sourcePath);
        if (source.startsWith("/") || sourceRelative.startsWith("..") || source.startsWith(".temp/")) {
          violations.push(safeLine("generated-block", file, `source ${source} is outside the readable worktree`, "use a repository-relative regular-file source"));
          continue;
        }
        try {
          const sourceInfo = await lstat(sourcePath);
          if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("source must be a regular file");
          const sourceText = (await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n").trimEnd();
          const body = match[2].replace(/\r\n/g, "\n").replace(/^\n|\n$/g, "");
          if (sourceText !== body) {
            violations.push(safeLine("generated-block", file, `render from ${source} differs from the block`, "regenerate the block from its repository-relative source"));
          }
        } catch {
          violations.push(safeLine("generated-block", file, `source ${source} is missing`, "restore the source and regenerate the block"));
        }
      }
    } catch {
      // A deleted owner document has no current content to inspect.
    }
  }

  const markdownMemory = new Map<string, ParsedMarkdown>();
  const linkSources = new Map<string, Set<string>>();
  const sourceSet = changedMode ? new Set(changedMarkdown) : new Set(allMarkdown);
  if (changedMode && deletedOrRenamed.size) {
    for (const source of allMarkdown) {
      const parsed = await parsedMarkdown(root, source, markdownMemory);
      for (const link of parsed.links) {
        const resolved = linkTarget(root, source, link.target);
        if (resolved && deletedOrRenamed.has(resolved.file)) {
          sourceSet.add(source);
          const targets = linkSources.get(source) ?? new Set<string>();
          targets.add(link.target);
          linkSources.set(source, targets);
        }
      }
    }
  }
  for (const source of sourceSet) {
    const parsed = await parsedMarkdown(root, source, markdownMemory);
    const inboundOnly = changedMode && !changedMarkdown.has(source) ? linkSources.get(source) : undefined;
    for (const link of parsed.links) {
      if (inboundOnly && !inboundOnly.has(link.target)) continue;
      const resolved = linkTarget(root, source, link.target);
      if (!resolved) continue;
      if (resolved.file.startsWith("..") || path.isAbsolute(resolved.file)) {
        violations.push(safeLine("link-target", source, `target ${link.target} leaves the worktree (line ${link.line})`, "use a repository-relative link"));
        continue;
      }
      const targetPath = path.join(root, resolved.file);
      let targetStat: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        targetStat = await lstat(targetPath);
      } catch {
        // Report below with a stable missing-target rule.
      }
      if (!targetStat?.isFile() || targetStat.isSymbolicLink()) {
        violations.push(safeLine("link-target", source, `target ${link.target} does not resolve (line ${link.line})`, "fix the relative link or restore the target"));
        continue;
      }
      if (resolved.anchor && resolved.file.endsWith(".md")) {
        const targetMarkdown = await parsedMarkdown(root, resolved.file, markdownMemory);
        if (!targetMarkdown.anchors.includes(resolved.anchor) && !targetMarkdown.anchors.includes(resolved.anchor.toLocaleLowerCase("en"))) {
          violations.push(safeLine("link-anchor", source, `target ${link.target} has no matching anchor (line ${link.line})`, "use an existing heading anchor or add the intended heading"));
        }
      }
    }
  }

  const unique = [...new Set(violations)].sort((a, b) => a.localeCompare(b));
  const failures = unique.filter((line) => !line.startsWith("baseline-lowered |"));
  return { exitCode: failures.length ? 1 : 0, lines: unique };
}

if (import.meta.main) {
  const result = await runDocsCheck();
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}
