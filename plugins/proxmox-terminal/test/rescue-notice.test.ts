/**
 * The rescue's notices reach the chat through remote-host's lease notices,
 * which are cut at 500 characters and capped at 5 (L-g on node g lost a
 * second checkout's line to that cut). Each must fit, whole.
 */
import { describe, expect, it } from "vitest";
import { NOTICE_MAX, noticesFor, rescueRef, type RescueEntry } from "../src/legacy-rescue.js";

const job = { workDir: "/root/work" };
const chat = "5Uyk-lYf3bgMRMZl77lS3";
const sha = "c0372e8a1b2c3d4e5f60718293a4b5c6d7e8f901";

function saved(d: string, paths: number, extra: Partial<RescueEntry> = {}): RescueEntry {
  return {
    d,
    state: "moved",
    ref: rescueRef(chat, 9001, d),
    diffFrom: sha,
    pathCount: paths,
    paths: Array.from({ length: Math.min(paths, 50) }, (_, i) => ({ status: "M", path: `src/some/rather/deep/folder/file-${i}.ts` })),
    commits: 0,
    excludedCount: 0,
    excluded: [],
    ...extra,
  } as RescueEntry;
}

describe("rescue notices", () => {
  it("one per checkout, each whole and under the cut, with the commands to use its ref", () => {
    const out = noticesFor(job, [saved("other", 1), saved("repo1", 2)]);
    expect(out).toHaveLength(2);
    for (const n of out) expect(n.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(out[1]).toContain("Checkout `repo1`");
    expect(out[1]).toContain(`git checkout ${rescueRef(chat, 9001, "repo1")} -- <path>`);
    expect(out[1]).toContain("2 unsynced paths");
  });

  it("lists fewer paths, then words it shorter, before ever cutting", () => {
    const [n] = noticesFor(job, [saved("a-checkout-with-a-long-name", 40, { commits: 3 })]);
    expect(n!.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(n).toContain(rescueRef(chat, 9001, "a-checkout-with-a-long-name"));
    expect(n).toContain("40 unsynced paths");
    expect(n).toMatch(/\+\d+ more/);
    expect(n).not.toMatch(/…$/);
  });

  it("files left out by the size caps get their own notice; never more than five in all", () => {
    const big = saved("repo", 1, { excludedCount: 9, excluded: Array.from({ length: 9 }, (_, i) => ({ path: `blob-${i}.bin`, bytes: 60 * 2 ** 20 })) });
    const out = noticesFor(job, [big, ...["b", "c", "d", "e"].map((d) => saved(d, 1))]);
    expect(out).toHaveLength(5);
    expect(out[1]).toContain("left out by the size caps");
    expect(out[4]).toMatch(/^…and 2 more notes/);
    for (const n of out) expect(n.length).toBeLessThanOrEqual(NOTICE_MAX);
  });
});
