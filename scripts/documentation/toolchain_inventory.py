"""Render the toolchain inventory from the files that actually select tools."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
START = "<!-- toolchain-inventory:start -->"
END = "<!-- toolchain-inventory:end -->"


def required_match(pattern: str, source: str, label: str) -> str:
    match = re.search(pattern, source, re.MULTILINE)
    if not match:
        raise ValueError(f"Missing {label} pin")
    return match.group(1)


def direct_packages(root: Path) -> list[tuple[str, str, str]]:
    manifest = json.loads((root / "package.json").read_text())
    paths = [Path("package.json"), *(Path(member) / "package.json" for member in manifest["workspaces"])]
    packages: dict[str, tuple[str, list[str]]] = {}
    for path in paths:
        data = json.loads((root / path).read_text())
        for field in ("dependencies", "devDependencies", "peerDependencies"):
            for name, version in data.get(field, {}).items():
                if name in packages and packages[name][0] != version:
                    raise ValueError(f"Conflicting direct pins for {name}: {packages[name][0]} and {version}")
                packages.setdefault(name, (version, []))[1].append(str(path.parent))
    return [(name, version, ", ".join(sorted(set(owners))))
            for name, (version, owners) in sorted(packages.items())]


def commands(taskfile: str) -> list[tuple[str, str]]:
    result = []
    current = None
    for line in taskfile.splitlines():
        task = re.fullmatch(r"  ([a-z][a-z0-9:-]*):", line)
        if task:
            if current is not None:
                raise ValueError(f"Task {current} has no one-line description")
            current = task[1]
        elif current is not None and line.startswith("    desc: "):
            description = line.removeprefix("    desc: ").strip("'\"")
            result.append((current, description))
            current = None
    if current is not None:
        raise ValueError(f"Task {current} has no one-line description")
    return result


def image_pins(root: Path) -> list[tuple[str, str]]:
    compose = (root / "infra/dev/compose.yaml").read_text()
    dockerfile = (root / "infra/jena/Dockerfile").read_text()
    rows = [("Compose", image) for image in re.findall(r"^    image:\s*(\S+)", compose, re.MULTILINE)]
    rows += [("Fuseki build", image) for image in re.findall(r"^FROM\s+(\S+)", dockerfile, re.MULTILINE)]
    observability = (root / "infra/observability/compose.yaml").read_text()
    rows += [("Observability", image) for image in re.findall(r"^    image:\s*(\S+)", observability, re.MULTILINE)]
    if not rows:
        raise ValueError("No Compose or Fuseki image pins found")
    return list(dict.fromkeys(rows))


def development_ports(root: Path) -> list[tuple[str, str]]:
    config = (root / "scripts/dev/config.ts").read_text()
    block = required_match(r"const DEV_PORTS = \{([^}]+)\}", config, "development ports")
    rows = re.findall(r"\b([A-Z][A-Z0-9_]*):\s*(\d+)", block)
    rows.append(("ACCOUNTS_PORT", required_match(r"export const ACCOUNTS_PORT = (\d+)", config, "Accounts port")))
    if not rows:
        raise ValueError("No development ports found")
    return sorted(rows)


def auxiliary_images(root: Path) -> list[tuple[str, str]]:
    def constant(path: str, name: str) -> str:
        return required_match(rf"\b{name}\s*=\s*'([^']+)'", (root / path).read_text(), f"{name} in {path}")

    rows = [
        ("Nix package oracle", constant("services/main/src/modules/package/nix-graph.ts", "NIX_IMAGE")),
        ("Node package hooks", constant("services/main/src/modules/package/install-hooks.ts", "NODE_HOOK_IMAGE")),
        ("Load generator", required_match(r"'((?:grafana/k6):[^']+)'", (root / "scripts/load/practical.ts").read_text(), "k6 image")),
    ]
    fuzz = (root / "scripts/qa/api-fuzz.ts").read_text()
    match = re.search(r"schemathesisImage\s*=\s*'([^']+)'\s*\+\s*'([^']+)'", fuzz)
    if not match:
        raise ValueError("Missing Schemathesis image pin")
    rows.append(("API fuzz", match[1] + match[2]))
    for name in ("dgraph", "opensearch", "virtuoso"):
        path = f"scripts/research/storage_architecture/{name}.ts"
        rows.append((f"Research: {name}", f"{constant(path, 'IMAGE')} ({constant(path, 'IMAGE_DIGEST')})"))
    return rows


def cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def table(headers: tuple[str, ...], rows: list[tuple[str, ...]]) -> str:
    return "\n".join(["| " + " | ".join(headers) + " |",
                      "| " + " | ".join("---" for _ in headers) + " |",
                      *("| " + " | ".join(cell(value) for value in row) + " |" for row in rows)])


def render(root: Path = ROOT) -> str:
    package = json.loads((root / "package.json").read_text())
    release = (root / "scripts/dev/release-manifest.ts").read_text()
    cli = (root / "scripts/dev/cli.ts").read_text()
    aspire = json.loads((root / "aspire.config.json").read_text())
    runtimes = [
        ("Bun", required_match(r"bun:\s*'([^']+)'", release, "Bun"), "scripts/dev/release-manifest.ts"),
        ("Node.js", (root / ".nvmrc").read_text().strip(), ".nvmrc"),
        ("Yarn", package["packageManager"], "package.json"),
        ("Task", required_match(r"run\('task', \['--version'\]\) !== '([^']+)'", cli, "Task"), "scripts/dev/cli.ts"),
        ("Aspire SDK", aspire["sdk"]["version"], "aspire.config.json"),
        ("Go package oracle", required_match(r"const VERSION = '([^']+)'", (root / "scripts/package/go-oracle.ts").read_text(), "Go oracle"), "scripts/package/go-oracle.ts"),
        ("Cargo package oracle", required_match(r"Cargo ([0-9.]+) is not installed", (root / "scripts/package/cargo-oracle.ts").read_text(), "Cargo oracle"), "scripts/package/cargo-oracle.ts"),
        ("npm package oracle", required_match(r"npm ([0-9.]+) must be installed", (root / "scripts/package/npm-oracle.ts").read_text(), "npm oracle"), "scripts/package/npm-oracle.ts"),
    ]
    sections = [
        "### Runtime pins", table(("Tool", "Pin", "Source"), runtimes),
        "### Direct workspace packages", "Exact direct pins from root and workspace manifests; `yarn.lock` resolves transitive dependencies.",
        table(("Package", "Pin", "Manifest directories"), direct_packages(root)),
        "### Service and Fuseki build images", table(("Source", "Image and digest"), image_pins(root)),
        "### Other pinned images", table(("Use", "Image pin"), auxiliary_images(root)),
        "### Shared development ports", table(("Setting", "Port"), development_ports(root)),
        "### Root commands", "Pass command arguments after `--`; run `task --list` for the live command menu.",
        table(("Command", "Task description"), [(f"`task {name}`", desc) for name, desc in commands((root / "Taskfile.yml").read_text())]),
    ]
    return "\n\n".join(sections)


def update(text: str, generated: str) -> str:
    if text.count(START) != 1 or text.count(END) != 1:
        raise ValueError("Toolchain page must contain one inventory marker pair")
    before, rest = text.split(START)
    _, after = rest.split(END)
    return f"{before}{START}\n\n{generated}\n\n{END}{after}"


def check(root: Path = ROOT) -> list[str]:
    page = root / "docs/development/toolchain.md"
    expected = update(page.read_text(), render(root))
    return [] if page.read_text() == expected else ["docs/development/toolchain.md: generated inventory differs; run python3 scripts/documentation/toolchain_inventory.py --write"]


if __name__ == "__main__":
    import sys

    page = ROOT / "docs/development/toolchain.md"
    if sys.argv[1:] == ["--write"]:
        page.write_text(update(page.read_text(), render()))
    elif sys.argv[1:] == ["--check"]:
        errors = check()
        if errors:
            print("\n".join(errors))
            raise SystemExit(1)
    else:
        raise SystemExit("Usage: toolchain_inventory.py --write|--check")
