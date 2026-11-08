import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { windowShell } from "../../platform/services";
import { settings } from "../../settings/store";
import { t } from "../../i18n";
import { receivePluginNotice } from "../notices/store";
import { fetchAgentsText } from "./api";
import { newlyWaiting, parseAgents, pollDelay, trackWaits, type AgentSession, type Waits } from "./sessions";

/** With these there is nothing to read until something changes on the PC; the refresh button tries again. */
const GIVE_UP = new Set(["not-found", "too-old"]);

export type AgentsError = "not-found" | "too-old" | "invalid" | "timeout" | "too-big" | "failed";

export interface AgentsState {
  sessions: AgentSession[];
  /** Entries of the list that were no sessions or past the cap. */
  skipped: number;
  waits: Waits;
  /** Set after a failed reading. The last sessions stay (marked as old by the page) unless the CLI is missing or too old. */
  error: AgentsError | null;
  loading: boolean;
  /** When the last good reading came (ms). */
  updatedAt: number | null;
}

export const agents = createStore<AgentsState>({ sessions: [], skipped: 0, waits: new Map(), error: null, loading: false, updatedAt: null });

/** Mounted views: the tool is on screen, so the notch is open. */
let viewers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
/** The window is hidden (the hide shortcut or an app rule) while the notch is still open on this tool. */
let hidden = false;
/** Sessions already announced as waiting, so one is told once per wait. */
let announced = new Set<string>();

const KNOWN = new Set<string>(["not-found", "too-old", "invalid", "timeout", "too-big", "failed"]);

const visible = () => viewers > 0 && !hidden;
/** The tool is switched on in the tool bar: then it keeps an eye on the sessions even with the notch closed. */
const watching = () => !!settings.get().tools.find((tool) => tool.id === "agents")?.enabled;
const wanted = () => visible() || watching();

async function load(): Promise<void> {
  try {
    const parsed = parseAgents(await fetchAgentsText());
    if (parsed.ok) {
      const now = Date.now();
      const first = agents.get().updatedAt === null;
      announce(parsed.sessions, first);
      agents.set((s) => ({ sessions: parsed.sessions, skipped: parsed.skipped, waits: trackWaits(s.waits, parsed.sessions, now), error: null, loading: false, updatedAt: now }));
    } else fail(parsed.reason);
  } catch (e) {
    const code = String(e);
    // A reading refused because another one was still running: that one answers.
    if (code === "busy") agents.set((s) => ({ ...s, loading: false }));
    else fail(KNOWN.has(code) ? (code as AgentsError) : "failed");
  }
}

/** A session that starts to need the user says so through the notices (pop-up in the closed notch, history). */
function announce(sessions: readonly AgentSession[], first: boolean) {
  const fresh = newlyWaiting(announced, sessions);
  announced = new Set(sessions.filter((s) => s.phase === "waiting").map((s) => s.key));
  // Not on the first reading (a restart is no news), nor while the tool is open: the list itself shows it.
  if (first || visible()) return;
  for (const s of fresh) {
    receivePluginNotice({
      source: "plugin",
      appId: "crest:agents",
      appName: t("Agents"),
      title: s.title || t("Sitzung"),
      body: s.waitingFor ? `${t("Braucht dich")} · ${s.waitingFor}` : t("Braucht dich"),
      at: Date.now(),
      replace: `agents:${s.key}`,
    });
  }
}

function fail(error: AgentsError) {
  const gone = GIVE_UP.has(error);
  if (gone) announced = new Set();
  agents.set((s) => ({ ...s, sessions: gone ? [] : s.sessions, skipped: gone ? 0 : s.skipped, waits: gone ? new Map() : s.waits, error, loading: false }));
}

/** One reading; asked again while one runs it joins that one. */
export function refreshAgents(): Promise<void> {
  if (inFlight) return inFlight;
  agents.set((s) => ({ ...s, loading: true }));
  inFlight = load().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule() {
  if (timer || !wanted()) return;
  timer = setTimeout(() => {
    timer = null;
    void poll();
  }, pollDelay(agents.get().sessions, visible()));
}

async function poll() {
  if (!wanted()) return;
  await refreshAgents();
  const { error } = agents.get();
  if (!error || !GIVE_UP.has(error)) schedule();
}

/** Starts or stops the reading to match what is wanted now (a view opened or closed, the tool switched on or off). */
function apply() {
  if (!wanted()) return clearTimer();
  if (!timer && !inFlight) void poll();
}

/** The refresh button: read now, and go on polling after a CLI that was missing has turned up. */
export function refreshAgentsNow() {
  clearTimer();
  void poll();
}

/** Whether a session needs the user: for the dot on the tool's icon and the closed notch. */
export function useAgentsNeedYou(): boolean {
  return agents.use().sessions.some((s) => s.phase === "waiting");
}

/**
 * Once at start: reads in the background while the tool is switched on, and again at once when the window comes back
 * or gets focus (a slow poll could be showing old news).
 */
export function startAgentsWatch() {
  settings.subscribe(apply);
  windowShell.onHidden((h) => {
    hidden = h;
    if (!h && wanted()) refreshAgentsNow();
    else apply();
  });
  window.addEventListener("focus", () => {
    if (wanted()) refreshAgentsNow();
  });
  apply();
}

/** For the Agents view: while mounted it reads at the quick rate if anything is busy or waiting. */
export function useAgentsViewer() {
  useEffect(() => {
    if (viewers++ === 0) refreshAgentsNow();
    return () => {
      // Back to the background rate (or to nothing, with the tool switched off).
      if (--viewers === 0) {
        clearTimer();
        apply();
      }
    };
  }, []);
}
