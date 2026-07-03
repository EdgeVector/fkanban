// `bin/fkanban-worktree` creates a card worktree whose `target/` is warm — an
// APFS copy-on-write clone of the parent checkout's target/, so the first cargo
// run doesn't cold-compile the whole dependency graph.
//
// These drive the real script against a throwaway git repo in a temp dir:
//  - a warm clone happens when the parent has a target/ AND the filesystem
//    supports clonefile(2) (APFS): contents match, and it is an INDEPENDENT
//    directory, not a symlink or an inode-shared tree — concurrent agents must
//    never share cargo's build lock;
//  - on a non-APFS filesystem (e.g. the Linux CI runner) `cp -c` is
//    unsupported, so the script falls back to a COLD worktree (no target/) and
//    still succeeds;
//  - it also degrades gracefully when the parent has no target/ to warm from.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = fileURLToPath(new URL("../bin/fkanban-worktree", import.meta.url));

let root: string;
let repo: string;

async function run(
  args: string[],
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const code = await proc.exited;
  // Status lines ("worktree starts WARM" / "clonefile unavailable" / error
  // messages) may land on either stream — inspect both.
  const out =
    (await new Response(proc.stdout).text()) +
    (await new Response(proc.stderr).text());
  return { code, out };
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "fkanban-wt-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "target/\n");
  writeFileSync(join(repo, "README.md"), "hi\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("warms a fresh worktree by CoW-cloning the parent's target/ (APFS); falls back cold elsewhere", async () => {
  // Give the parent a target/ with a sentinel file (its "warm" build cache).
  const parentTarget = join(repo, "target");
  mkdirSync(join(parentTarget, "debug"), { recursive: true });
  writeFileSync(join(parentTarget, "debug", "sentinel"), "compiled\n");

  const wt = join(root, "wt");
  const { code, out } = await run([repo, wt, "fkanban/probe", "main"]);
  expect(code).toBe(0);

  // Worktree + branch always exist regardless of filesystem.
  expect(existsSync(join(wt, "README.md"))).toBe(true);

  const wtTarget = join(wt, "target");

  // `cp -c` (clonefile) is APFS-only. On CI's Linux runner it is unsupported, so
  // the script correctly falls back to a COLD worktree and says so. The warm
  // contract only applies where clonefile works — assert the branch the script
  // actually reported. Exactly one branch must be reported.
  const warmed = out.includes("worktree starts WARM");
  const cold = out.includes("clonefile unavailable");
  expect(warmed !== cold).toBe(true);

  if (cold) {
    // Non-APFS fallback: no target/ cloned; a later cargo run just builds cold.
    expect(existsSync(wtTarget)).toBe(false);
    return;
  }

  // Warm path (APFS): target/ is a REAL independent directory (not a symlink),
  // carrying the parent's contents.
  expect(existsSync(wtTarget)).toBe(true);
  expect(lstatSync(wtTarget).isSymbolicLink()).toBe(false);
  expect(lstatSync(wtTarget).isDirectory()).toBe(true);
  expect(readFileSync(join(wtTarget, "debug", "sentinel"), "utf8")).toBe(
    "compiled\n",
  );

  // A write inside the worktree's target/ must NOT bleed back into the parent —
  // proves it is an independent (CoW) copy, not a shared/hardlinked tree cargo
  // could deadlock on.
  writeFileSync(join(wtTarget, "debug", "sentinel"), "diverged\n");
  expect(readFileSync(join(parentTarget, "debug", "sentinel"), "utf8")).toBe(
    "compiled\n",
  );
});

test("succeeds and creates the worktree even when the parent has no target/", async () => {
  const wt = join(root, "wt-cold");
  const { code } = await run([repo, wt, "fkanban/cold", "main"]);
  expect(code).toBe(0);
  expect(existsSync(join(wt, "README.md"))).toBe(true);
  // No parent target/ → worktree simply starts cold; no target/ created.
  expect(existsSync(join(wt, "target"))).toBe(false);
});

test("refuses to clobber an existing worktree dir", async () => {
  const wt = join(root, "wt-exists");
  mkdirSync(wt);
  const { code, out } = await run([repo, wt, "fkanban/x", "main"]);
  expect(code).not.toBe(0);
  expect(out).toContain("refusing to clobber");
});

test("errors when the repo-root is not a git checkout", async () => {
  const notrepo = join(root, "notrepo");
  mkdirSync(notrepo);
  const { code, out } = await run([notrepo, join(root, "wt2"), "fkanban/y", "main"]);
  expect(code).not.toBe(0);
  expect(out).toContain("not a git checkout");
});
