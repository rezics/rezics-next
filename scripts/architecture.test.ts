import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  auditArchitecture,
  buildGraph,
  changedGraph,
  formatModuleMap,
  type ArchitectureManifest,
  type BoundaryBaseline,
  validateBaseline,
  writeGraphCache,
} from "./architecture";

const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const temp = join(process.cwd(), ".temp");
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "architecture-test-"));
  temporaryRoots.push(root);
  return root;
}

function put(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

function baseline(): BoundaryBaseline {
  return { version: 1, modules: {} };
}

function manifest(modules: ArchitectureManifest["modules"]): ArchitectureManifest {
  return {
    version: 1,
    sourceRoots: [
      { path: "src", extensions: [".ts"] },
      { path: "packages", extensions: [".ts"] },
      { path: "apps", extensions: [".ts"] },
    ],
    modules,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("architecture boundaries", () => {
  test("reports new cycles, private type imports, effects, unowned files, and package-to-app imports", () => {
    const root = fixtureRoot();
    const current = manifest([
      { id: "main", kind: "application", owner: "platform", paths: ["src/main/**"], publicEntries: [], allowedDependencies: [], capabilities: [] },
      { id: "peer", kind: "core", owner: "platform", paths: ["src/peer/**"], publicEntries: ["src/peer/index.ts"], allowedDependencies: [], capabilities: [] },
      { id: "pure", kind: "core", owner: "platform", paths: ["src/core/**"], publicEntries: [], allowedDependencies: [], capabilities: [] },
      { id: "package", kind: "core", owner: "platform", paths: ["packages/foo/src/**"], publicEntries: [], allowedDependencies: [], capabilities: [] },
      { id: "app", kind: "composition root", owner: "web", paths: ["apps/web/src/**"], publicEntries: [], allowedDependencies: [], capabilities: [] },
    ]);
    put(root, "src/main/a.ts", 'import type { Private } from "../peer/private"; import "./b";\n');
    put(root, "src/main/b.ts", 'import "./a";\n');
    put(root, "src/peer/index.ts", "export type { Public } from './public';\n");
    put(root, "src/peer/private.ts", "export interface Private { value: string }\n");
    put(root, "src/peer/public.ts", "export interface Public { value: string }\n");
    put(root, "src/core/pure.ts", 'import type React from "react";\n');
    put(root, "src/orphan.ts", "export const orphan = true;\n");
    put(root, "packages/foo/src/index.ts", 'import "../../../apps/web/src/main";\n');
    put(root, "apps/web/src/main.ts", "export const app = true;\n");

    const result = auditArchitecture(root, current, baseline(), buildGraph(root, current));
    const report = result.errors.join("\n");
    expect(report).toContain("rule 3: src/main/a.ts:");
    expect(report).toContain("value-import cycle");
    expect(report).toContain("rule 2: src/main/a.ts:");
    expect(report).toContain("type import");
    expect(report).toContain("src/peer/private.ts");
    expect(report).toContain("rule 4: src/core/pure.ts:");
    expect(report).toContain("rule 1: src/orphan.ts:");
    expect(report).toContain("rule 7: packages/foo/src/index.ts:");
    expect(report).toContain("apps/web/src/main.ts");
  });

  test("requires an owner and reason on every ratchet group", () => {
    const errors = validateBaseline({
      version: 1,
      modules: {
        core: {
          owner: "",
          reason: "",
          violations: [{ rule: "rule 2", file: "src/core.ts", edge: "type import ./private => src/private.ts" }],
        },
      },
    });
    expect(errors.join("\n")).toContain("rule 8: src/core.ts: type import ./private => src/private.ts");
    expect(errors.join("\n")).toContain("owner and reason");
  });

  test("rechecks changed edges against the complete cached graph", () => {
    const root = fixtureRoot();
    const current = manifest([
      { id: "core", kind: "core", owner: "platform", paths: ["src/**"], publicEntries: [], allowedDependencies: [], capabilities: [] },
    ]);
    put(root, "src/a.ts", "export const a = true;\n");
    put(root, "src/b.ts", "export const b = true;\n");
    writeGraphCache(root, buildGraph(root, current));
    put(root, "src/a.ts", 'import "./b"; export const a = true;\n');
    put(root, "src/b.ts", 'import "./a"; export const b = true;\n');
    const graph = changedGraph(root, current, ["src/a.ts", "src/b.ts"]);
    const result = auditArchitecture(root, current, baseline(), graph);
    expect(result.errors.join("\n")).toContain("value-import cycle");
  });

  test("prints a compact map", () => {
    const current = manifest([
      { id: "core", kind: "core", owner: "platform", paths: ["src/**"], publicEntries: ["@rezics/core", "@rezics/core/contracts/*"], allowedDependencies: [], capabilities: [] },
    ]);
    const output = formatModuleMap(current);
    expect(output).toContain("core|core|platform|");
    expect(output.length).toBeLessThanOrEqual(2_000);
  });
});
