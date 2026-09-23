#!/usr/bin/env python3
"""Check authored Markdown links, local fragments and design navigation offline.

Checks README.md, docs/**/*.md and research READMEs. Fenced examples and inline
code are excluded from link checks. This is not a full CommonMark parser, external
URL checker, terminology classifier, or runtime/product acceptance test.
"""
from __future__ import annotations

import re
import sys
from collections import Counter, deque
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]


def prose_lines(text: str):
    """Keep source line numbers; ignore fenced code blocks."""
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is None:
            yield number, line


def anchors(text: str) -> set[str]:
    result = set()
    seen = Counter()
    for _, line in prose_lines(text):
        result.update(re.findall(r'<(?:a|h[1-6])\b[^>]*\bid=["\']([^"\']+)', line))
        match = re.match(r"^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        if not match:
            continue
        title = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", match[1])
        title = re.sub(r"<[^>]+>", "", title).replace("`", "")
        slug = re.sub(r"[^\w\- ]", "", title.lower()).replace(" ", "-")
        candidate = slug
        while candidate in result:
            seen[slug] += 1
            candidate = f"{slug}-{seen[slug]}"
        result.add(candidate)
    return result


def destinations(text: str):
    """Inline/image destinations and reference definitions, including URL parens."""
    for number, line in prose_lines(text):
        line = re.sub(r"(`+).*?\1", "", line)
        definition = re.match(r"^ {0,3}\[[^]]+\]:\s*(<[^>]*>|\S+)", line)
        if definition:
            yield number, definition[1].strip("<>")
        for match in re.finditer(r"(?<!\\)\]\(\s*", line):
            start = match.end()
            if start < len(line) and line[start] == "<":
                end = line.find(">", start + 1)
                if end >= 0:
                    yield number, line[start + 1:end]
                continue
            depth, end = 0, start
            while end < len(line):
                char = line[end]
                if char == "\\":
                    end += 2
                    continue
                if char == "(":
                    depth += 1
                elif char == ")":
                    if depth == 0:
                        break
                    depth -= 1
                elif char.isspace() and depth == 0:
                    break
                end += 1
            yield number, re.sub(r"\\([()])", r"\1", line[start:end])


def check(root: Path, files: list[Path], *, navigation: bool = True) -> list[str]:
    root = root.resolve()
    texts = {p.resolve(): p.read_text(encoding="utf-8") for p in files}
    edges = {p: set() for p in texts}
    errors = []
    cache = {}
    for source, body in texts.items():
        label = source.relative_to(root)
        for line, url in destinations(body):
            parts = urlsplit(url)
            if parts.scheme or parts.netloc:
                continue
            raw_path = unquote(parts.path)
            target = ((root / raw_path.lstrip("/")) if raw_path.startswith("/")
                      else (source.parent / raw_path) if raw_path else source).resolve()
            if not target.exists():
                errors.append(f"{label}:{line}: missing target: {url}")
                continue
            if target in edges:
                edges[source].add(target)
            if parts.fragment and target.suffix.lower() == ".md":
                if target not in cache:
                    cache[target] = anchors(texts.get(target) or target.read_text(encoding="utf-8"))
                if unquote(parts.fragment) not in cache[target]:
                    errors.append(f"{label}:{line}: missing fragment: {url}")
    if navigation:
        entry = (root / "docs/README.md").resolve()
        if entry not in edges:
            errors.append("docs/README.md: missing design entry point")
        else:
            visited, pending = set(), deque([entry])
            while pending:
                source = pending.popleft()
                if source in visited:
                    continue
                visited.add(source)
                pending.extend(edges[source] - visited)
            for source in sorted(texts):
                if source.is_relative_to(root / "docs") and source not in visited:
                    errors.append(f"{source.relative_to(root)}: unreachable from docs/README.md")
    return errors


def document_files(root: Path) -> list[Path]:
    research = root / "scripts/research"
    readmes = [path for path in research.rglob("README.md")
               if not {"node_modules", "lab"}.intersection(path.relative_to(research).parts)]
    return [root / "README.md", *sorted((root / "docs").rglob("*.md")),
            *sorted(readmes)]


def main() -> int:
    files = document_files(ROOT)
    errors = check(ROOT, files)
    if errors:
        print("\n".join(errors))
        print(f"Documentation checks failed: {len(errors)} issue(s).")
        return 1
    print(f"Documentation checks passed: {len(files)} Markdown files; local links, "
          "fragments and design navigation. External URLs and runtime behavior not tested.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
