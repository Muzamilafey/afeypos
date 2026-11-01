/**
 * "Find ETR on this computer": looks on the Afey POS computer for what an ETR device needs, so the owner can pick it
 * instead of typing addresses:
 *  - ETR / fiscal programs that are installed or running (Tremol, ZFPLab, Datecs, Daisy, fiscal, ETR, TIMS, ESD...),
 *    and the local web addresses they listen on (checked: does it answer?);
 *  - ETR inbox / outbox folders (folder exchange);
 *  - the device itself among the USB and COM-port devices (shown so the owner knows it is seen; the program uses it).
 * Nothing found is used until the owner picks it and presses Test.
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import { execFile } from 'node:child_process';

/** Names ETR and fiscal device programs and drivers commonly carry. */
export const ETR_NAME = /tremol|zfp|datecs|daisy|fiscal|fiskal|\betr\b|etr[\s_-]|tims|\besd\b|kra|cuin|control.?unit|elite.?pos|eltrade|incotex|\bfp-?\d/i;

export interface EtrCandidate {
  kind: 'http' | 'folder' | 'program' | 'device';
  /** What to show: the program, folder pair or device name. */
  name: string;
  url?: string;
  inbox?: string;
  outbox?: string;
  port?: number;
  /** http: whether it answered just now. */
  answers?: boolean;
  detail?: string;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  run: (cmd: string, args: string[]) => Promise<string>;
  listDirs: (p: string) => string[];
  probe: (url: string) => Promise<boolean>;
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 15_000, maxBuffer: 8_000_000 }, (_err, out) => resolve(String(out ?? ''))));

export const realDeps: DetectDeps = {
  platform: process.platform,
  run,
  listDirs: (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } },
  probe: async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return r.status > 0;
    } catch {
      return false;
    }
  },
};

const ps = (deps: DetectDeps, script: string) => deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
const json = <T>(text: string): T[] => {
  try {
    const v = JSON.parse(text.trim() || '[]');
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
};

/** Programs (running processes and installed software) and the TCP ports each process listens on. */
async function programsAndPorts(deps: DetectDeps) {
  const programs: { name: string; pid?: number; path?: string }[] = [];
  const listening: { port: number; pid?: number; name?: string }[] = [];
  if (deps.platform === 'win32') {
    const procs = json<{ Name: string; Id: number; Path?: string }>(await ps(deps, 'Get-Process | Select-Object Name,Id,Path | ConvertTo-Json -Compress'));
    for (const p of procs) programs.push({ name: p.Name, pid: p.Id, path: p.Path ?? undefined });
    const installed = json<{ DisplayName?: string; InstallLocation?: string }>(await ps(deps, "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object DisplayName | Select-Object DisplayName,InstallLocation | ConvertTo-Json -Compress"));
    for (const i of installed) if (i.DisplayName) programs.push({ name: i.DisplayName, path: i.InstallLocation || undefined });
    const ports = json<{ LocalPort: number; OwningProcess: number }>(await ps(deps, "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in '127.0.0.1','0.0.0.0','::','::1' } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress"));
    for (const p of ports) listening.push({ port: Number(p.LocalPort), pid: Number(p.OwningProcess), name: procs.find((x) => x.Id === Number(p.OwningProcess))?.Name });
  } else {
    // Linux: ss shows the listening ports with their program; ps lists running programs.
    for (const line of (await deps.run('ss', ['-ltnpH'])).split('\n')) {
      const m = line.match(/\s(?:127\.0\.0\.1|0\.0\.0\.0|\*|\[::1?\]):(\d+)\s.*?users:\(\("([^"]+)",pid=(\d+)/);
      if (m) listening.push({ port: Number(m[1]), name: m[2], pid: Number(m[3]) });
    }
    for (const line of (await deps.run('ps', ['-eo', 'pid=,comm='])).split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) programs.push({ name: m[2]!, pid: Number(m[1]) });
    }
  }
  return { programs, listening };
}

/** USB / COM-port devices whose names look like an ETR (or a USB-serial adapter an ETR often uses). */
async function devices(deps: DetectDeps): Promise<EtrCandidate[]> {
  if (deps.platform === 'win32') {
    const list = json<{ Name?: string; Manufacturer?: string }>(await ps(deps, "Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\\(COM\\d+\\)' -or $_.Name -match 'fiscal|tremol|datecs|daisy|etr|tims' } | Select-Object Name,Manufacturer | ConvertTo-Json -Compress"));
    return list.filter((d) => d.Name).map((d) => ({ kind: 'device' as const, name: d.Name!, detail: [d.Manufacturer, ETR_NAME.test(`${d.Name} ${d.Manufacturer ?? ''}`) ? 'looks like an ETR' : 'serial / USB port'].filter(Boolean).join(' · ') }));
  }
  const out: EtrCandidate[] = [];
  const byId = (await deps.run('ls', ['-1', '/dev/serial/by-id'])).split('\n').map((s) => s.trim()).filter(Boolean);
  for (const n of byId) out.push({ kind: 'device', name: n, detail: ETR_NAME.test(n) ? 'looks like an ETR' : 'serial / USB port' });
  return out;
}

/** Folder pairs an ETR program may watch: in/out, inbox/outbox, request/response... under the usual places. */
function folders(deps: DetectDeps, programPaths: string[]): EtrCandidate[] {
  const path = pathFor(deps);
  const roots = deps.platform === 'win32'
    ? ['C:\\', 'C:\\ProgramData', 'C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\']
    : ['/opt', '/srv', '/var/lib', '/home'];
  const bases = new Set<string>(programPaths);
  for (const r of roots) for (const d of deps.listDirs(r)) if (ETR_NAME.test(d)) bases.add(path.join(r, d));
  const pairs: [string, string][] = [['in', 'out'], ['inbox', 'outbox'], ['input', 'output'], ['request', 'response'], ['requests', 'responses'], ['send', 'receive'], ['IN', 'OUT']];
  const out: EtrCandidate[] = [];
  for (const base of bases) {
    const subs = deps.listDirs(base);
    for (const [a, b] of pairs) {
      const ia = subs.find((s) => s.toLowerCase() === a.toLowerCase());
      const ib = subs.find((s) => s.toLowerCase() === b.toLowerCase());
      if (ia && ib) out.push({ kind: 'folder', name: path.basename(base), inbox: path.join(base, ia), outbox: path.join(base, ib) });
    }
  }
  return out;
}

/** Windows or POSIX path rules, following the computer being searched. */
const pathFor = (deps: DetectDeps) => (deps.platform === 'win32' ? nodePath.win32 : nodePath.posix);

/** Ports some ETR programs use out of the box (e.g. Tremol ZFPLab server 4444). Tried only if nothing better is found. */
const KNOWN_PORTS = [4444, 4445, 8888, 9000, 9100, 8080];

export async function detectEtr(deps: DetectDeps = realDeps): Promise<{ candidates: EtrCandidate[]; programs: string[] }> {
  const { programs, listening } = await programsAndPorts(deps);
  const etrPrograms = programs.filter((p) => ETR_NAME.test(`${p.name} ${p.path ?? ''}`));
  const etrPids = new Set(etrPrograms.map((p) => p.pid).filter(Boolean));
  const ourPort = Number(process.env.PORT ?? 9999);

  // Ports owned by an ETR-like program first; then well-known ETR ports that something listens on.
  const ports = new Map<number, string>();
  for (const l of listening) if ((l.pid && etrPids.has(l.pid)) || (l.name && ETR_NAME.test(l.name))) ports.set(l.port, l.name ?? 'ETR program');
  for (const p of KNOWN_PORTS) if (!ports.has(p) && listening.some((l) => l.port === p)) ports.set(p, listening.find((l) => l.port === p)?.name ?? 'program');
  ports.delete(ourPort);

  const http: EtrCandidate[] = [];
  for (const [port, name] of ports) {
    const url = `http://127.0.0.1:${port}`;
    http.push({ kind: 'http', name, url, port, answers: await deps.probe(url) });
  }
  http.sort((a, b) => Number(b.answers) - Number(a.answers));

  const path = pathFor(deps);
  const programPaths = etrPrograms.map((p) => p.path).filter((p): p is string => Boolean(p)).map((p) => (/\.\w{2,4}$/.test(p) ? path.dirname(p) : p));
  const seen = new Set<string>();
  const unique = (c: EtrCandidate) => {
    const k = `${c.kind}:${c.url ?? c.inbox ?? c.name}`.toLowerCase();
    return !seen.has(k) && seen.add(k);
  };
  const programCandidates: EtrCandidate[] = etrPrograms.map((p) => ({ kind: 'program', name: p.name, detail: p.path ? `at ${p.path}` : p.pid ? 'running' : 'installed' }));
  return {
    candidates: [...http, ...folders(deps, programPaths), ...programCandidates, ...(await devices(deps))].filter(unique).slice(0, 40),
    programs: [...new Set(etrPrograms.map((p) => p.name))],
  };
}
