import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowsOutSimple, ArrowUp, CaretRight, CircleNotch, FolderOpen, NotePencil, Plus, Square, X } from "@phosphor-icons/react";
import { fade, pulse, spin, springs } from "../../design/motion";
import { t } from "../../i18n";
import { createStore } from "../../lib/store";
import { HeaderLead } from "../../notch/header";
import { Ring, ringValue } from "../../notch/row/parts/Rings";
import { isNative } from "../../platform/native";
import { BrandLogo, brandColor } from "../../ui/brands";
import { usage, useUsageViewer } from "../usage/store";
import { formatTokens } from "../usage/format";
import { AGENTS, MAX_DRAFT, MAX_QUEUE, agentIds, effortIds, modelsOf, planTurn, restoreProjects, shortModel, tokensByModel, type Agent, type Effort, type Message, type Project, type Turn } from "./chat";
import { CopyButton, Markdown } from "./Markdown";

/** Where the history used to live; read once to carry it over to the file in the app's data folder. */
const LEGACY_KEY = "crest.agent-projects.v1";
/** What a retry after a refused action says to the agent. */
const RETRY_TEXT = "Try again. You may edit files in the project now.";
const EFFORTS: Record<Effort, { name: string; dot: string }> = {
  low: { name: "Low", dot: "bg-green" },
  medium: { name: "Medium", dot: "bg-yellow" },
  high: { name: "High", dot: "bg-red" },
};
/** The dot of a tab that finished behind the user's back, and what it says. */
const MARKS: Record<"done" | "needs" | "failed", { dot: string; label: string }> = {
  done: { dot: "bg-green", label: "Fertig" },
  needs: { dot: "bg-orange", label: "Braucht dich" },
  failed: { dot: "bg-red", label: "Fehlgeschlagen" },
};
/** A message longer than this is cut short in the log, with a button for all of it. */
const LONG_CHARS = 480;
const LONG_LINES = 8;

type AgentReply = { text: string; thinking?: string; tokens: number | null; permissionDenied: boolean; session: string | null };

/** What the backend sends while a turn runs. */
type Progress = { thinking: string; text: string };
/** A turn in flight: the message, and what the agent has shown of its work and its answer so far. */
type Run = { text: string; thinking: string; reply: string; agent: Agent; model: string; requestId: string };

function readLegacy(): Project[] {
  try {
    return restoreProjects(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

const sameFolder = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Natively the history is a file in the app's data folder (localStorage holds a few MB, and a long history outgrows it
 * without a word). It is read once at start; until then nothing is written, so an empty list never replaces the file.
 * If the file cannot be read the old browser storage stays the place, as before.
 */
let storage: "pending" | "file" | "local" = isNative ? "pending" : "local";

const projects = createStore<Project[]>(isNative ? [] : readLegacy());
const selected = createStore(0);
/** One agent per project can work at a time, and projects work side by side. */
const runs = createStore<Record<string, Run>>({});
const errors = createStore<Record<string, string>>({});
/** Messages sent while the agent of that project was still working; each one goes out as its own turn, in order. */
const queue = createStore<Record<string, string[]>>({});
/** What a project that was not on screen finished with: it answered, it needs the user, or it failed. Cleared when it is opened. */
type Unread = "done" | "needs" | "failed";
const unread = createStore<Record<string, Unread>>({});

// The whole history is written as one piece, so a draft is saved after a pause in typing, and when the window goes away.
let saveTimer = 0;
let writes: Promise<unknown> = Promise.resolve();

async function write(): Promise<boolean> {
  if (storage === "pending") return false;
  const data = JSON.stringify(projects.get());
  try {
    if (storage === "file") await invoke("agents_projects_save", { data });
    else localStorage.setItem(LEGACY_KEY, data);
    return true;
  } catch {
    // A full disk or unavailable storage still allows working until Crest exits.
    return false;
  }
}

/** Writes now; writes go one after the other, so an older copy never lands over a newer one. */
function save(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  const result = writes.then(write);
  writes = result;
  return result;
}
function saveSoon() {
  if (!saveTimer) saveTimer = window.setTimeout(() => void save(), 500);
}
window.addEventListener("pagehide", () => {
  if (saveTimer) void save();
});

if (isNative) {
  void invoke<string | null>("agents_projects_load").then((raw) => {
    let saved: Project[];
    let migrated = false;
    if (raw) saved = restoreProjects(JSON.parse(raw));
    else {
      saved = readLegacy();
      migrated = saved.length > 0;
    }
    // Whatever was added while the file was being read stays.
    const added = projects.get().filter((item) => !saved.some((old) => sameFolder(old.cwd, item.cwd)));
    projects.set([...saved, ...added]);
    storage = "file";
    void save().then((ok) => {
      if (!ok || !migrated) return;
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // Nothing to clean up.
      }
    });
  }).catch(() => {
    storage = "local";
    projects.set((added) => [...readLegacy().filter((old) => !added.some((item) => sameFolder(old.cwd, item.cwd))), ...added]);
  });
}

function update(change: (items: Project[]) => Project[], now = false) {
  projects.set(change(projects.get()));
  if (now) void save();
  else saveSoon();
}

function newProject(cwd: string, agent: Agent): Project {
  return { cwd, agent, model: modelsOf(agent)[0], effort: "medium", draft: "", messages: [], sessions: {} };
}

/** Takes a project out of the list, with its history. Not while an agent works in it. */
function closeProject(cwd: string) {
  if (runs.get()[cwd]) return;
  const index = projects.get().findIndex((item) => item.cwd === cwd);
  if (index === -1) return;
  update((all) => all.filter((item) => item.cwd !== cwd), true);
  const dropped = ({ [cwd]: _gone, ...rest }: Record<string, unknown>) => rest;
  queue.set((all) => dropped(all) as Record<string, string[]>);
  unread.set((all) => dropped(all) as Record<string, Unread>);
  errors.set((all) => dropped(all) as Record<string, string>);
  // The tab the user was on stays; one before it moves everything down by one.
  const current = selected.get();
  selected.set(Math.max(0, Math.min(current > index ? current - 1 : current, projects.get().length - 1)));
}

/** A fresh conversation in the same project: the history and the sessions of the agents go, the folder, agent and model stay. */
function newConversation(cwd: string) {
  if (runs.get()[cwd]) return;
  queue.set(({ [cwd]: _gone, ...rest }) => rest);
  errors.set((all) => ({ ...all, [cwd]: "" }));
  edit(cwd, { messages: [], sessions: {} }, true);
}

/** Shows the chat of a project, starting it when it is new: for a session of the list that is worth talking to. */
export function openProject(cwd: string) {
  const index = projects.get().findIndex((item) => sameFolder(item.cwd, cwd));
  if (index !== -1) return selected.set(index);
  update((all) => [...all, newProject(cwd, "claude")], true);
  selected.set(projects.get().length - 1);
}

function edit(cwd: string, change: Partial<Project> | ((project: Project) => Partial<Project>), now = false) {
  update((items) => items.map((item) => item.cwd === cwd ? { ...item, ...(typeof change === "function" ? change(item) : change) } : item), now);
}

const errorText: Record<string, string> = {
  "not-found": "Die CLI für diesen Agenten wurde nicht gefunden",
  "invalid-directory": "Gib den vollständigen Pfad zu einem vorhandenen Projektordner ein",
  timeout: "Der Agent hat nicht rechtzeitig geantwortet",
  "too-old": "Aktualisiere die CLI für diesen Agenten",
  "too-big": "Die Antwort des Agenten ist zu groß",
  "no-response": "Der Agent hat keine Antwort zurückgegeben",
  "invalid-input": "Prüfe Modell, Aufwand und Nachrichtenlänge",
  busy: "In diesem Projekt arbeitet bereits ein Agent, oder es laufen schon vier",
  "too-long": "Die Nachricht ist zu lang. Kürze sie oder teile sie auf",
};

/** What the page shows for a code from the backend; `cli:` carries what the CLI itself said. */
function failure(error: unknown): string {
  const code = String(error);
  if (code.startsWith("cli:")) return t("Die CLI meldet: {reason}", { reason: code.slice(4) });
  return t(errorText[code] ?? "Die CLI konnte die Anfrage nicht abschließen");
}

/** True while the chat is on screen, so a project that finishes behind another tab, or behind another tool, is marked. */
let onScreen = false;

/** Marks a finished project the user is not looking at. */
function markUnread(cwd: string, mark: Unread) {
  if (onScreen && projects.get()[selected.get()]?.cwd === cwd) return;
  // Something that needs the user is not covered by a later plain "done".
  unread.set((all) => ({ ...all, [cwd]: all[cwd] === "failed" || (all[cwd] === "needs" && mark === "done") ? all[cwd] : mark }));
}

/** Puts what was waiting behind a turn that did not finish back into the box, after what is already there. */
function restoreQueue(cwd: string) {
  const waiting = queue.get()[cwd] ?? [];
  if (!waiting.length) return;
  queue.set(({ [cwd]: _gone, ...rest }) => rest);
  edit(cwd, (current) => ({ draft: [current.draft, ...waiting].filter(Boolean).join("\n\n") }), true);
}

/** After a turn that went well: the next message that was waiting goes out. */
function startNext(cwd: string) {
  const [next, ...rest] = queue.get()[cwd] ?? [];
  if (!next) return;
  queue.set((all) => ({ ...all, [cwd]: rest }));
  const project = projects.get().find((item) => item.cwd === cwd);
  if (project) void send(project, { text: next, allowEdits: false });
}

/** The box's text goes out now, or behind the turn that is running. */
function submit(project: Project) {
  const text = project.draft.trim();
  if (!text || !isNative) return;
  if (!runs.get()[project.cwd]) return void send(project);
  if (text.length > MAX_DRAFT || (queue.get()[project.cwd]?.length ?? 0) >= MAX_QUEUE) return;
  queue.set((all) => ({ ...all, [project.cwd]: [...(all[project.cwd] ?? []), text] }));
  edit(project.cwd, { draft: "" }, true);
}

/**
 * `retry`: a turn given as text instead of the box. By default it is the same turn again after the CLI refused an
 * action, now allowed to edit files, and it leaves the draft alone. `allowEdits: false` is a message that was waiting.
 */
async function send(project: Project, retry?: { text: string; allowEdits?: boolean }) {
  const text = (retry?.text ?? project.draft).trim();
  const { cwd, agent, model, effort, messages, sessions } = project;
  if (!isNative || runs.get()[cwd] || !text) return;
  if (text.length > MAX_DRAFT) {
    errors.set((all) => ({ ...all, [cwd]: failure("too-long") }));
    return;
  }
  const queued = retry?.allowEdits === false;
  const allowEdits = !!retry && !queued;
  const requestId = crypto.randomUUID();
  const show = (part: Partial<Run>) => runs.set((all) => ({ ...all, [cwd]: { text, thinking: "", reply: "", agent, model, requestId, ...part } }));
  if (!retry) edit(cwd, { draft: "" }, true);
  show({});
  let attempt = 0;
  const ask = async (turn: Turn) => {
    const current = ++attempt;
    show({});
    const progress = new Channel<Progress>(({ thinking, text: reply }) => {
      if (current === attempt && runs.get()[cwd]?.requestId === requestId) show({ thinking, reply });
    });
    try {
      return await invoke<AgentReply>("agents_chat", { agent, cwd, model, effort, prompt: turn.prompt, session: turn.session ?? null, requestId, allowEdits, progress });
    } finally {
      // Late messages from a completed/failed attempt cannot update the next one.
      attempt++;
    }
  };
  errors.set((all) => ({ ...all, [cwd]: "" }));
  let finished: Unread | null = null;
  try {
    let reply: AgentReply;
    try {
      reply = await ask(planTurn(messages, agent, sessions, text));
    } catch (error) {
      // The CLI no longer has that conversation (cleaned up, or a different account): start over with the handoff.
      if (String(error) !== "session-lost" || !sessions[agent]) throw error;
      reply = await ask(planTurn(messages, agent, { ...sessions, [agent]: undefined }, text));
    }
    const turn: Message[] = [
      { role: "user", text },
      { role: agent, model, text: reply.text, thinking: reply.thinking || undefined, tokens: reply.tokens ?? undefined, permissionDenied: reply.permissionDenied },
    ];
    edit(cwd, (current) => ({
      messages: [...current.messages, ...turn].slice(-80),
      sessions: { ...current.sessions, [agent]: reply.session ?? undefined },
    }), true);
    finished = reply.permissionDenied ? "needs" : "done";
  } catch (error) {
    if (!retry) edit(cwd, (current) => ({ draft: current.draft || text }), true);
    // A message that was waiting is not lost either; it goes back to the box.
    else if (queued) edit(cwd, (current) => ({ draft: [current.draft, text].filter(Boolean).join("\n\n") }), true);
    // What is still waiting does not go out after a turn that stopped: back to the box too.
    restoreQueue(cwd);
    if (String(error) === "cancelled") {
      // The CLI keeps its conversation, so it stays: if the CLI never saw the prompt, the next turn simply goes on from
      // the last answer, and if the session cannot be continued the "session-lost" path above rebuilds it from the handoff.
      return;
    }
    // A conversation that failed to continue must not be tried again.
    if (String(error) === "session-lost") edit(cwd, (current) => ({ sessions: { ...current.sessions, [agent]: undefined } }), true);
    errors.set((all) => ({ ...all, [cwd]: failure(error) }));
    finished = "failed";
  } finally {
    runs.set(({ [cwd]: _done, ...rest }) => rest);
  }
  if (finished) markUnread(cwd, finished);
  if (finished === "done") startNext(cwd);
  // The agent was refused something and waits for the user: what was queued behind it is theirs to decide on.
  else if (finished === "needs") restoreQueue(cwd);
}

async function cancel(requestId: string) {
  // A click can arrive before the blocking worker starts. Retry only for this exact turn.
  for (let retry = 0; retry < 40 && Object.values(runs.get()).some((run) => run.requestId === requestId); retry++) {
    if (await invoke<boolean>("agents_cancel", { requestId })) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}

const isLong = (text: string) => text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

export function AgentChat() {
  useUsageViewer();
  const { providers } = usage.use();
  const items = projects.use();
  const index = selected.use();
  const turns = runs.use();
  const error = errors.use();
  const project = items[index];
  const active = project ? turns[project.cwd] : undefined;
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [reading, setReading] = useState<Message | null>(null);
  const marks = unread.use();
  const waiting = queue.use();
  const lineup = project ? waiting[project.cwd] ?? [] : [];
  const bottom = useRef<HTMLDivElement>(null);
  /** The log follows the reply while the user is at its end, and leaves them alone once they scroll up to read. */
  const follow = useRef(true);
  const reduced = useReducedMotion();
  const dockId = useId();
  useEffect(() => { follow.current = true; }, [index]);
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ block: "nearest" }); }, [index, project?.messages.length, active?.reply.length, active?.thinking.length, lineup.length]);
  useEffect(() => setReading(null), [index]);
  useEffect(() => {
    onScreen = true;
    return () => { onScreen = false; };
  }, []);
  // What a tab finished with is seen once its project is the one on screen.
  useEffect(() => {
    if (project && marks[project.cwd]) unread.set(({ [project.cwd]: _seen, ...rest }) => rest);
  }, [project?.cwd, marks]);

  function submitNow(next: Project) {
    follow.current = true;
    submit(next);
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const cwd = path.trim();
    if (!cwd) return;
    const existing = items.findIndex((item) => item.cwd.toLowerCase() === cwd.toLowerCase());
    if (existing === -1) {
      update((all) => [...all, newProject(cwd, "claude")], true);
    }
    selected.set(existing === -1 ? items.length : existing);
    setPath("");
    setAdding(false);
  }

  const quota = (id: Agent) => {
    const provider = providers.find((item) => item.id === id && !item.error && item.windows.length > 0);
    return provider ? ringValue(provider) : null;
  };
  const tokens = project ? [...tokensByModel(project.messages)].map(([model, count]) => `${model} · ${formatTokens(count)}`).join("\n") : "";
  const working = !!active;
  const tab = "text-footnote pressable-fill rounded-md";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <HeaderLead>
        <div className="flex min-w-0 items-baseline gap-3" role="group" aria-label={t("Projekte")}>
          {items.map(({ cwd }, i) => (
            <span key={cwd} className="flex shrink-0 items-center gap-0.5">
              <button type="button" title={cwd} aria-pressed={i === index} onClick={() => selected.set(i)}
                className={`${tab} flex max-w-28 shrink-0 items-center gap-1 text-label-2 aria-pressed:font-semibold aria-pressed:text-label`}>
                <span className="truncate">{folderName(cwd)}</span>
                {turns[cwd]
                  ? <span className="size-1.5 shrink-0 rounded-full bg-link" role="img" aria-label={t("Arbeitet")} />
                  : marks[cwd] && <span className={`size-1.5 shrink-0 rounded-full ${MARKS[marks[cwd]].dot}`} role="img" aria-label={t(MARKS[marks[cwd]].label)} />}
              </button>
              {i === index && <ConfirmButton icon={X} label={t("Projekt entfernen")} confirm={t("Verlauf löschen?")} disabled={!!turns[cwd]} onConfirm={() => closeProject(cwd)} />}
            </span>
          ))}
          <button type="button" aria-label={t("Projekt hinzufügen")} title={t("Projekt hinzufügen")} aria-pressed={adding} onClick={() => setAdding(!adding)}
            className={`${tab} shrink-0 self-center text-label-2 aria-pressed:text-label`}><Plus size={13} weight="bold" /></button>
        </div>
      </HeaderLead>
      {(adding || !project) && (
        <form onSubmit={add} className="flex shrink-0 items-center gap-2">
          <input required autoFocus className="h-8 min-w-0 flex-1 rounded-[10px] bg-fill-1 px-3 text-footnote text-label" aria-label={t("Projektordner")} placeholder={t("Projektordner")} value={path} onChange={(event) => setPath(event.target.value)} />
          {isNative && <button type="button" className="pressable pressable-fill grid size-8 place-items-center rounded-full text-label-2" aria-label={t("Projektordner")} onClick={async () => {
            const folder = await invoke<string | null>("plugins_pick", { zip: false }).catch(() => null);
            if (folder) setPath(folder);
          }}><FolderOpen size={16} /></button>}
          <button type="submit" className="pressable-fill h-8 rounded-full px-3 text-footnote text-label-2">{t("Hinzufügen")}</button>
        </form>
      )}
      {project && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-width:none]" role="log" aria-label={t("Unterhaltung")} aria-busy={working}
            onScroll={(event) => {
              const log = event.currentTarget;
              follow.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
            }}>
            <AnimatePresence initial={false} mode="wait">
            <motion.div key={project.cwd} initial={{ opacity: 0, x: reduced ? 0 : 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : -8 }} transition={fade} className="flex min-h-full flex-col justify-end gap-3">
              {project.messages.map((message, i) => (
                <Entry key={i} message={message} onRead={() => setReading(message)}
                  onRetry={!working && message.permissionDenied && message.role === "claude" && i === project.messages.length - 1 ? () => void send(project, { text: RETRY_TEXT }) : undefined} />
              ))}
              {active && (
                <>
                  <Entry key="pending" message={{ role: "user", text: active.text }} onRead={() => setReading({ role: "user", text: active.text })} />
                  <Thinking key="thinking" text={active.thinking} agent={active.agent} working />
                  {active.reply && <Entry key="reply" message={{ role: active.agent, model: active.model, text: active.reply }} onRead={() => setReading({ role: active.agent, model: active.model, text: active.reply })} />}
                </>
              )}
              {lineup.map((text, i) => (
                <article key={`${i}-${text}`} className="max-w-[78%] self-end rounded-[16px] border border-dashed border-label-3/40 px-3 py-2">
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-body text-label-2">{text}</p>
                  <div className="mt-0.5 flex items-center gap-1 text-caption text-label-3">
                    {t("In der Warteschlange")}
                    <button type="button" aria-label={t("Aus der Warteschlange entfernen")} title={t("Aus der Warteschlange entfernen")}
                      onClick={() => queue.set((all) => ({ ...all, [project.cwd]: (all[project.cwd] ?? []).filter((_, k) => k !== i) }))}
                      className="pressable-fill grid size-4 place-items-center rounded-full hover:text-label"><X size={10} weight="bold" /></button>
                  </div>
                </article>
              ))}
              <div ref={bottom} />
            </motion.div>
            </AnimatePresence>
          </div>
          {error[project.cwd] && <p role="alert" className="shrink-0 px-1 text-caption text-red">{error[project.cwd]}</p>}

          <div className="flex h-6 shrink-0 items-center gap-3 px-1 text-footnote text-label-2">
            <span className="flex items-center gap-1.5 font-semibold text-label" title={tokens ? `${t("Tokens im Verlauf")}\n${tokens}` : undefined}>
              {AGENTS[project.agent].name}
              <QuotaRing id={project.agent} value={quota(project.agent)} />
            </span>
            <div role="group" aria-label={t("Modell")} className="flex min-w-0 items-center gap-3">
              {modelsOf(project.agent).map((model) => (
                <button key={model} type="button" disabled={working} title={model} aria-pressed={project.model === model} onClick={() => edit(project.cwd, { model }, true)}
                  className="h-6 whitespace-nowrap hover:text-label disabled:opacity-60 aria-pressed:font-semibold aria-pressed:text-label">{shortModel(model)}</button>
              ))}
            </div>
            <span aria-live="polite" className={`flex-1 text-center text-caption tabular-nums ${project.draft.length > MAX_DRAFT ? "text-red" : "text-label-3"}`}>
              {project.draft.length > MAX_DRAFT * 0.8 ? `${project.draft.length} / ${MAX_DRAFT}` : ""}
            </span>
            <ConfirmButton icon={NotePencil} label={t("Neue Unterhaltung")} confirm={t("Verlauf löschen?")} disabled={working || !project.messages.length} onConfirm={() => newConversation(project.cwd)} />
            <div role="group" aria-label={t("Denkaufwand")} className="flex items-center gap-3">
              {effortIds.map((effort) => (
                <button key={effort} type="button" disabled={working} aria-pressed={project.effort === effort} onClick={() => edit(project.cwd, { effort }, true)}
                  className="flex h-6 items-center gap-1 hover:text-label disabled:opacity-60 aria-pressed:font-semibold aria-pressed:text-label">
                  <span className={`size-[5px] rounded-full ${EFFORTS[effort].dot}`} aria-hidden />{EFFORTS[effort].name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div role="group" aria-label={t("Agent")} className="flex h-10 items-center gap-0.5 rounded-[14px] bg-fill-2 p-0.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_4px_10px_rgb(0_0_0/0.12)]" style={{ perspective: 500 }}>
              {agentIds.map((id) => {
                const on = project.agent === id;
                const value = quota(id);
                return (
                  <motion.button key={id} type="button" disabled={working} aria-pressed={on}
                    whileHover={!working && !reduced ? { y: -3, rotateX: -12, rotateY: 8, scale: 1.08 } : undefined}
                    whileTap={!working && !reduced ? { y: 1, scale: 0.94, rotateX: 6, rotateY: 0 } : undefined}
                    transition={springs.snappy}
                    aria-label={AGENTS[id].name} title={`${AGENTS[id].name}${value === null ? "" : ` · ${Math.round(value)}%`}`}
                    onClick={() => { if (!on) edit(project.cwd, { agent: id, model: modelsOf(id)[0] }, true); }}
                    className="relative flex h-9 w-[42px] items-center justify-center rounded-[12px] disabled:opacity-60"
                    style={{ color: brandColor[id] }}>
                    {on && <motion.span layoutId={`${dockId}-active`} transition={reduced ? fade : springs.snappy} aria-hidden className="absolute inset-0 rounded-[12px] bg-fill-3 shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_2px_4px_rgb(0_0_0/0.18)]" />}
                    <span className="relative"><BrandLogo id={id} size={18} /></span>
                    {on && <motion.span layoutId={`${dockId}-line`} transition={reduced ? fade : springs.snappy} aria-hidden className="absolute bottom-[3px] left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-label" />}
                  </motion.button>
                );
              })}
            </div>
            <form className="flex min-h-10 min-w-0 flex-1 items-end gap-2 rounded-[14px] bg-fill-1 pe-1.5 ps-3.5" onSubmit={(event) => { event.preventDefault(); submitNow(project); }}>
              <textarea rows={1} required aria-label={t("Nachricht")} placeholder={t("Nachricht oder Code eingeben")}
                className="max-h-24 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-[11px] text-body text-label [field-sizing:content]"
                value={project.draft} onChange={(event) => edit(project.cwd, { draft: event.target.value })}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter breaks the line, and Enter that only confirms an input method's text does neither.
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  submitNow(project);
                }} />
              {working && active && <button type="button" aria-label={t("Stopp")} title={t("Stopp")}
                onClick={() => { void cancel(active.requestId).catch((error) => errors.set((all) => ({ ...all, [project.cwd]: failure(error) }))); }}
                className="pressable pressable-fill mb-1.5 grid size-7 shrink-0 place-items-center rounded-full bg-fill-2 text-label">
                <Square size={12} weight="fill" />
              </button>}
              <button type="submit" aria-label={working ? t("In die Warteschlange stellen") : t("Senden")} title={working ? t("In die Warteschlange stellen") : undefined}
                disabled={!isNative || !project.draft.trim() || project.draft.length > MAX_DRAFT || (working && lineup.length >= MAX_QUEUE)}
                className="pressable pressable-fill mb-1.5 grid size-7 shrink-0 place-items-center rounded-full bg-fill-2 text-label disabled:opacity-40">
                <ArrowUp size={15} weight="bold" />
              </button>
            </form>
          </div>
        </>
      )}
      <AnimatePresence>{reading && <Reader key="reader" message={reading} onClose={() => setReading(null)} />}</AnimatePresence>
    </div>
  );
}

function QuotaRing({ id, value }: { id: Agent; value: number | null }) {
  if (value === null) return null;
  return <span className="flex items-center gap-1 font-normal text-label-3"><Ring id={id} value={value} />{Math.round(value)}%</span>;
}

function Entry({ message, onRead, onRetry }: { message: Message; onRead: () => void; onRetry?: () => void }) {
  const reduced = useReducedMotion();
  const enter = { initial: { opacity: 0, y: reduced ? 0 : 6, scale: reduced ? 1 : 0.985, rotateX: reduced ? 0 : -3 }, animate: { opacity: 1, y: 0, scale: 1, rotateX: 0 }, transition: reduced ? fade : springs.snappy, style: { transformPerspective: 650, transformOrigin: "center bottom" } };
  const long = isLong(message.text);
  // A long message scrolls inside its own box, so the wheel scrolls it and does not switch tools.
  const scroll = long ? "max-h-40 select-text overflow-y-auto overscroll-contain pe-1 [scrollbar-width:thin]" : "";
  const body = message.role === "user"
    ? <p tabIndex={long ? 0 : undefined} className={`whitespace-pre-wrap break-words text-body text-label ${scroll}`}>{message.text}</p>
    : <div tabIndex={long ? 0 : undefined} className={scroll}><Markdown text={message.text} /></div>;
  const expand = (
    <div className="mt-0.5 flex items-center gap-1">
      {long && (
        <button type="button" onClick={onRead} className="pressable-fill inline-flex items-center gap-1 rounded text-caption text-label-3 hover:text-label-2">
          <ArrowsOutSimple size={11} weight="bold" />{t("Vollständig lesen")}
        </button>
      )}
      <CopyButton text={message.text} label={t("Nachricht kopieren")} />
    </div>
  );
  if (message.role === "user") {
    return (
      <motion.article {...enter} className="max-w-[78%] self-end rounded-[16px] bg-fill-1 px-3 py-2">
        {body}
        {expand}
      </motion.article>
    );
  }
  return (
    <motion.article {...enter} className="max-w-[90%]">
      <div className="flex items-center gap-[5px] text-caption text-label-2">
        <span style={{ color: brandColor[message.role] }}><BrandLogo id={message.role} size={12} /></span>
        {AGENTS[message.role].name} · {message.model}
      </div>
      {typeof message.thinking === "string" && message.thinking && <Thinking text={message.thinking} agent={message.role} />}
      <div className="mt-[3px]">{body}</div>
      {expand}
      {message.permissionDenied && <p className="text-caption text-orange">{t("Die CLI hat mindestens eine Aktion abgelehnt")}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="pressable-fill mt-0.5 rounded px-1 text-caption text-link hover:text-label">
          {t("Mit Bearbeitungsrechten wiederholen")}
        </button>
      )}
    </motion.article>
  );
}

/** A button for something that cannot be undone: the first click asks, the second does it, and the question lapses after a few seconds. */
function ConfirmButton({ icon: Icon, label, confirm, disabled, onConfirm }: { icon: typeof X; label: string; confirm: string; disabled?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = window.setTimeout(() => setAsking(false), 4000);
    return () => window.clearTimeout(timer);
  }, [asking]);
  useEffect(() => { if (disabled) setAsking(false); }, [disabled]);
  return (
    <button type="button" disabled={disabled} aria-label={asking ? confirm : label} title={asking ? confirm : label}
      onClick={() => { if (asking) { setAsking(false); onConfirm(); } else setAsking(true); }}
      onBlur={() => setAsking(false)}
      className={`pressable pressable-fill flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-caption disabled:opacity-40 ${asking ? "bg-fill-2 text-red" : "text-label-3 hover:text-label-2"}`}>
      <Icon size={12} weight="bold" />{asking && <span className="whitespace-nowrap">{confirm}</span>}
    </button>
  );
}

function Loading() {
  const reduced = useReducedMotion();
  return <motion.span aria-hidden className="inline-flex shrink-0" animate={reduced ? { rotate: 0 } : { rotate: 360 }} transition={reduced ? fade : spin}><CircleNotch size={14} weight="bold" /></motion.span>;
}

/** Published thinking stays separate from the answer, and is never sent in a handoff. */
function Thinking({ text, agent, working = false }: { text: string; agent: Agent; working?: boolean }) {
  const [open, setOpen] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const panelId = useId();
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!working) return;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [working]);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade} className="my-1 min-w-0 rounded-[12px] border border-white/5 bg-fill-1">
      <button type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}
        className="flex min-h-8 w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-caption text-label-2 hover:bg-fill-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-label-3">
        <motion.span aria-hidden animate={{ rotate: open ? 90 : 0 }} transition={fade} className="inline-flex"><CaretRight size={11} weight="bold" /></motion.span>
        <span style={{ color: brandColor[agent] }} className="inline-flex">{working ? <Loading /> : <BrandLogo id={agent} size={13} />}</span>
        <motion.span animate={working && !reduced ? { opacity: [0.55, 1] } : { opacity: 1 }} transition={working && !reduced ? pulse : fade}>
          {AGENTS[agent].name} · {working ? t("Denkt nach") : t("Gedankengang")}
        </motion.span>
        {working && <span className="ms-auto tabular-nums text-label-3">{seconds}s</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && <motion.div key="content" id={panelId} role="region" aria-label={t("Gedankengang")}
          initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduced ? fade : springs.snappy} className="overflow-hidden">
          <div tabIndex={0} className="mx-3 mb-2 max-h-40 select-text overflow-y-auto overscroll-contain border-s border-label-3/20 ps-3 pe-1 [scrollbar-width:thin]">
            <p className="whitespace-pre-wrap break-words text-caption leading-relaxed text-label-2">{text || t("Warten auf verfügbare Denkdetails der CLI.")}</p>
          </div>
        </motion.div>}
      </AnimatePresence>
      {working && <span className="sr-only" role="status">{AGENTS[agent].name} · {t("Arbeitet")}</span>}
    </motion.div>
  );
}

/** One message in full, over the chat: for text too long for the log. Escape closes this and not the notch. */
function Reader({ message, onClose }: { message: Message; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => sheet.current?.focus(), []);
  const title = message.role === "user" ? t("Du") : `${AGENTS[message.role].name} · ${message.model}`;
  return (
    <motion.div
      ref={sheet}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), onClose())}
      className="absolute inset-x-4 top-1 bottom-2 z-20 flex flex-col overflow-hidden rounded-[14px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)] outline-none"
      initial={{ opacity: 0, transform: reduced ? "none" : "perspective(800px) translateY(8px) rotateX(-4deg) scale(0.98)" }}
      animate={{ opacity: 1, transform: "perspective(800px) translateY(0px) rotateX(0deg) scale(1)" }}
      exit={{ opacity: 0, transform: reduced ? "none" : "perspective(800px) translateY(4px) rotateX(2deg) scale(0.99)" }}
      transition={fade}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 pe-1.5 ps-3">
        {message.role !== "user" && <span style={{ color: brandColor[message.role] }}><BrandLogo id={message.role} size={12} /></span>}
        <span className="min-w-0 flex-1 truncate text-footnote font-semibold">{title}</span>
        <CopyButton text={message.text} label={t("Nachricht kopieren")} />
        <button type="button" onClick={onClose} aria-label={t("Schließen")} title={t("Schließen")}
          className="pressable pressable-fill flex size-6 items-center justify-center rounded-full text-label-3 hover:text-label">
          <X size={13} weight="bold" />
        </button>
      </div>
      <div className="min-h-0 flex-1 select-text overflow-y-auto px-3 pb-3">
        {message.role === "user"
          ? <p className="whitespace-pre-wrap break-words text-body text-label">{message.text}</p>
          : <Markdown text={message.text} />}
      </div>
    </motion.div>
  );
}
