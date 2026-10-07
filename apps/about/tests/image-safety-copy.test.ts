import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const legal = (file: string) =>
  readFileSync(
    new URL(`../../../docs/legal/${file}`, import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");

const policies = [
  "terms-of-service.md",
  "child-safety-policy.md",
  "content-ratings-and-age-policy.md",
] as const;

test("no legal page promises that automated checks clear or hold every image", () => {
  for (const file of policies) {
    const text = legal(file);
    expect(text, file).not.toMatch(/images? pass automated safety checks/i);
    expect(text, file).not.toMatch(/likely explicit images are held/i);
  }
});

test("Terms keep the launch uploads, limits, reporting, removal and explicit-image ban, and defer to the media controls", () => {
  const terms = legal("terms-of-service.md");
  expect(terms).toContain("Cover and image uploads are available from launch");
  expect(terms).toContain("(child-safety-policy.md)");
  expect(terms).toContain("Sexually explicit images are prohibited");
  expect(terms).toContain("New accounts have upload limits");
  expect(terms).toContain("anyone can report an image");
  expect(terms).toContain("we remove images on valid reports");
  expect(terms).toMatch(/NSFW label for presentation; it does not decide/);
});

test("the classifier suggestion stays presentation evidence in the policies Terms defer to", () => {
  expect(legal("child-safety-policy.md")).toMatch(
    /does not by itself determine whether an image is prohibited, cleared or held for review/,
  );
  expect(legal("content-ratings-and-age-policy.md")).toMatch(
    /does not by itself hold an image for review/,
  );
});
