import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SESSIONS, POLL, WAIT_GAP_MS, groupSessions, lastFolder, newlyWaiting, parseAgents, phaseOf, pollDelay, resumeCommand, spanParts, trackWaits, waitedMs, type AgentSession } from "./sessions.ts";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const MIN = 60_000;
const ID_A = "3f1d6c52-8a47-4d0e-9b6a-1c2e5f7a9b30";
const ID_B = "7c0b9e11-2d34-4f58-8a61-0e9d3b4c5a72";

const ok = (raw: string) => {
  const r = parseAgents(raw);
  assert.ok(r.ok, JSON.stringify(r));
  return r;
};

// Samples written from the documented fields: cwd, kind, startedAt always; id and state for background sessions; pid and
// status while the process is alive; waitingFor when status is waiting; sessionId and name when set.
const SAMPLE = JSON.stringify([
  { cwd: "C:\\Users\\me\\crest", kind: "interactive", startedAt: NOW - 47 * MIN, pid: 4120, status: "waiting", waitingFor: "permission prompt", sessionId: ID_A, name: "Fix the spring" },
  { cwd: "/home/me/site", kind: "background", startedAt: NOW - 12 * MIN, id: "a1b2c3", state: "working", pid: 5521, status: "busy", sessionId: ID_B, name: "Update dependencies" },
  { cwd: "C:\\Users\\me\\docs", kind: "interactive", startedAt: NOW - 3 * MIN, pid: 6001, status: "idle" },
  { cwd: "/home/me/notes", kind: "background", startedAt: NOW - 180 * MIN, id: "d4e5f6", state: "done" },
]);

test("the documented fields become sessions, the ones waiting for the user first", () => {
  const { sessions, skipped } = ok(SAMPLE);
  assert.equal(skipped, 0);
  assert.deepEqual(sessions.map((s) => s.phase), ["waiting", "working", "idle", "done"]);
  const [first] = sessions;
  assert.equal(first.title, "Fix the spring");
  assert.equal(first.waitingFor, "permission prompt");
  assert.equal(first.sessionId, ID_A);
  assert.equal(first.startedAt, NOW - 47 * MIN);
});

test("a session without a name is called after the last folder of its working folder", () => {
  const { sessions } = ok(SAMPLE);
  assert.equal(sessions.find((s) => s.phase === "idle")!.title, "docs");
  assert.equal(sessions.find((s) => s.phase === "done")!.title, "notes");
  assert.equal(lastFolder("C:\\Users\\me\\app\\"), "app");
  assert.equal(lastFolder("/srv/www/"), "www");
  assert.equal(lastFolder("C:\\"), "C:");
  assert.equal(lastFolder("/"), "/");
  assert.equal(ok(JSON.stringify([{ kind: "interactive" }])).sessions[0].title, "");
});

test("missing fields do not stop a row", () => {
  const { sessions } = ok(JSON.stringify([{}, { cwd: 5, kind: null, startedAt: "soon", pid: "x", status: 7 }, { startedAt: -4, sessionId: "" }]));
  assert.equal(sessions.length, 3);
  for (const s of sessions) {
    assert.equal(s.phase, "other");
    assert.equal(s.startedAt, null);
    assert.equal(s.sessionId, null);
    assert.equal(s.cwd, "");
  }
  assert.equal(new Set(sessions.map((s) => s.key)).size, 3);
});

test("entries that are no objects are skipped and counted", () => {
  const r = ok(JSON.stringify([null, 3, "text", [1], { cwd: "/a", status: "idle" }]));
  assert.equal(r.sessions.length, 1);
  assert.equal(r.skipped, 4);
});

test("a value of a newer Claude Code stays as it came and shows as other", () => {
  const { sessions } = ok(JSON.stringify([{ cwd: "/a", kind: "remote", status: "paused", state: "queued", waitingFor: "something new" }]));
  assert.equal(sessions[0].phase, "other");
  assert.equal(sessions[0].kind, "remote");
  assert.equal(sessions[0].status, "paused");
  assert.equal(sessions[0].state, "queued");
  assert.equal(sessions[0].waitingFor, "something new");
  // A known state next to an unknown status still counts: the state is what it is.
  assert.equal(phaseOf("done", "dreaming"), "done");
});

test("state and status give one phase", () => {
  assert.equal(phaseOf(null, "waiting"), "waiting");
  assert.equal(phaseOf("blocked", null), "waiting");
  assert.equal(phaseOf("blocked", "waiting"), "waiting");
  assert.equal(phaseOf("working", "busy"), "working");
  assert.equal(phaseOf(null, "busy"), "working");
  // A new turn has begun although `state` still says done.
  assert.equal(phaseOf("done", "busy"), "working");
  assert.equal(phaseOf("done", "idle"), "done");
  assert.equal(phaseOf(null, "idle"), "idle");
  assert.equal(phaseOf("failed", "busy"), "failed");
  assert.equal(phaseOf("stopped", null), "stopped");
  assert.equal(phaseOf(null, null), "other");
});

test("order: waiting, failed, working, idle, done, stopped, unknown; newest first within a group", () => {
  const row = (name: string, extra: object, minutesAgo: number) => ({ cwd: "/x", name, startedAt: NOW - minutesAgo * MIN, ...extra });
  const raw = JSON.stringify([
    row("stopped", { state: "stopped" }, 1),
    row("unknown", { status: "paused" }, 1),
    row("done", { state: "done" }, 1),
    row("idle", { status: "idle" }, 1),
    row("old working", { status: "busy" }, 30),
    row("new working", { status: "busy" }, 2),
    row("failed", { state: "failed" }, 1),
    row("blocked", { state: "blocked" }, 90),
    row("asking", { status: "waiting", waitingFor: "input needed" }, 5),
  ]);
  assert.deepEqual(ok(raw).sessions.map((s) => s.title), ["asking", "blocked", "failed", "new working", "old working", "idle", "done", "stopped", "unknown"]);
});

test("no JSON at all means an old Claude Code, broken JSON is invalid", () => {
  assert.deepEqual(parseAgents("3 agents\n  reviewer (project)\n"), { ok: false, reason: "too-old" });
  assert.deepEqual(parseAgents(""), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAgents("   \n"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAgents('[{"cwd": "/a"'), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAgents('{"sessions": []}'), { ok: false, reason: "invalid" });
});

test("an empty array is an empty list, and a byte order mark or trailing newline is fine", () => {
  assert.deepEqual(ok("[]"), { ok: true, sessions: [], skipped: 0 });
  assert.equal(ok("\uFEFF[]\r\n").sessions.length, 0);
});

test("hundreds of sessions are parsed in order and the list is capped", () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({
    cwd: `/work/p${i}`,
    kind: i % 3 ? "interactive" : "background",
    startedAt: NOW - i * MIN,
    status: i % 50 === 0 ? "waiting" : i % 2 ? "busy" : "idle",
    sessionId: i % 5 ? undefined : `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  }));
  const { sessions } = ok(JSON.stringify(rows));
  assert.equal(sessions.length, 600);
  assert.equal(sessions.filter((s) => s.phase === "waiting").length, 12);
  assert.ok(sessions.slice(0, 12).every((s) => s.phase === "waiting"));
  assert.equal(new Set(sessions.map((s) => s.key)).size, 600);

  const many = ok(JSON.stringify(Array.from({ length: MAX_SESSIONS + 25 }, (_, i) => ({ cwd: `/p${i}` }))));
  assert.equal(many.sessions.length, MAX_SESSIONS);
  assert.equal(many.skipped, 25);
});

test("the same session twice keeps two keys", () => {
  const { sessions } = ok(JSON.stringify([{ cwd: "/a", sessionId: ID_A, status: "idle" }, { cwd: "/a", sessionId: ID_A, status: "idle" }]));
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].key, sessions[1].key);
});

test("only a real UUID gives a resume command", () => {
  const rows = ["not-a-uuid", "3f1d6c52-8a47-4d0e-9b6a-1c2e5f7a9b30; rm -rf ~", "$(whoami)", "3F1D6C52-8A47-4D0E-9B6A-1C2E5F7A9B30"];
  const { sessions } = ok(JSON.stringify(rows.map((sessionId, i) => ({ cwd: `/p${i}`, sessionId }))));
  const byDir = (d: string) => sessions.find((s) => s.cwd === d)!;
  assert.equal(byDir("/p0").sessionId, null);
  assert.equal(byDir("/p1").sessionId, null);
  assert.equal(byDir("/p2").sessionId, null);
  assert.equal(byDir("/p3").sessionId, "3F1D6C52-8A47-4D0E-9B6A-1C2E5F7A9B30");
  assert.equal(resumeCommand(ID_A), `claude --resume ${ID_A}`);
});

test("texts lose control and direction characters and are cut", () => {
  const { sessions } = ok(JSON.stringify([{ cwd: "/a", name: "ab\u202ecd\u0007\n" + "x".repeat(500), status: "id\u0000le" }]));
  assert.ok(!/[\u0000-\u001f\u202e]/.test(sessions[0].title));
  assert.equal(sessions[0].title.length, 120);
  assert.equal(sessions[0].status, "idle");
});

test("the wait counts from the first sighting and starts over after a gap", () => {
  const waiting = (key: string): AgentSession => ({ key, title: key, cwd: "", kind: "", startedAt: null, sessionId: null, state: null, status: "waiting", waitingFor: null, phase: "waiting" });
  const working = (key: string): AgentSession => ({ ...waiting(key), status: "busy", phase: "working" });
  let waits = trackWaits(new Map(), [waiting("a"), working("b")], NOW);
  assert.equal(waits.has("b"), false);
  assert.equal(waitedMs(waits, "a", NOW), 0);

  waits = trackWaits(waits, [waiting("a"), waiting("c")], NOW + 5_000);
  waits = trackWaits(waits, [waiting("a"), waiting("c")], NOW + 10_000);
  assert.equal(waitedMs(waits, "a", NOW + 10_000), 10_000);
  assert.equal(waitedMs(waits, "c", NOW + 10_000), 5_000);

  // It worked in between: the wait is over, and a later one is a new wait.
  waits = trackWaits(waits, [working("a"), waiting("c")], NOW + 15_000);
  waits = trackWaits(waits, [waiting("a"), waiting("c")], NOW + 20_000);
  assert.equal(waitedMs(waits, "a", NOW + 20_000), 0);
  assert.equal(waitedMs(waits, "c", NOW + 20_000), 15_000);

  // Not looked at for longer than the gap (the notch was closed): not counted as one wait.
  waits = trackWaits(waits, [waiting("c")], NOW + 20_000 + WAIT_GAP_MS + 1);
  assert.equal(waitedMs(waits, "c", NOW + 20_000 + WAIT_GAP_MS + 1), 0);
  assert.equal(waitedMs(new Map(), "zz", NOW), 0);
});

test("a span in days, hours and minutes", () => {
  assert.deepEqual(spanParts(0), { d: 0, h: 0, m: 0 });
  assert.deepEqual(spanParts(59_999), { d: 0, h: 0, m: 0 });
  assert.deepEqual(spanParts(61 * MIN), { d: 0, h: 1, m: 1 });
  assert.deepEqual(spanParts((26 * 60 + 5) * MIN), { d: 1, h: 2, m: 5 });
  assert.deepEqual(spanParts(-5 * MIN), { d: 0, h: 0, m: 0 });
});

const session = (key: string, phase: AgentSession["phase"], cwd: string): AgentSession => ({
  key, title: key, cwd, kind: "interactive", startedAt: null, sessionId: null, state: null, status: null, waitingFor: null, phase,
});

test("polls quickly while looking at a busy list, slowly when everything is parked, and in between with the notch closed", () => {
  const parked = [session("a", "idle", "/x"), session("b", "done", "/x")];
  const busy = [session("a", "working", "/x")];
  assert.equal(pollDelay([], true), POLL.idleMs);
  assert.equal(pollDelay(parked, true), POLL.idleMs);
  assert.equal(pollDelay(busy, true), POLL.liveMs);
  assert.equal(pollDelay([session("w", "waiting", "/x")], true), POLL.liveMs);
  assert.equal(pollDelay(busy, false), POLL.backgroundLiveMs);
  assert.ok(POLL.liveMs < POLL.backgroundLiveMs && POLL.backgroundLiveMs < POLL.idleMs);
});

test("a session is news only when it begins to wait", () => {
  const list = [session("a", "waiting", "/x"), session("b", "waiting", "/y"), session("c", "working", "/z")];
  assert.deepEqual(newlyWaiting(new Set(), list).map((s) => s.key), ["a", "b"]);
  assert.deepEqual(newlyWaiting(new Set(["a"]), list).map((s) => s.key), ["b"]);
  assert.deepEqual(newlyWaiting(new Set(["a", "b"]), list), []);
});

test("groups the sessions by project in the order of the most urgent one, and sets the finished ones apart", () => {
  const list = [
    session("w", "waiting", "C:\\dev\\crest"),
    session("k", "working", "C:\\dev\\other"),
    session("f", "failed", "c:/dev/crest/"),
    session("d", "done", "C:\\dev\\crest"),
    session("s", "stopped", "C:\\dev\\old"),
    session("n", "idle", ""),
  ];
  const { groups, finished } = groupSessions(list);
  assert.deepEqual(groups.map((g) => [g.name, g.sessions.map((s) => s.key), g.waiting]), [["crest", ["w", "f"], 1], ["other", ["k"], 0], ["", ["n"], 0]]);
  assert.deepEqual(finished.map((s) => s.key), ["d", "s"]);
  assert.deepEqual(groupSessions([]), { groups: [], finished: [] });
});
