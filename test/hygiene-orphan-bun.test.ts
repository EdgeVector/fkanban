import { describe, expect, test } from "bun:test";

import {
  bunPileupAlerts,
  classifyOrphanBunCandidates,
  isBunCommand,
  matchOrphanBunCommand,
  orphanBunReport,
  parseEtimeMs,
  parsePsLine,
  type HygieneProcess,
} from "../src/commands/hygiene.ts";

function proc(partial: Partial<HygieneProcess>): HygieneProcess {
  return {
    pid: 100,
    ppid: 1,
    etime: "1-00:00:01",
    rssKb: 1024,
    command: "bun /Users/tomtang/code/edgevector/fkanban/src/cli.ts mcp",
    ...partial,
  };
}

describe("hygiene orphan-bun process parsing", () => {
  test("parses ps rows with a spaced command", () => {
    expect(parsePsLine("  42     1 2-03:04:05  12345 bun /repo/fkanban/src/cli.ts mcp")).toEqual({
      pid: 42,
      ppid: 1,
      etime: "2-03:04:05",
      rssKb: 12345,
      command: "bun /repo/fkanban/src/cli.ts mcp",
    });
  });

  test("parses macOS etime forms into milliseconds", () => {
    expect(parseEtimeMs("12:34")).toBe((12 * 60 + 34) * 1000);
    expect(parseEtimeMs("01:02:03")).toBe(((1 * 60 + 2) * 60 + 3) * 1000);
    expect(parseEtimeMs("2-03:04:05")).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000);
    expect(parseEtimeMs("03:99")).toBeNull();
  });
});

describe("hygiene orphan-bun classifier", () => {
  test("matches only the explicit kanban/fkanban/gstack Bun helper paths", () => {
    expect(matchOrphanBunCommand("bun /x/kanban/src/cli.ts mcp")).toBe("fkanban-mcp");
    expect(matchOrphanBunCommand("/Users/me/.bun/bin/bun /x/kanban/src/mcp/main.ts")).toBe("fkanban-mcp");
    expect(matchOrphanBunCommand("bun /x/fkanban/src/cli.ts mcp")).toBe("fkanban-mcp");
    expect(matchOrphanBunCommand("/Users/me/.bun/bin/bun /x/fkanban/src/mcp/main.ts")).toBe("fkanban-mcp");
    expect(matchOrphanBunCommand("bun /x/gstack/browse/src/server.ts")).toBe("gstack-browse-server");
    expect(matchOrphanBunCommand("bun /x/gstack/apps/browse/src/terminal-agent.ts")).toBe("gstack-terminal-agent");
  });

  test("does not match generic Bun or LastDB/folddb processes", () => {
    expect(isBunCommand("/System/Library/CoreServices/powerd.bundle/powerd")).toBe(false);
    expect(matchOrphanBunCommand("bun /Users/tomtang/.bun/bin/gbrain autopilot")).toBeNull();
    expect(matchOrphanBunCommand("bun /repo/fold_db_node/src/lastdb_server.ts")).toBeNull();
    expect(matchOrphanBunCommand("/usr/local/bin/lastdb_server --socket /Users/tomtang/.folddb/data/folddb.sock")).toBeNull();
  });

  test("requires PPID 1 and age above the threshold", () => {
    const candidates = classifyOrphanBunCandidates([
      proc({ pid: 1 }),
      proc({ pid: 2, ppid: 999 }),
      proc({ pid: 3, etime: "23:59:59" }),
      proc({ pid: 4, command: "bun /x/gstack/browse/src/server.ts" }),
    ]);
    expect(candidates.map((c) => [c.pid, c.match])).toEqual([
      [1, "fkanban-mcp"],
      [4, "gstack-browse-server"],
    ]);
  });

  test("flags same-parent Bun pileups without making them kill candidates", async () => {
    const processes = Array.from({ length: 101 }, (_, i) =>
      proc({ pid: 1000 + i, ppid: 55, command: "bun /tmp/not-allowlisted.ts" }),
    );
    expect(bunPileupAlerts(processes)).toEqual([{ ppid: 55, count: 101 }]);

    const report = await orphanBunReport({ processes, pileupThreshold: 100 });
    expect(report.candidates).toHaveLength(0);
    expect(report.pileupAlerts).toEqual([{ ppid: 55, count: 101 }]);
  });
});
