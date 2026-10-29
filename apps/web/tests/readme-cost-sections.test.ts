import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const headings = [...readme.matchAll(/^(#{2,3}) (.+)$/gm)].map((match) => ({
  level: match[1].length,
  title: match[2],
  index: match.index!,
}));

describe("web README cost sections", () => {
  test("every cost subsection belongs under the Cost heading", () => {
    let section = "";

    for (let i = 0; i < headings.length; i += 1) {
      const heading = headings[i]!;
      if (heading.level === 2) section = heading.title;
      if (heading.level !== 3) continue;

      const end = headings[i + 1]?.index ?? readme.length;
      const body = readme.slice(heading.index, end);
      if (
        body.includes("**Touches:**") &&
        body.includes("**Bound:**") &&
        body.includes("**Growth check:**")
      ) {
        expect(section, `${heading.title} must be under ## Cost`).toBe("Cost");
      }
    }
  });

  test("each level-two heading appears once", () => {
    const levelTwo = headings.filter((heading) => heading.level === 2).map((heading) => heading.title);
    expect(new Set(levelTwo).size).toBe(levelTwo.length);
  });
});
