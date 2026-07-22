import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("LastGit artifact producer config", () => {
  test("publishes the compiled F-Kanban artifact bundle", () => {
    const config = JSON.parse(readFileSync(resolve(root, ".lastgit/artifacts.json"), "utf8")) as {
      artifacts?: Array<{ app?: string; paths?: string[] }>;
    };

    expect(config.artifacts).toEqual([{ app: "fkanban", paths: ["dist"] }]);
  });

  test("build script creates executable CLI and MCP aliases under dist", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.build).toBe("bash scripts/build-artifact.sh");

    const script = readFileSync(resolve(root, "scripts/build-artifact.sh"), "utf8");
    for (const name of ["kanban", "fkanban", "kanban-mcp", "fkanban-mcp"]) {
      expect(script).toContain(`dist/${name}`);
    }
    expect(statSync(resolve(root, "scripts/build-artifact.sh")).mode & 0o111).not.toBe(0);
  });

  test("host-track metadata describes verified artifact installation", () => {
    const app = JSON.parse(readFileSync(resolve(root, "fkanban.app.json"), "utf8")) as {
      host_track?: {
        install_mode?: string;
        artifact_app?: string;
        artifact_channel?: string;
        install_root?: string;
        links?: Array<{ source: string; target: string }>;
      };
    };

    expect(app.host_track).toMatchObject({
      install_mode: "artifact",
      artifact_app: "fkanban",
      artifact_channel: "stable",
      install_root: "$HOME/.host-track/apps/fkanban",
    });
    expect(app.host_track?.links).toEqual([
      { source: "dist/kanban", target: "$HOME/.local/bin/kanban" },
      { source: "dist/fkanban", target: "$HOME/.local/bin/fkanban" },
      { source: "dist/kanban-mcp", target: "$HOME/.local/bin/kanban-mcp" },
      { source: "dist/fkanban-mcp", target: "$HOME/.local/bin/fkanban-mcp" },
    ]);
  });
});
