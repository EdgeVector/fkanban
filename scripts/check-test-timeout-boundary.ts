#!/usr/bin/env bun
/**
 * Test-timeout architecture gate: a test that starts a process must carry an
 * explicit timeout. Bun's 5000ms per-test default has no margin for process
 * start cost on a loaded host — two tests crossed it under real CI load
 * (fkanban-deflake-5s-timeouts-boardcards-lag-and-kstress-primary-refusal-20260903,
 * fkanban CI 2026-09-03T17:30Z, 5 live routines + a cargo build).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export type SourceFile = { path: string; content: string };
export type TimeoutViolation = {
  path: string;
  test: string;
  detail: string;
  /** Offset of the test() call's closing `)` in the original file content. */
  closeParen: number;
};

const SPAWN_CALL = /\bBun\.spawn(?:Sync)?\s*\(|\bspawnSync\s*\(|\bexecSync\s*\(|\bexecFileSync\s*\(/;

// A char that can precede a regex literal (vs. division): start-of-expression
// context. Kept intentionally simple — this is a heuristic, not a JS parser.
const REGEX_PRECEDING = /[([{,;:!&|?=+\-*%^~<>]$|(?:^|\W)(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|yield|await)$/;

/**
 * Produce a same-length "masked" copy of `content` safe for naive
 * bracket-depth counting: comments, string bodies, regex-literal bodies, and
 * template-literal static text are blanked to `.` (newlines kept so line
 * numbers survive). Template `${...}` interpolations are recursively masked
 * in place instead of blanked, since they are real code that can itself
 * contain the parens/braces callers are trying to balance.
 *
 * Building one masked pass up front — rather than an `inString` flag inline
 * in every bracket-scanning loop — is what makes it possible to get this
 * right: naive quote-tracking desyncs on nested template literals and mistakes
 * `(kanban|fkanban)` inside a /regex/ literal for real parens (both hit this
 * checker's first draft and produced a 30KB-wide false "test body").
 */
function maskNonCode(content: string): string {
  const out = content.split("");
  const n = content.length;
  let prevSig = "";

  function blank(from: number, to: number): void {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = ".";
  }

  function scan(start: number, stopAtBrace: boolean): number {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = content[i];
      if (c === "/" && content[i + 1] === "/") {
        const s = i;
        while (i < n && content[i] !== "\n") i++;
        blank(s, i);
        continue;
      }
      if (c === "/" && content[i + 1] === "*") {
        const s = i;
        i += 2;
        while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
        i = Math.min(i + 2, n);
        blank(s, i);
        continue;
      }
      if (c === "'" || c === '"') {
        const quote = c;
        const s = i;
        i++;
        while (i < n && content[i] !== quote) { if (content[i] === "\\") i++; i++; }
        i = Math.min(i + 1, n);
        blank(s + 1, i - 1);
        prevSig = quote;
        continue;
      }
      if (c === "`") {
        i++;
        while (i < n) {
          if (content[i] === "\\") { i += 2; continue; }
          if (content[i] === "`") { i++; break; }
          if (content[i] === "$" && content[i + 1] === "{") {
            i = scan(i + 2, true) + 1; // real code — masked recursively, not blanked; +1 consumes the closing `}`
            continue;
          }
          blank(i, i + 1);
          i++;
        }
        prevSig = "`";
        continue;
      }
      if (c === "/" && REGEX_PRECEDING.test(content.slice(Math.max(0, i - 12), i).trimEnd())) {
        const s = i;
        i++;
        let inClass = false;
        while (i < n && (inClass || content[i] !== "/")) {
          if (content[i] === "\\") { i++; }
          else if (content[i] === "[") inClass = true;
          else if (content[i] === "]") inClass = false;
          else if (content[i] === "\n") break; // unterminated — bail, treat as division
          i++;
        }
        if (i < n && content[i] === "/") {
          i++;
          while (i < n && /[a-z]/.test(content[i])) i++; // flags
          blank(s, i);
          prevSig = "/";
          continue;
        }
        i = s; // fall through as ordinary char (division / stray slash)
      }
      if (stopAtBrace && c === "{") depth++;
      if (stopAtBrace && c === "}") {
        if (depth === 0) return i; // caller consumes the closing brace
        depth--;
      }
      if (!/\s/.test(c)) prevSig = c;
      i++;
    }
    return i;
  }

  scan(0, false);
  return out.join("");
}

/** Index of the char matching the opening bracket at `openIndex` (in masked content). */
function matchBracket(content: string, openIndex: number): number {
  const open = content[openIndex];
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const c = content[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a top-level argument list (no surrounding parens) on top-level commas (in masked content). */
function splitArgs(argText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      args.push(argText.slice(start, i));
      start = i + 1;
    }
  }
  const last = argText.slice(start);
  if (last.trim().length > 0) args.push(last);
  return args;
}

/**
 * Find the function body's opening `{` starting the search at `from`.
 * A parameter-list or return-type object literal (`Promise<{ x: number }>`)
 * also opens with `{`, so this skips over any single-line brace pair —
 * function bodies in this codebase are always multi-line.
 */
function findBodyBrace(content: string, from: number): number {
  let i = content.indexOf("{", from);
  while (i !== -1) {
    const end = matchBracket(content, i);
    if (end === -1) return -1;
    if (content.slice(i, end).includes("\n")) return i;
    i = content.indexOf("{", end + 1);
  }
  return -1;
}

/** Names of in-file functions/consts whose body directly spawns a process. */
function findSpawningHelperNames(content: string): Set<string> {
  const names = new Set<string>();
  const declPattern = /\b(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?(?:function)?\s*\()/g;
  let m: RegExpExecArray | null;
  while ((m = declPattern.exec(content))) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    // Skip the parameter list itself before hunting for the body brace, so a
    // destructured param (`{ a, b }: Opts`) is never mistaken for the body.
    const paramOpen = m.index + m[0].length - 1;
    const paramClose = matchBracket(content, paramOpen);
    if (paramClose === -1) continue;
    const braceStart = findBodyBrace(content, paramClose + 1);
    if (braceStart === -1) continue;
    const braceEnd = matchBracket(content, braceStart);
    if (braceEnd === -1) continue;
    const body = content.slice(braceStart, braceEnd);
    if (SPAWN_CALL.test(body)) names.add(name);
  }
  return names;
}

const TEST_KEYWORD = /\b(?:test|it)((?:\.(?:if|skip|only|todo|each)\s*\([^)]*\))*)\s*\(/g;

function findTestTimeoutViolations(files: SourceFile[]): TimeoutViolation[] {
  const violations: TimeoutViolation[] = [];
  for (const file of files) {
    const original = file.content;
    const content = maskNonCode(original); // structural parsing only — literal text is blanked
    const spawningHelpers = findSpawningHelperNames(content);
    TEST_KEYWORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEST_KEYWORD.exec(content))) {
      const openParen = m.index + m[0].length - 1;
      const closeParen = matchBracket(content, openParen);
      if (closeParen === -1) continue;

      // Recover argument boundaries from the masked text (safe to bracket-match),
      // but read the actual test-name text back out of the original file.
      const argText = content.slice(openParen + 1, closeParen);
      const args = splitArgs(argText);
      if (args.length === 0) continue;
      const argOffsets: Array<[number, number]> = [];
      {
        let cursor = openParen + 1;
        for (const a of args) {
          argOffsets.push([cursor, cursor + a.length]);
          cursor += a.length + 1; // skip the comma
        }
      }

      const nameLiteralOriginal = original.slice(argOffsets[0][0], argOffsets[0][1]).trim();
      const nameMatch = /^["'`]((?:\\.|[^"'`])*)["'`]$/.exec(nameLiteralOriginal);
      const testName = nameMatch ? nameMatch[1] : nameLiteralOriginal.slice(0, 60);

      const fullBody = args.length > 1 ? args.slice(1).join(",") : "";

      const spawnsDirectly = SPAWN_CALL.test(fullBody);
      const spawnsViaHelper = [...spawningHelpers].some((h) =>
        new RegExp(`\\b${h}\\s*\\(`).test(fullBody),
      );
      if (!spawnsDirectly && !spawnsViaHelper) continue;

      // Signature is test(name, fn, timeout?) or test(name, options, fn).
      // An explicit timeout is present when there is a 3rd arg that is a bare
      // number/identifier expression (not itself a function).
      const lastArg = args.length >= 1 ? args[args.length - 1].trim() : "";
      const hasThirdArg = args.length >= 3;
      const lastArgIsFunction = /^(?:async\s*)?\(?.*=>|^(?:async\s*)?function\b/s.test(lastArg);
      const hasExplicitTimeout = hasThirdArg && !lastArgIsFunction;

      if (!hasExplicitTimeout) {
        violations.push({
          path: file.path,
          test: testName,
          detail:
            "starts a process without an explicit timeout; the bun 5000ms default has no margin under host load",
          closeParen,
        });
      }
    }
  }
  return violations;
}

function testSources(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  walk(resolve(root, "test"));
  return files;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolute = resolve(dir, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else if (/\.test\.ts$/.test(entry)) {
        const path = relative(root, absolute).replaceAll("\\", "/");
        files.push({ path, content: readFileSync(absolute, "utf8") });
      }
    }
  }
}

export { findTestTimeoutViolations };

/** One-time codemod: insert the shared timeout constant at each violation site. */
function fix(root: string, files: SourceFile[]): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const violations = findTestTimeoutViolations(files);
  const byFile = new Map<string, TimeoutViolation[]>();
  for (const v of violations) {
    const list = byFile.get(v.path) ?? [];
    list.push(v);
    byFile.set(v.path, list);
  }
  for (const [path, vs] of byFile) {
    const file = byPath.get(path)!;
    let content = file.content;
    // Insert from the end of the file backward so earlier offsets stay valid.
    for (const v of [...vs].sort((a, b) => b.closeParen - a.closeParen)) {
      content = content.slice(0, v.closeParen) + ", SPAWN_TEST_TIMEOUT_MS" + content.slice(v.closeParen);
    }
    if (!/from ["']\.\/helpers\/spawn-test-timeout["']/.test(content)) {
      const importLine = 'import { SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn-test-timeout";\n';
      const lastImportMatch = [...content.matchAll(/^import .*\n/gm)].pop();
      if (lastImportMatch) {
        const insertAt = lastImportMatch.index! + lastImportMatch[0].length;
        content = content.slice(0, insertAt) + importLine + content.slice(insertAt);
      } else {
        content = importLine + content;
      }
    }
    Bun.write(resolve(root, path), content);
    console.log(`fixed ${path}: ${vs.length} site(s)`);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  if (process.argv.includes("--fix")) {
    fix(root, testSources(root));
  } else {
    const violations = findTestTimeoutViolations(testSources(root));
    if (violations.length > 0) {
      console.error("Test-timeout architecture boundary FAILED:\n");
      for (const v of violations) {
        console.error(`- ${v.path}: "${v.test}" — ${v.detail}`);
      }
      console.error(`\n${violations.length} violation(s). Add an explicit timeout ms as the`);
      console.error("last test() argument (see test/helpers/spawn-test-timeout.ts).");
      process.exit(1);
    }
    console.log("test-timeout architecture boundary PASSED");
  }
}
