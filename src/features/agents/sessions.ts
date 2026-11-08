// Claude Code sessions from the text of `claude agents --json`: the parser, the order, the wait timer. Pure, so tests can run it.
// The fields are the documented ones (cwd, kind, startedAt, id, state, pid, status, waitingFor, sessionId, name); anything
// else is ignored, and a value this code does not know is kept as it came and shown neutrally.

/** How a row looks. `other`: a state or status of a newer Claude Code, shown with its own words. */
export type Phase = "waiting" | "failed" | "working" | "idle" | "done" | "stopped" | "other";

export interface AgentSession {
  /** Unique in the list; the session's UUID when it has one. */
  key: string;
  /** The session's name, else the last folder of its working folder; "" when there is neither. */
  title: string;
  cwd: string;
  /** "interactive" or "background"; a value this code does not know is kept. */
  kind: string;
  /** Unix ms. */
  startedAt: number | null;
  /** Only a real UUID: it goes into a command the user pastes into a terminal. */
  sessionId: string | null;
  state: string | null;
  status: string | null;
  waitingFor: string | null;
  phase: Phase;
}

export type ParseResult = { ok: true; sessions: AgentSession[]; skipped: number } | { ok: false; reason: "too-old" | "invalid" };

/** More than this is cut: the list only has to stay drawable. */
export const MAX_SESSIONS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters, and the ones that reverse the direction of what follows (a name could swap its own letters).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A short text from the CLI, or null: no control or direction characters, trimmed, cut at `max`. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL, "").trim();
  return s ? s.slice(0, max) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "C:\Users\me\app" → "app", "/" → "/". */
export function lastFolder(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

/**
 * What a row shows. The live `status` (busy, waiting, idle) outranks a background session's `state`, which can lag a turn
 * behind; failed and stopped are ends and win. `blocked` and `waiting` both mean the session needs the user.
 */
export function phaseOf(state: string | null, status: string | null): Phase {
  if (state === "failed") return "failed";
  if (state === "stopped") return "stopped";
  if (status === "waiting" || state === "blocked") return "waiting";
  if (status === "busy" || state === "working") return "working";
  if (state === "done") return "done";
  if (status === "idle") return "idle";
  return "other";
}

const RANK: Record<Phase, number> = { waiting: 0, failed: 1, working: 2, idle: 3, done: 4, stopped: 5, other: 6 };

function compare(a: AgentSession, b: AgentSession): number {
  return RANK[a.phase] - RANK[b.phase] || (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity) || a.title.localeCompare(b.title);
}

/**
 * The sessions in the order to show them: the ones waiting for the user first, then failed, working, idle, done, stopped,
 * unknown; within a group the newest first. Entries that are no objects are skipped (counted in `skipped`).
 * "too-old": the text is no JSON at all, which is what a Claude Code without `agents --json` prints (a count and its subagents).
 */
export function parseAgents(raw: string): ParseResult {
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return { ok: false, reason: "invalid" };
  if (!/^[[{]/.test(s)) return { ok: false, reason: "too-old" };
  let data: unknown;
  try {
    data = JSON.parse(s);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!Array.isArray(data)) return { ok: false, reason: "invalid" };

  const taken = new Set<string>();
  const sessions: AgentSession[] = [];
  let skipped = 0;
  for (const row of data.slice(0, MAX_SESSIONS) as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      skipped++;
      continue;
    }
    const r = row as Record<string, unknown>;
    const cwd = text(r.cwd, 300) ?? "";
    const id = text(r.id, 64);
    const pid = num(r.pid);
    const sessionId = text(r.sessionId, 64);
    const state = text(r.state, 40);
    const status = text(r.status, 40);
    let key = sessionId ?? (id ? `bg:${id}` : pid !== null ? `pid:${pid}` : `row:${sessions.length}`);
    for (let n = 2; taken.has(key); n++) key = `${sessionId ?? id ?? pid ?? "row"}#${n}`;
    taken.add(key);
    const startedAt = num(r.startedAt);
    sessions.push({
      key,
      title: text(r.name, 120) ?? (cwd ? lastFolder(cwd) : ""),
      cwd,
      kind: text(r.kind, 40) ?? "",
      startedAt: startedAt !== null && startedAt > 0 ? startedAt : null,
      sessionId: sessionId && UUID.test(sessionId) ? sessionId : null,
      state,
      status,
      waitingFor: text(r.waitingFor, 60),
      phase: phaseOf(state, status),
    });
  }
  skipped += Math.max(0, data.length - MAX_SESSIONS);
  return { ok: true, sessions: sessions.sort(compare), skipped };
}

/** What the user pastes into a terminal to pick the session up again. */
export function resumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}

// ---------- How long it has been waiting ----------

// The JSON says nothing about when a session began to wait, so it is counted from when Crest first saw it waiting.

/** Two sightings further apart than this are not one wait: the notch was closed in between, the session may have worked meanwhile. */
export const WAIT_GAP_MS = 20_000;

export type Waits = ReadonlyMap<string, { since: number; seen: number }>;

/** The waits after a new reading: a session still waiting keeps its start, one that is not waiting any more is forgotten. */
export function trackWaits(prev: Waits, sessions: readonly AgentSession[], now: number): Waits {
  const next = new Map<string, { since: number; seen: number }>();
  for (const s of sessions) {
    if (s.phase !== "waiting") continue;
    const before = prev.get(s.key);
    next.set(s.key, { since: before && now - before.seen <= WAIT_GAP_MS ? before.since : now, seen: now });
  }
  return next;
}

/** How long Crest has seen the session waiting, in ms (0: not waiting, or only just seen). */
export function waitedMs(waits: Waits, key: string, now: number): number {
  const w = waits.get(key);
  return w ? Math.max(0, now - w.since) : 0;
}

/** Whole days, hours and minutes of a span (negative counts as none). */
export function spanParts(ms: number): { d: number; h: number; m: number } {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  return { d: Math.floor(min / 1440), h: Math.floor((min % 1440) / 60), m: min % 60 };
}

// ---------- How often to read, and what is news ----------

/**
 * How soon the next reading starts after the last one ended (so two never overlap).
 * Looking at the list with a session busy or waiting: quick. Everything parked: slow. Notch closed: slower still,
 * since then it only has to notice a session that begins to need the user.
 */
export const POLL = { liveMs: 3_000, idleMs: 30_000, backgroundLiveMs: 15_000 } as const;

/** The delay before the next reading, from what the sessions are doing and whether the tool is on screen. */
export function pollDelay(sessions: readonly AgentSession[], watched: boolean): number {
  const live = sessions.some((s) => s.phase === "waiting" || s.phase === "working");
  if (!live) return POLL.idleMs;
  return watched ? POLL.liveMs : POLL.backgroundLiveMs;
}

/** The sessions that wait now and were not in `before` (the keys already announced). */
export function newlyWaiting(before: ReadonlySet<string>, sessions: readonly AgentSession[]): AgentSession[] {
  return sessions.filter((s) => s.phase === "waiting" && !before.has(s.key));
}

// ---------- Grouping ----------

export interface SessionGroup {
  /** The working folder as the sessions give it; "" for sessions without one. */
  cwd: string;
  name: string;
  sessions: AgentSession[];
  waiting: number;
}

/** Done and stopped sessions: nothing to do with them, so the page folds them away. */
export const isFinished = (s: AgentSession) => s.phase === "done" || s.phase === "stopped";

/** The same folder however it is written: separators, a trailing one and case (Windows). */
export const folderKey = (cwd: string) => cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The sessions of `sorted` (already in `compare` order) by project. The groups come in the order of their most urgent
 * session; `finished` holds the done and stopped ones, newest first, apart from the groups.
 */
export function groupSessions(sorted: readonly AgentSession[]): { groups: SessionGroup[]; finished: AgentSession[] } {
  const groups = new Map<string, SessionGroup>();
  const finished: AgentSession[] = [];
  for (const s of sorted) {
    if (isFinished(s)) {
      finished.push(s);
      continue;
    }
    const key = folderKey(s.cwd);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { cwd: s.cwd, name: s.cwd ? lastFolder(s.cwd) : "", sessions: [], waiting: 0 }));
    group.sessions.push(s);
    if (s.phase === "waiting") group.waiting++;
  }
  return { groups: [...groups.values()], finished };
}
