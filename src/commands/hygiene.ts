export type HygieneProcess = {
  pid: number;
  ppid: number;
  etime: string;
  rssKb: number;
  command: string;
};

export type OrphanBunCandidate = HygieneProcess & {
  ageMs: number;
  match: "fkanban-mcp" | "gstack-browse-server" | "gstack-terminal-agent";
};

export type BunPileupAlert = {
  ppid: number;
  count: number;
};

export type OrphanBunReport = {
  dryRun: boolean;
  minAgeHours: number;
  pileupThreshold: number;
  scanned: number;
  candidates: OrphanBunCandidate[];
  killed: number[];
  failed: Array<{ pid: number; error: string }>;
  pileupAlerts: BunPileupAlert[];
};

const HOUR_MS = 60 * 60 * 1000;

export function parsePsLine(line: string): HygieneProcess | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const rssKb = Number(match[4]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(rssKb)) {
    return null;
  }
  return {
    pid,
    ppid,
    etime: match[3]!,
    rssKb,
    command: match[5]!,
  };
}

export function parseEtimeMs(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const days = Number(match[1] ?? "0");
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (
    !Number.isInteger(days) ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function shellWords(command: string): string[] {
  return command.trim().split(/\s+/).filter((w) => w.length > 0);
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

export function isBunCommand(command: string): boolean {
  const words = shellWords(command);
  if (words.length === 0) return false;
  return basename(words[0]!) === "bun";
}

export function matchOrphanBunCommand(command: string): OrphanBunCandidate["match"] | null {
  if (!isBunCommand(command)) return null;
  const words = shellWords(command);

  const fkanbanCli = words.findIndex((word) => /\/(?:kanban|fkanban)\/src\/cli\.ts$/.test(word));
  if (fkanbanCli >= 0 && words.slice(fkanbanCli + 1).includes("mcp")) {
    return "fkanban-mcp";
  }
  if (words.some((word) => /\/(?:kanban|fkanban)\/src\/mcp\/main\.ts$/.test(word))) {
    return "fkanban-mcp";
  }
  if (/\/gstack(?:\/.*)?\/browse\/src\/server\.ts(?:\s|$)/.test(command)) {
    return "gstack-browse-server";
  }
  if (/\/gstack(?:\/.*)?\/browse\/src\/terminal-agent\.ts(?:\s|$)/.test(command)) {
    return "gstack-terminal-agent";
  }
  return null;
}

export function classifyOrphanBunCandidates(
  processes: HygieneProcess[],
  opts: { minAgeHours?: number } = {},
): OrphanBunCandidate[] {
  const minAgeMs = (opts.minAgeHours ?? 24) * HOUR_MS;
  return processes.flatMap((proc) => {
    if (proc.ppid !== 1) return [];
    const ageMs = parseEtimeMs(proc.etime);
    if (ageMs === null || ageMs <= minAgeMs) return [];
    const match = matchOrphanBunCommand(proc.command);
    return match === null ? [] : [{ ...proc, ageMs, match }];
  });
}

export function bunPileupAlerts(
  processes: HygieneProcess[],
  opts: { threshold?: number } = {},
): BunPileupAlert[] {
  const threshold = opts.threshold ?? 100;
  if (threshold <= 0) return [];
  const byParent = new Map<number, number>();
  for (const proc of processes) {
    if (!isBunCommand(proc.command)) continue;
    byParent.set(proc.ppid, (byParent.get(proc.ppid) ?? 0) + 1);
  }
  return [...byParent.entries()]
    .filter(([, count]) => count > threshold)
    .map(([ppid, count]) => ({ ppid, count }))
    .sort((a, b) => b.count - a.count || a.ppid - b.ppid);
}

async function readProcessTable(): Promise<HygieneProcess[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,etime=,rss=,command="], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`ps failed: ${stderr.trim() || `exit ${code}`}`);
  }
  return stdout.split("\n").map(parsePsLine).filter((p): p is HygieneProcess => p !== null);
}

function killPid(pid: number): { ok: true } | { ok: false; error: string } {
  try {
    process.kill(pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function orphanBunReport(opts: {
  apply?: boolean;
  minAgeHours?: number;
  pileupThreshold?: number;
  processes?: HygieneProcess[];
} = {}): Promise<OrphanBunReport> {
  const processes = opts.processes ?? await readProcessTable();
  const minAgeHours = opts.minAgeHours ?? 24;
  const pileupThreshold = opts.pileupThreshold ?? 100;
  const candidates = classifyOrphanBunCandidates(processes, { minAgeHours });
  const killed: number[] = [];
  const failed: Array<{ pid: number; error: string }> = [];

  if (opts.apply) {
    for (const candidate of candidates) {
      const result = killPid(candidate.pid);
      if (result.ok) killed.push(candidate.pid);
      else failed.push({ pid: candidate.pid, error: result.error });
    }
  }

  return {
    dryRun: !opts.apply,
    minAgeHours,
    pileupThreshold,
    scanned: processes.length,
    candidates,
    killed,
    failed,
    pileupAlerts: bunPileupAlerts(processes, { threshold: pileupThreshold }),
  };
}

function renderAge(ageMs: number): string {
  const hours = Math.floor(ageMs / HOUR_MS);
  return `${hours}h`;
}

export function renderOrphanBunReport(report: OrphanBunReport): string {
  const lines = [
    `orphan-bun hygiene: ${report.candidates.length} candidate(s) of ${report.scanned} process(es) scanned; ` +
      `${report.dryRun ? "DRY RUN, no kills" : `${report.killed.length} signaled`}`,
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `  ${candidate.match}: pid=${candidate.pid} ppid=${candidate.ppid} ` +
        `age=${renderAge(candidate.ageMs)} rss=${candidate.rssKb}KB :: ${candidate.command}`,
    );
  }
  for (const alert of report.pileupAlerts) {
    lines.push(`  PILEUP: ppid=${alert.ppid} has ${alert.count} bun process(es)`);
  }
  for (const failure of report.failed) {
    lines.push(`  FAILED: pid=${failure.pid} ${failure.error}`);
  }
  return lines.join("\n");
}

export async function hygieneOrphanBunCmd(opts: {
  apply?: boolean;
  json?: boolean;
  minAgeHours?: number;
  pileupThreshold?: number;
}): Promise<string> {
  const report = await orphanBunReport(opts);
  return opts.json ? JSON.stringify(report, null, 2) : renderOrphanBunReport(report);
}
