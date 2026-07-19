import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { resolveSocketPath } from "../src/config.ts";

const ORIGINAL_ENV = {
  FOLDDB_SOCKET_PATH: process.env.FOLDDB_SOCKET_PATH,
  LASTDB_HOME: process.env.LASTDB_HOME,
  FOLDDB_HOME: process.env.FOLDDB_HOME,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearSocketEnv(): void {
  delete process.env.FOLDDB_SOCKET_PATH;
  delete process.env.LASTDB_HOME;
  delete process.env.FOLDDB_HOME;
}

afterEach(() => {
  restoreEnv();
});

describe("resolveSocketPath precedence", () => {
  test("explicit socket path wins over home and config overrides", () => {
    clearSocketEnv();
    process.env.FOLDDB_SOCKET_PATH = "/tmp/fkanban-explicit.sock";
    process.env.LASTDB_HOME = "/tmp/fkanban-lastdb-home";

    expect(resolveSocketPath({ nodeSocketPath: "/tmp/fkanban-config.sock" })).toBe(
      "/tmp/fkanban-explicit.sock",
    );
  });

  test("LASTDB_HOME wins over persisted config socket path", () => {
    clearSocketEnv();
    process.env.LASTDB_HOME = "/tmp/fkanban-lastdb-home";

    expect(resolveSocketPath({ nodeSocketPath: "/tmp/fkanban-config.sock" })).toBe(
      join("/tmp/fkanban-lastdb-home", "data", "folddb.sock"),
    );
  });

  test("FOLDDB_HOME wins over persisted config socket path when LASTDB_HOME is absent", () => {
    clearSocketEnv();
    process.env.FOLDDB_HOME = "/tmp/fkanban-folddb-home";

    expect(resolveSocketPath({ nodeSocketPath: "/tmp/fkanban-config.sock" })).toBe(
      join("/tmp/fkanban-folddb-home", "data", "folddb.sock"),
    );
  });

  test("persisted config socket path is used when no env override is set", () => {
    clearSocketEnv();

    expect(resolveSocketPath({ nodeSocketPath: "/tmp/fkanban-config.sock" })).toBe(
      "/tmp/fkanban-config.sock",
    );
  });
});
