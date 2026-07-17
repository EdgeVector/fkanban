import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pkg from "../package.json";
import { FKANBAN_TOOL_COUNT } from "../src/mcp/server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kanbanShimPath = resolve(here, "../bin/kanban");
const fkanbanShimPath = resolve(here, "../bin/fkanban");
const minimalPath = "/usr/bin:/bin";

let tempRoots: string[] = [];

function homeWithFallbackBun(): string {
  const home = mkdtempSync(resolve(tmpdir(), "fkanban-shim-home-"));
  tempRoots.push(home);
  const bunDir = resolve(home, ".bun/bin");
  mkdirSync(bunDir, { recursive: true });
  symlinkSync(process.execPath, resolve(bunDir, "bun"));
  return home;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? await new Response(stream).text() : "";
}

describe("bin/kanban + bin/fkanban bun resolution", () => {
  afterEach(() => {
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  for (const [name, shimPath] of [["kanban", kanbanShimPath], ["fkanban", fkanbanShimPath]] as const) {
    test(`${name} falls back to $HOME/.bun/bin/bun when GUI PATH omits bun`, async () => {
      const home = homeWithFallbackBun();
      const proc = Bun.spawn([shimPath, "--version"], {
        env: { HOME: home, PATH: minimalPath },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe(pkg.version);
    });
  }

  for (const [name, shimPath] of [["kanban", kanbanShimPath], ["fkanban", fkanbanShimPath]] as const) {
    test(`${name} reports a clear error when bun is unavailable`, async () => {
      const home = mkdtempSync(resolve(tmpdir(), "fkanban-shim-no-bun-"));
      tempRoots.push(home);
      const proc = Bun.spawn([shimPath, "--version"], {
        env: { HOME: home, PATH: minimalPath },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);

      expect(exitCode).toBe(127);
      expect(stdout).toBe("");
      expect(stderr).toContain("bun not found on PATH");
      expect(stderr).toContain("$HOME/.bun/bin/bun");
      expect(stderr).toContain(name);
    });
  }

  for (const [name, shimPath] of [["kanban", kanbanShimPath], ["fkanban", fkanbanShimPath]] as const) {
    test(`${name} starts MCP via the shim when GUI PATH omits bun`, async () => {
      const home = homeWithFallbackBun();
      const transport = new StdioClientTransport({
        command: shimPath,
        args: ["mcp"],
        env: {
          HOME: home,
          PATH: minimalPath,
          FKANBAN_CONFIG: "/nonexistent/fkanban-shim-mcp-test/config.json",
        },
      });
      const client = new Client({ name: "shim-test", version: "0.0.0" });

      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(FKANBAN_TOOL_COUNT);
      } finally {
        await client.close();
      }
    }, 10_000);
  }
});
