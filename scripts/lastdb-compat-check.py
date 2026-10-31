#!/usr/bin/env python3
"""Run the actual F-Kanban CLI against pinned LastDB daemons on generated homes.

Hosted CI only (.github/workflows/lastdb-compat.yml). Each arm owns a fresh
generated home with cloud backup off and talks to the daemon over its owner
socket. The check fails on a wrong count, a wrong column window, a broken page
chain, a CLI refusal, or a daemon error. Timings are advisory.

Arms:
  upgrade  seed and verify on the compatible daemon, then reopen the same home
           on the removal daemon, verify, write more, and verify again.
  fresh    init, seed, write, and verify on the removal daemon, then reopen.

Each verification pass reads every card by primary key (guarded-snapshot) as
the expected state. It then compares the views that use named keys: the list
head window, the per-column list, the full board list, and the milestone view.
It also walks each named-key read page by page with the request that the CLI
sent, and compares the page chain with the cursors that the CLI sent.
"""
import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import time

COLUMNS = ("backlog", "todo", "doing", "done")
TERMINAL = "done"
# A board of its own: the default board adds pickup-lane rules that are not under test.
BOARD = "compat"
SHARES = (("backlog", 0.10), ("todo", 0.30), ("doing", 0.13), ("done", 0.47))
MILESTONES = ("ms-alpha", "ms-beta", "ms-gamma")
QUERY = "compat"
SLUG_STEP = 7919  # A prime step: slug order differs from creation order.
SNAPSHOT_BATCH = 250  # guarded-snapshot accepts at most 256 slugs per call.
WRITE_PROBE_SLUG = "__fkanban_write_probe__"
# The product contract this check enforces. A deliberate change in the source
# must update the check in the same PR.
WINDOW, PAGE_BOUND, TEXT_CAP = 20, 128, 12
SOURCE_CONSTANTS = (
    ("src/column-window.ts", r"export const COLUMN_WINDOW_CAP = (\d+);", WINDOW),
    ("src/query-page-size.ts", r"export const MAX_QUERY_PAGE_SIZE = (\d+);", PAGE_BOUND),
    ("src/commands/list.ts", r"export const DEFAULT_COLUMN_LIMIT = (\d+);", TEXT_CAP),
)
PARTIAL_LINE = "Column list is partial."
STRIP_PREFIXES = ("LASTDB", "FOLD", "KANBAN", "FKANBAN", "SENTRY", "OBS_", "OTEL_", "LASTSEEK", "BRAIN")
SECRET_NAMES = re.compile(r"TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|_KEY$|^ACTIONS_|^AWS_|^GH_")
LOG_ERROR = re.compile(r"\bERROR\b|panicked at|\bFATAL\b")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
REQUEST_LINE = re.compile(r"NODE POST \S*/api/query \[[^\]]*\] body=(\{.*\})\s*$")
SLUG_TOKEN = re.compile(r"\bcc-\d{4,}\b")
SECRET_MARKERS = (
    re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(rb'"(?:private_key|secret_key|signing_key|mnemonic|recovery_phrase|seed_phrase)"\s*:\s*"[^"]{8,}"'),
    re.compile(rb"(?i)recovery phrase\s*[:=]"),
)
MAX_POSITION = 2**53 - 1


class CheckFailure(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise CheckFailure(message)


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_environment():
    return {name: value for name, value in os.environ.items()
            if not name.startswith(STRIP_PREFIXES) and not SECRET_NAMES.search(name)}


def tail(path, limit=4000):
    try:
        return ANSI.sub("", Path(path).read_bytes()[-limit:].decode("utf-8", "replace"))
    except OSError:
        return "(no log)"


# ---------------------------------------------------------------- daemon ----

class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=120):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.unix_path)


def unix_call(path, method, route, body=None, headers=None):
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request_headers = {"X-LastDB-Client": "fkanban-compat-check"}
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    request_headers.update(headers or {})
    connection = UnixConnection(path)
    try:
        connection.request(method, route, payload, request_headers)
        response = connection.getresponse()
        raw = response.read()
    finally:
        connection.close()
    try:
        data = json.loads(raw)
    except ValueError as error:
        raise CheckFailure(f"{method} {route}: HTTP {response.status} returned non-JSON: {raw[:400]!r}") from error
    if response.status != 200 or (isinstance(data, dict) and data.get("ok") is False):
        raise CheckFailure(f"{method} {route}: HTTP {response.status}: {raw[:800]!r}")
    return data.get("data", data) if isinstance(data, dict) else data


class Daemon:
    """One owned generated home. The same home can reopen on another binary."""

    def __init__(self, root, output):
        self.root, self.output = root, output
        self.home = root / "home"
        self.home.mkdir(mode=0o700)
        self.socket = root / "folddb.sock"
        self.full_socket = root / "folddb-full.sock"
        self.owner = {"pid": os.getpid(), "uid": os.getuid(), "root": str(root),
                      "inode": root.stat().st_ino, "generated_data_only": True}
        save(root / "owner.json", self.owner)
        self.process = None
        self.log = None
        self.label = None
        self.errors = []
        self.versions = {}

    def start(self, binary, revision, label):
        require(self.process is None, "The owned daemon is already active")
        environment = clean_environment()
        environment.update(
            LASTDB_ISOLATED_COPY="1", LASTDB_SUPPRESS_RECOVERY_PHRASE="1",
            LASTDB_HOME=str(self.home), FOLDDB_HOME=str(self.home), RUST_MIN_STACK="16777216",
            LASTDB_SELF_METRICS_TO_DB="false", LASTDB_BYTE_BACKUP_V2_ENABLED="false", LASTDB_TTL_SWEEP="0")
        self.label = label
        self.log_path = self.output / f"daemon-{label}.log"
        self.log = self.log_path.open("ab")
        self.process = subprocess.Popen(
            [str(binary), "--data-dir", str(self.home), "--socket-path", str(self.socket),
             "--full-socket-path", str(self.full_socket)],
            env=environment, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 180
        while True:
            if self.process.poll() is not None:
                code = self.process.returncode
                self.process = None
                self.log.close()
                self.scan_log()
                raise CheckFailure(f"Daemon {label} exited with {code} before health (startup refusal).\n"
                                   f"Log tail:\n{tail(self.log_path)}")
            if self.socket.exists():
                try:
                    health = unix_call(self.socket, "GET", "/health")
                except (OSError, http.client.HTTPException, CheckFailure):
                    health = None
                if isinstance(health, dict) and (health.get("ok") is True or health.get("status") == "ok"):
                    break
            if time.monotonic() >= deadline:
                raise CheckFailure(f"Daemon {label} missed its 180 s health deadline.\nLog tail:\n{tail(self.log_path)}")
            time.sleep(0.1)
        version = unix_call(self.socket, "GET", "/api/version")
        save(self.output / f"version-{label}.json", version)
        self.versions[label] = version
        require(f"bench-{revision}" in json.dumps(version),
                f"Daemon {label} does not report the selected revision bench-{revision}")
        self.require_cloud_off(f"{label}-start")

    def require_cloud_off(self, phase):
        status = unix_call(self.socket, "POST", "/api/sync/byte-backup-v2", {"action": "status"})
        kept = {key: status.get(key) for key in ("enabled", "automatic_backup_enabled", "running", "manual_connection")}
        save(self.output / f"cloud-off-{phase}.json", kept)
        require(kept == {"enabled": False, "automatic_backup_enabled": False, "running": False,
                         "manual_connection": None}, f"Cloud backup is not off at {phase}: {kept}")

    def stop(self):
        if self.process is None:
            return
        process, forced = self.process, False
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                forced = True
                process.kill()
                process.wait(timeout=10)
        self.process = None
        self.log.close()
        self.log = None
        receipt_path = self.home / ".shutdown_flush_ready"
        try:
            receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        except ValueError:
            receipt = {"unreadable": True}
        save(self.output / f"shutdown-{self.label}.json",
             {"exit_code": process.returncode, "forced": forced, "receipt": receipt})
        self.scan_log()
        require(not forced and process.returncode == 0 and isinstance(receipt, dict)
                and receipt.get("pid") == process.pid and receipt.get("flush_ok") is True,
                f"Daemon {self.label} lacks a clean shutdown receipt: exit={process.returncode} "
                f"forced={forced} receipt={receipt}")

    def scan_log(self):
        try:
            text = ANSI.sub("", self.log_path.read_bytes().decode("utf-8", "replace"))
        except OSError:
            return
        found = [line.strip()[:600] for line in text.splitlines() if LOG_ERROR.search(line)]
        self.errors.extend({"daemon": self.label, "line": line} for line in found)
        save(self.output / "daemon-errors.json", self.errors)

    def close(self):
        try:
            self.stop()
        finally:
            if self.process is None and self.root.exists():
                identity = self.root.stat()
                if (self.root.is_symlink() or identity.st_uid != os.getuid() or identity.st_ino != self.owner["inode"]
                        or json.loads((self.root / "owner.json").read_text()) != self.owner):
                    raise CheckFailure("The owned home identity changed; refuse cleanup")
                shutil.rmtree(self.root)
                save(self.output / "cleanup.json", {"removed": str(self.root), "daemon_stopped": True})


# ------------------------------------------------------------------- CLI ----

class Cli:
    def __init__(self, binary, daemon, output, arm):
        self.binary, self.daemon, self.output, self.arm = binary, daemon, output, arm
        self.config = daemon.root / "kanban-config.json"
        self.home = daemon.root / "cli-home"
        self.home.mkdir(mode=0o700, exist_ok=True)
        self.samples = []
        self.calls = 0

    def environment(self):
        environment = clean_environment()
        environment.update(HOME=str(self.home), KANBAN_CONFIG=str(self.config), NO_COLOR="1",
                           FKANBAN_DISABLE_BRAIN_CHECKPOINTS="1", LASTSEEK_DISABLE="1")
        return environment

    def run(self, operation, *arguments, verbose=False, parse=True):
        argv = [str(self.binary), *arguments, *(["--verbose"] if verbose else [])]
        started = time.perf_counter_ns()
        try:
            result = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                    env=self.environment(), stdin=subprocess.DEVNULL, timeout=600,
                                    cwd=str(self.daemon.root))
        except subprocess.TimeoutExpired as error:
            raise CheckFailure(f"CLI `kanban {' '.join(arguments)}` exceeded 600 s on daemon {self.daemon.label}") from error
        elapsed = (time.perf_counter_ns() - started) / 1e6
        self.calls += 1
        sample = {"arm": self.arm, "daemon": self.daemon.label, "operation": operation,
                  "elapsed_ms": round(elapsed, 3), "exit": result.returncode}
        self.samples.append(sample)
        with (self.output / "cli-observations.jsonl").open("a") as stream:
            stream.write(json.dumps(sample, sort_keys=True) + "\n")
        if result.returncode != 0:
            (self.output / f"failed-cli-{self.calls:05d}-{operation}.txt").write_text(
                f"argv: kanban {' '.join(arguments)}\nexit: {result.returncode}\n"
                f"--- stdout ---\n{result.stdout[-20000:]}\n--- stderr ---\n{result.stderr[-20000:]}\n")
            raise CheckFailure(
                f"CLI `kanban {' '.join(arguments)}` exited {result.returncode} on daemon {self.daemon.label}.\n"
                f"stderr tail:\n{result.stderr[-3000:]}\nstdout tail:\n{result.stdout[-1500:]}")
        if not parse:
            return result.stdout, result.stderr
        try:
            return json.loads(result.stdout), result.stderr
        except ValueError as error:
            raise CheckFailure(f"CLI `kanban {' '.join(arguments)}` did not print JSON: {result.stdout[:600]!r}") from error


# ------------------------------------------------------------- workload ----

def column_counts(count):
    counts = {column: int(round(count * share)) for column, share in SHARES}
    counts[TERMINAL] += count - sum(counts.values())
    return counts


def slug_for(number):
    return f"cc-{number:04d}"


def plan_cards(count):
    require(math.gcd(SLUG_STEP, count) == 1, "The card count must be coprime with the slug step")
    labels = [column for column, number in column_counts(count).items() for _ in range(number)]
    random.Random(20261030).shuffle(labels)
    return [{"index": index, "slug": slug_for((index * SLUG_STEP) % count), "column": labels[index],
             "milestone": MILESTONES[index % 4] if index % 4 < 3 else ""} for index in range(count)]


def add_card(cli, model, card):
    arguments = ["add", card["slug"], "--board", BOARD, "--title", f"Compat record {card['index']:04d}", "--column", card["column"],
                 "--kind", "meta", "--body", f"Generated compatibility record {card['index']}.", "--json"]
    if card["milestone"]:
        arguments += ["--milestone", card["milestone"]]
    receipt, _ = cli.run("add", *arguments)
    require(receipt.get("action") == "created" and receipt.get("column") == card["column"],
            f"add {card['slug']} returned {receipt}")
    model[card["slug"]] = {"column": card["column"], "milestone": card["milestone"]}


def init_home(cli, daemon):
    cli.run("init", "init", "--node-socket-path", str(daemon.socket), "--name", "fkanban compat CI", parse=False)
    config = json.loads(cli.config.read_text())
    require(config.get("storageModel") == "multi-key-v1", f"init did not select multi-key schemas: {config.get('storageModel')}")
    require({"card", "board", "milestone"} <= set(config.get("schemaHashes", {})), "init did not pin the card, board, and milestone schemas")
    catalog = unix_call(daemon.socket, "GET", "/api/schemas", headers={"X-User-Hash": config["userHash"]})
    owned = [schema for schema in catalog.get("schemas", []) if schema.get("owner_app_id") == "fkanban"]
    summary = [{"name": schema.get("name"), "descriptive_name": schema.get("descriptive_name"),
                "independent_fields": schema.get("independent_fields"),
                "alternate_keys": sorted((schema.get("alternate_keys") or {}).keys())} for schema in owned]
    save(cli.output / f"owned-schemas-{daemon.label}.json", summary)
    require(owned and all(schema.get("independent_fields") is True for schema in owned),
            f"An owned F-Kanban schema lacks independent values: {summary}")
    card = [item for item in summary if item["name"] == config["schemaHashes"]["card"]]
    require(len(card) == 1 and {"all", "by_board", "by_milestone"} <= set(card[0]["alternate_keys"]),
            f"The card schema lacks its named keys: {card}")


def seed(cli, model, count):
    receipt, _ = cli.run("board-create", "board", "create", BOARD, "--title", "Compat board", "--json")
    require(receipt.get("action") == "created", f"board create {BOARD} returned {receipt}")
    for milestone in MILESTONES:
        cli.run("milestone-add", "milestone", "add", milestone, "--board", BOARD, "--title",
                f"Compat milestone {milestone[3:]}", "--state", "active", "--body", "Generated compatibility milestone.", "--json")
    for card in plan_cards(count):
        add_card(cli, model, card)


def mutate(cli, state, model, removed, round_number, new_cards):
    """Moves change named-key ranges; removes and new cards change membership."""
    expect = windows(state)
    todo, done, doing = expect["todo"]["window"], expect["done"]["window"], expect["doing"]["window"]
    require(len(todo) >= 8 and len(done) >= 7 and len(doing) >= 5, "The seed is too small for the write round")
    to_done, to_todo, to_backlog = todo[:5], done[-5:], doing[:5]
    removes = todo[5:8] + done[:2]
    for slug in to_done:
        receipt, _ = cli.run("move", "move", slug, "done", "--json")
        require(receipt.get("to") == "done", f"move {slug} done returned {receipt}")
        model[slug]["column"] = "done"
    for offset, slug in enumerate(to_todo):
        # An explicit small position puts the card at the head of the todo window.
        position = str(100 * round_number + 10 * offset)
        receipt, _ = cli.run("move", "move", slug, "todo", "--position", position, "--json")
        require(receipt.get("to") == "todo", f"move {slug} todo returned {receipt}")
        model[slug]["column"] = "todo"
    for slug in to_backlog:
        receipt, _ = cli.run("move", "move", slug, "backlog", "--json")
        require(receipt.get("to") == "backlog", f"move {slug} backlog returned {receipt}")
        model[slug]["column"] = "backlog"
    for slug in removes:
        cli.run("rm", "rm", slug, "--json")
        removed.add(slug)
        del model[slug]
    for card in new_cards:
        add_card(cli, model, card)


# ------------------------------------------------------------ expectation ----

def parse_position(value):
    match = re.match(r"\s*[+-]?\d+", str(value or ""))
    return int(match.group(0)) if match else MAX_POSITION


def order_key(card):
    # src/record.ts sortCards and src/column-window.ts capComplete.
    return (parse_position(card["position"]), card["created_at"])


def windows(state):
    out = {}
    for column in COLUMNS:
        members = sorted((slug for slug, card in state.items() if card["column"] == column),
                         key=lambda slug: order_key(state[slug]))
        window = members[-WINDOW:] if column == TERMINAL else members[:WINDOW]
        out[column] = {"all": members, "window": window}
    return out


def snapshot(cli, slugs):
    """Read slugs by primary key with the guarded-snapshot command (no named key)."""
    records = {}
    path = cli.daemon.root / "snapshot-slugs.json"
    for start in range(0, len(slugs), SNAPSHOT_BATCH):
        chunk = slugs[start:start + SNAPSHOT_BATCH]
        path.write_text(json.dumps(chunk))
        batch, _ = cli.run("primary-key-snapshot", "guarded-snapshot", "--slugs-file", str(path))
        items = batch.get("items")
        require(isinstance(items, list) and [item.get("slug") for item in items] == chunk,
                "The primary-key snapshot did not return each requested slug once, in order")
        for item in items:
            if item.get("missing") is True:
                records[item["slug"]] = None
                continue
            fields = json.loads(item["snapshot_json"])["fields"]
            records[item["slug"]] = {name: fields.get(name) for name in
                                     ("slug", "board", "column", "position", "created_at", "milestone")}
    return records


def oracle(cli, model, removed, failures):
    """The expected state: every live card by primary key, checked against the CLI writes."""
    records = snapshot(cli, sorted(model))
    problems = []
    for slug, wanted in sorted(model.items()):
        record = records[slug]
        if record is None:
            problems.append(f"{slug}: created, but the primary key does not return it")
        elif (record["board"], record["column"], record["milestone"] or "") != (BOARD, wanted["column"], wanted["milestone"]):
            problems.append(f"{slug}: primary key has board={record['board']} column={record['column']} "
                            f"milestone={record['milestone']}; the writes expect column={wanted['column']} "
                            f"milestone={wanted['milestone']}")
    require(not problems, "The primary-key state differs from the CLI writes:\n" + "\n".join(problems[:40]))
    if removed:
        try:
            gone = snapshot(cli, sorted(removed))
            remaining = sorted(slug for slug, record in gone.items() if record is not None)
            if remaining:
                failures.append(f"rm: the primary key still returns removed cards {remaining}")
        except CheckFailure as error:
            failures.append(f"primary-key snapshot of removed cards failed:\n{error}")
    return {slug: records[slug] for slug in model}


def describe(slugs, state):
    return " ".join(f"{slug}@{state[slug]['position']}" if slug in state else f"{slug}@?" for slug in slugs)


def compare_sequence(failures, view, found, expected, state, ordered=True):
    if found == expected or (not ordered and sorted(found) == sorted(expected)):
        return True
    missing = [slug for slug in expected if slug not in set(found)]
    extra = [slug for slug in found if slug not in set(expected)]
    lines = [f"MISMATCH {view}: expected {len(expected)}, found {len(found)}"]
    if len(expected) <= 40 and len(found) <= 40:
        lines += [f"  expected: {describe(expected, state)}", f"  found:    {describe(found, state)}"]
    lines += [f"  missing ({len(missing)}): {describe(missing[:30], state)}",
              f"  extra ({len(extra)}): {describe(extra[:30], state)}"]
    if not missing and not extra:
        first = next(index for index, (a, b) in enumerate(zip(found, expected)) if a != b)
        lines.append(f"  same members, order differs first at index {first}: found {found[first]}, expected {expected[first]}")
    duplicates = sorted({slug for slug in found if found.count(slug) > 1})
    if duplicates:
        lines.append(f"  duplicates: {' '.join(duplicates[:20])}")
    failures.append("\n".join(lines))
    return False


# ------------------------------------------------------------ page walks ----

def cli_walks(stderr, view, failures):
    """Group the named-key requests that the CLI logged with --verbose."""
    walks, active = [], {}
    for line in stderr.splitlines():
        match = REQUEST_LINE.search(line)
        if not match:
            continue
        try:
            body = json.loads(match.group(1))
        except ValueError:
            failures.append(f"{view}: unreadable request log line {line[:300]!r}")
            continue
        if not body.get("key_name"):
            continue
        first = {key: value for key, value in body.items() if key != "cursor"}
        ident = json.dumps(first, sort_keys=True)
        if body.get("cursor") in (None, ""):
            walk = {"view": view, "ident": ident, "body": first, "cursors": []}
            walks.append(walk)
            active[ident] = walk
        elif ident in active:
            active[ident]["cursors"].append(body["cursor"])
        else:
            failures.append(f"{view}: the CLI sent a continuation without a first page: {ident[:300]}")
    return walks


def expected_members(body, state, schemas):
    """The records a named-key read must return, or None for a key outside this workload."""
    schema, name = body.get("schema_name"), body.get("key_name")
    query_filter = body.get("filter") or {}
    prefix = query_filter.get("HashRangePrefix") or {}
    if schema == schemas["milestone"] and name == "by_board" and query_filter.get("HashKey") == BOARD:
        return set(MILESTONES)
    if schema != schemas["card"]:
        return None
    if name == "by_board" and query_filter.get("HashKey") == BOARD:
        return set(state)
    if name == "by_board" and prefix.get("hash") == BOARD and str(prefix.get("prefix", "")).endswith("#"):
        column = prefix["prefix"][:-1]
        return {slug for slug, card in state.items() if card["column"] == column}
    if name == "by_milestone" and query_filter.get("HashKey") in MILESTONES:
        return {slug for slug, card in state.items() if card["milestone"] == query_filter["HashKey"]}
    return None


def server_walk(daemon, user_hash, body):
    pages, rows, cursor = [], [], None
    for _ in range(10000):
        request = dict(body)
        if cursor is not None:
            request["cursor"] = cursor
        page = unix_call(daemon.socket, "POST", "/api/query", request, {"X-User-Hash": user_hash})
        results, has_more = page.get("results"), page.get("has_more")
        require(isinstance(results, list) and isinstance(has_more, bool),
                f"A named-key page lacks results or has_more: {json.dumps(page)[:400]}")
        pages.append({"rows": len(results), "has_more": has_more,
                      "next_cursor": page.get("next_cursor") if has_more else None,
                      "unresolved_rows": page.get("unresolved_rows")})
        rows.extend(results)
        if not has_more:
            return pages, rows
        require(page.get("next_cursor"), "A named-key page has has_more without next_cursor")
        require(page["next_cursor"] != cursor, "The server cursor did not advance")
        cursor = page["next_cursor"]
    raise CheckFailure("A named-key walk exceeded 10000 pages")


def check_walks(daemon, config, walks, state, failures):
    user_hash, schemas = config["userHash"], config["schemaHashes"]
    summaries = []
    by_ident = {}
    for walk in walks:
        by_ident.setdefault(walk["ident"], []).append(walk)
    for ident, group in by_ident.items():
        body = group[0]["body"]
        kind = next((key for key in ("card", "milestone", "board") if schemas.get(key) == body.get("schema_name")), "other")
        label = (f"{kind}.{body.get('key_name')} {json.dumps(body.get('filter'), sort_keys=True)} "
                 f"limit={body.get('limit')} fields={len(body.get('fields') or [])}")
        try:
            first_pages, rows = server_walk(daemon, user_hash, body)
            second_pages, _ = server_walk(daemon, user_hash, body)
        except CheckFailure as error:
            failures.append(f"PAGE CHAIN {label}: the server walk failed: {error}")
            summaries.append({"key": label, "views": sorted({walk["view"] for walk in group}), "limit": body.get("limit"),
                              "pages": 0, "page_rows": [], "records": 0, "expected": None, "ok": False})
            continue
        chain = [page["next_cursor"] for page in first_pages[:-1]]
        deterministic = chain == [page["next_cursor"] for page in second_pages[:-1]]
        limit = body.get("limit")
        problems = []
        if isinstance(limit, int) and any(page["rows"] > limit for page in first_pages):
            problems.append(f"a page exceeds its limit {limit}: {[page['rows'] for page in first_pages]}")
        if any(page.get("unresolved_rows") not in (None, 0) for page in first_pages):
            problems.append(f"unresolved rows: {[page.get('unresolved_rows') for page in first_pages]}")
        keys = [json.dumps(row.get("key"), sort_keys=True) for row in rows]
        if len(set(keys)) != len(keys):
            problems.append("the pages repeat a primary record")
        ranges = [str((row.get("matched_key") or {}).get("range")) for row in rows]
        if ranges != sorted(ranges) or len(set(ranges)) != len(ranges):
            bad = next((index for index in range(1, len(ranges)) if ranges[index] <= ranges[index - 1]), None)
            problems.append(f"the page chain is not in strict range order (first break at row {bad})")
        found = [str((row.get("key") or {}).get("hash")) for row in rows if (row.get("key") or {}).get("hash") != WRITE_PROBE_SLUG]
        members = expected_members(body, state, schemas)
        if members is not None:
            if set(found) != members or len(found) != len(members):
                missing, extra = sorted(members - set(found)), sorted(set(found) - members)
                problems.append(f"server pages hold {len(found)} records, expected {len(members)}; "
                                f"missing {missing[:20]} extra {extra[:20]}")
            if isinstance(limit, int) and len(members) > limit and len(first_pages) < 2:
                problems.append(f"{len(members)} records > limit {limit}, but the server returned one page")
        for walk in group:
            sent = walk["cursors"]
            if len(sent) + 1 != len(first_pages):
                problems.append(f"{walk['view']}: the CLI read {len(sent) + 1} pages; the server chain has {len(first_pages)}")
            if len({json.dumps(cursor, sort_keys=True) for cursor in sent}) != len(sent):
                problems.append(f"{walk['view']}: the CLI sent a repeated cursor")
            if deterministic and sent != chain[:len(sent)]:
                problems.append(f"{walk['view']}: a CLI cursor differs from the server next_cursor chain")
        if problems:
            failures.append(f"PAGE CHAIN {label}:\n  " + "\n  ".join(problems))
        summaries.append({"key": label, "views": sorted({walk["view"] for walk in group}), "limit": limit, "pages": len(first_pages),
                          "page_rows": [page["rows"] for page in first_pages], "records": len(found),
                          "expected": None if members is None else len(members),
                          "cursor_tokens_deterministic": deterministic,
                          "cli_cursors_match_server": deterministic and all(walk["cursors"] == chain for walk in group),
                          "ok": not problems})
    return summaries


# ------------------------------------------------------------ the checks ----

def check_list(cli, state, expect, failures, walks):
    partial = any(len(expect[column]["all"]) > WINDOW for column in COLUMNS)
    page, _ = cli.run("list-head-json", "list", "--board", BOARD, "--json", "--all")
    cards = page.get("cards") or []
    for column in COLUMNS:
        found = [card["slug"] for card in cards if card.get("column") == column]
        compare_sequence(failures, f"list --json --all, column {column} ({len(expect[column]['all'])} cards)",
                         found, expect[column]["window"], state)
    stray = sorted({card.get("column") for card in cards} - set(COLUMNS))
    if stray:
        failures.append(f"list --json --all returned unknown columns {stray}")
    if page.get("partial") is not partial or page.get("total") != sum(len(expect[c]["window"]) for c in COLUMNS):
        failures.append(f"list --json --all: partial={page.get('partial')} total={page.get('total')}; "
                        f"expected partial={partial} total={sum(len(expect[c]['window']) for c in COLUMNS)}")
    for column in COLUMNS:
        page, stderr = cli.run("list-head-column", "list", "--board", BOARD, "--column", column, "--json", "--all",
                               verbose=True)
        cards = page.get("cards") or []
        view = f"list --column {column} --json --all ({len(expect[column]['all'])} cards)"
        compare_sequence(failures, view, [card["slug"] for card in cards], expect[column]["window"], state)
        stale = [card["slug"] for card in cards if card["slug"] in state
                 and (card.get("position"), card.get("column")) != (state[card["slug"]]["position"], column)]
        if stale:
            failures.append(f"{view}: stale position or column for {describe(stale[:20], state)}")
        if page.get("partial") is not (len(expect[column]["all"]) > WINDOW):
            failures.append(f"{view}: partial={page.get('partial')}, expected {len(expect[column]['all']) > WINDOW}")
        walks.extend(cli_walks(stderr, f"list --column {column}", failures))
    text, _ = cli.run("list-head-text", "list", "--board", BOARD, parse=False)
    visible = []
    for column in COLUMNS:
        window = expect[column]["window"]
        visible += window if len(window) <= TEXT_CAP else (window[-TEXT_CAP:] if column == TERMINAL else window[:TEXT_CAP])
    compare_sequence(failures, "list (text, 12 per column)", SLUG_TOKEN.findall(text), visible, state)
    if partial and PARTIAL_LINE not in text:
        failures.append("list (text): the partial-column line is absent")


def check_search(cli, state, expect, failures, walks):
    everything = sorted(state, key=lambda slug: order_key(state[slug]))
    page, stderr = cli.run("full-list-board", "search", QUERY, "--board", BOARD, "--json", "--all", verbose=True)
    found = [card["slug"] for card in page.get("cards") or []]
    compare_sequence(failures, f"search {QUERY} --board {BOARD} --all (full board list)", found, everything, state)
    if page.get("total") != len(everything) or page.get("truncated") not in (False, None):
        failures.append(f"full board list: total={page.get('total')} truncated={page.get('truncated')}; expected total={len(everything)}")
    walks.extend(cli_walks(stderr, "search --board", failures))
    for column in COLUMNS:
        page, stderr = cli.run("full-list-column", "search", QUERY, "--board", BOARD, "--column", column,
                               "--json", "--all", verbose=True)
        found = [card["slug"] for card in page.get("cards") or []]
        compare_sequence(failures, f"search --column {column} --all (full column list, {len(expect[column]['all'])} cards)",
                         found, expect[column]["all"], state)
        walks.extend(cli_walks(stderr, f"search --column {column}", failures))


def check_milestones(cli, state, failures, walks):
    listing, _ = cli.run("milestone-list", "milestone", "list", "--board", BOARD, "--json", parse=False)
    for milestone in MILESTONES:
        if milestone not in listing:
            failures.append(f"milestone list --json does not name {milestone}")
    for milestone in MILESTONES:
        detail, stderr = cli.run("milestone-detail", "milestone", "detail", milestone, "--json", verbose=True)
        columns = detail.get("columns") or {}
        for column in sorted(set(COLUMNS) | set(columns)):
            found = [item.get("slug") for item in columns.get(column) or []]
            expected = [slug for slug in sorted(state) if state[slug]["milestone"] == milestone and state[slug]["column"] == column]
            compare_sequence(failures, f"milestone detail {milestone}, column {column}", found, expected, state, ordered=False)
        walks.extend(cli_walks(stderr, f"milestone detail {milestone}", failures))


def check_show(cli, state, expect, failures):
    sample = []
    for column in COLUMNS:
        window = expect[column]["window"]
        sample += [slug for slug in (window[:1] + window[-1:]) if slug not in sample]
    for slug in sample:
        card, _ = cli.run("show", "show", slug, "--json")
        if (card.get("column"), card.get("position")) != (state[slug]["column"], state[slug]["position"]):
            failures.append(f"show {slug}: column={card.get('column')} position={card.get('position')}; "
                            f"primary key has column={state[slug]['column']} position={state[slug]['position']}")


def verify(cli, daemon, model, removed, label, passes):
    started = time.monotonic()
    failures, walks = [], []
    state = oracle(cli, model, removed, failures)
    expect = windows(state)
    check_list(cli, state, expect, failures, walks)
    check_search(cli, state, expect, failures, walks)
    check_milestones(cli, state, failures, walks)
    check_show(cli, state, expect, failures)
    pages = check_walks(daemon, json.loads(cli.config.read_text()), walks, state, failures)
    checked = [walk for walk in pages if walk["expected"] is not None and walk["key"].startswith("card.by_board")]
    if len(checked) < len(COLUMNS) + 1:
        failures.append(f"Only {len(checked)} card board-key page chains had a membership check; "
                        f"expected at least {len(COLUMNS) + 1}. The CLI request log or schema names changed.")
    if not any(walk["limit"] == PAGE_BOUND and walk["pages"] >= 2 for walk in checked):
        failures.append(f"No card board-key read crossed the {PAGE_BOUND}-row page bound; the workload no longer tests it.")
    daemon.require_cloud_off(f"{daemon.label}-{label}")
    result = {"arm": cli.arm, "pass": label, "daemon": daemon.label, "cards": len(state), "removed": len(removed),
              "columns": {column: {"cards": len(expect[column]["all"]), "window": expect[column]["window"]} for column in COLUMNS},
              "page_walks": pages, "failures": failures, "seconds": round(time.monotonic() - started, 1)}
    save(cli.output / f"pass-{daemon.label}-{label}.json", result)
    passes.append(result)
    if failures:
        raise CheckFailure(f"{len(failures)} check(s) failed in arm {cli.arm}, pass {label}, daemon {daemon.label}:\n\n"
                           + "\n\n".join(failures))
    print(json.dumps({"arm": cli.arm, "pass": label, "daemon": daemon.label, "cards": len(state),
                      "page_walks": len(pages), "seconds": result["seconds"]}), flush=True)
    return state


# ------------------------------------------------------------------ arms ----

def run_arm(args, name, daemons, passes, samples):
    output = args.output / name
    output.mkdir(mode=0o700)
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    daemon = Daemon(Path(tempfile.mkdtemp(prefix="fk-", dir=runner)).resolve(), output)
    cli = Cli(args.cli, daemon, output, name)
    failed = True
    try:
        (first_binary, first_revision, first_label), (last_binary, last_revision, last_label) = daemons
        model, removed = {}, set()
        daemon.start(first_binary, first_revision, first_label)
        init_home(cli, daemon)
        seed(cli, model, args.cards)
        state = verify(cli, daemon, model, removed, "seeded", passes)
        mutate(cli, state, model, removed, 1, [])
        state = verify(cli, daemon, model, removed, "after-writes", passes)
        daemon.stop()
        daemon.start(last_binary, last_revision, last_label)
        state = verify(cli, daemon, model, removed, "reopened", passes)
        if name == "upgrade":
            extra = [{"index": args.cards + offset, "slug": slug_for(args.cards + offset),
                      "column": "todo" if offset < 5 else "done", "milestone": MILESTONES[offset % 3]}
                     for offset in range(10)]
            mutate(cli, state, model, removed, 2, extra)
            verify(cli, daemon, model, removed, "after-upgrade-writes", passes)
        daemon.stop()
        require(not daemon.errors, "The daemon logged errors:\n" + "\n".join(
            f"[{item['daemon']}] {item['line']}" for item in daemon.errors[:30]))
        failed = False
    finally:
        samples.extend(cli.samples)
        try:
            daemon.close()
        except CheckFailure as error:
            if not failed:
                raise
            print(f"cleanup after failure: {error}", file=sys.stderr)


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def render(args, passes, samples, failure):
    lines = ["## F-Kanban LastDB compatibility (actual CLI)", "",
             f"App: `{args.app_revision}`. CLI: `dist/kanban` from `bun run build` in this job.",
             f"Compatible daemon (before): `{args.daemon_before_revision}`. Removal daemon (after): `{args.daemon_after_revision}`.",
             f"Each arm uses a fresh generated home, cloud backup off, and the owner socket. Seed: {args.cards} cards "
             f"({', '.join(f'{c} {n}' for c, n in column_counts(args.cards).items())}), {len(MILESTONES)} milestones.",
             f"Checks: the {WINDOW}-card list head window per column, the text view, the full board and column lists, "
             f"milestone membership, primary-key state, and each named-key page chain (page bound {PAGE_BOUND}).", "",
             "| Arm | Pass | Daemon | Cards | backlog / todo / doing / done | Page walks (pages) | Result |",
             "|---|---|---|---:|---|---|---|"]
    for item in passes:
        counts = " / ".join(str(item["columns"][column]["cards"]) for column in COLUMNS)
        walks = ", ".join(f"{walk['pages']}" for walk in item["page_walks"])
        lines.append(f"| {item['arm']} | {item['pass']} | {item['daemon']} | {item['cards']} | {counts} | "
                     f"{len(item['page_walks'])} ({walks}) | {'pass' if not item['failures'] else 'FAIL'} |")
    lines += ["", f"Result: **{'PASS' if failure is None else 'FAIL'}**", ""]
    if failure is not None:
        lines += ["```text", failure[:6000], "```", ""]
    lines += ["### Advisory timings", "",
              "CLI process wall time in ms. It includes process start and every app request. Speed is advisory.", "",
              "| Arm | Daemon | Operation | Calls | P50 | P95 | Max |", "|---|---|---|---:|---:|---:|---:|"]
    groups = {}
    for sample in samples:
        groups.setdefault((sample["arm"], sample["daemon"], sample["operation"]), []).append(sample["elapsed_ms"])
    for (arm, daemon, operation), values in sorted(groups.items()):
        lines.append(f"| {arm} | {daemon} | {operation} | {len(values)} | {statistics.median(values):.1f} | "
                     f"{percentile(values, .95):.1f} | {max(values):.1f} |")
    return "\n".join(lines) + "\n"


def audit(output):
    """Refuse an upload that holds key material. Generated card data is public."""
    require(output.is_dir() and not output.is_symlink(), "The retained output directory is absent or unsafe")
    files = []
    for entry in output.iterdir():  # Fixed depth two: result files and one directory per arm.
        require(not entry.is_symlink(), f"A retained path is a symlink: {entry}")
        if entry.is_dir():
            for child in entry.iterdir():
                require(child.is_file() and not child.is_symlink(), f"A nested retained path is not a file: {child}")
                files.append(child)
        else:
            files.append(entry)
    require(files, "There is no output to retain")
    for path in files:
        require(path.stat().st_size <= 64 * 1024 * 1024, f"A retained file exceeds 64 MiB: {path.name}")
        data = path.read_bytes()
        for marker in SECRET_MARKERS:
            require(not marker.search(data), f"{path.name} matches a key-material marker; do not upload it")
    print(f"Retained output check passed for {len(files)} files.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("cli", "app-source", "daemon-before", "daemon-after", "output"):
        parser.add_argument("--" + name, type=Path, required=name == "output")
    for name in ("app-revision", "daemon-before-revision", "daemon-after-revision"):
        parser.add_argument("--" + name)
    parser.add_argument("--cards", type=int, default=1000)
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "This check runs on hosted CI only")
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    require(args.output.resolve().parent == runner, "The output must be a direct child of the runner temporary directory")
    if args.audit_only:
        audit(args.output)
        return
    require(all(getattr(args, name) for name in ("cli", "app_source", "daemon_before", "daemon_after", "app_revision",
                                                 "daemon_before_revision", "daemon_after_revision")),
            "All program paths and exact source revisions are required")
    require(all(re.fullmatch(r"[0-9a-f]{40}", getattr(args, name)) for name in
                ("app_revision", "daemon_before_revision", "daemon_after_revision")), "Exact 40-hex revisions are required")
    require(200 <= args.cards <= 9000, "Use 200 to 9000 seed cards")
    for relative, pattern, wanted in SOURCE_CONSTANTS:
        match = re.search(pattern, (args.app_source / relative).read_text())
        require(match and int(match.group(1)) == wanted,
                f"{relative} no longer declares {wanted}; update this check with the product contract")
    require(not args.output.exists(), "A fresh output path is required")
    args.output.mkdir(mode=0o700)
    sources = {"app_revision": args.app_revision, "cli_sha256": file_hash(args.cli),
               "daemon_before_revision": args.daemon_before_revision, "daemon_before_sha256": file_hash(args.daemon_before),
               "daemon_after_revision": args.daemon_after_revision, "daemon_after_sha256": file_hash(args.daemon_after),
               "cards": args.cards, "column_counts": column_counts(args.cards)}
    save(args.output / "sources.json", sources)
    before = (args.daemon_before, args.daemon_before_revision, "before")
    after = (args.daemon_after, args.daemon_after_revision, "after")
    passes, samples, failures = [], [], []
    try:
        # The arms are independent homes. A failure in one arm does not hide the other.
        for name, daemons in (("upgrade", (before, after)),
                              ("fresh", (after, (args.daemon_after, args.daemon_after_revision, "after-reopen")))):
            try:
                run_arm(args, name, daemons, passes, samples)
            except CheckFailure as error:
                failures.append(f"[arm {name}] {error}")
                print(f"FAIL [arm {name}]: {error}", file=sys.stderr, flush=True)
    finally:
        failure = "\n\n".join(failures) if failures else None
        text = render(args, passes, samples, failure)
        (args.output / "summary.md").write_text(text)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write(text)
        save(args.output / "result.json", {"complete": failure is None, "failure": failure, "sources": sources,
                                           "passes": passes})
    if failure is not None:
        sys.exit(1)


if __name__ == "__main__":
    main()
