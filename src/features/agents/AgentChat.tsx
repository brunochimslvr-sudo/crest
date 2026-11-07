import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { ArrowsOutSimple, ArrowUp, FolderOpen, Plus, X } from "@phosphor-icons/react";
import { fade } from "../../design/motion";
import { t } from "../../i18n";
import { createStore } from "../../lib/store";
import { HeaderLead } from "../../notch/header";
import { Ring, ringValue } from "../../notch/row/parts/Rings";
import { isNative } from "../../platform/native";
import { BrandLogo, brandColor } from "../../ui/brands";
import { usage, useUsageViewer } from "../usage/store";
import { formatTokens } from "../usage/format";
import { AGENTS, agentIds, effortIds, modelsOf, planTurn, restoreProjects, shortModel, tokensByModel, type Agent, type Effort, type Message, type Project, type Turn } from "./chat";

const STORAGE_KEY = "crest.agent-projects.v1";
const EFFORTS: Record<Effort, { name: string; dot: string }> = {
  low: { name: "Low", dot: "bg-green" },
  medium: { name: "Medium", dot: "bg-yellow" },
  high: { name: "High", dot: "bg-red" },
};
/** A message longer than this is cut short in the log, with a button for all of it. */
const LONG_CHARS = 480;
const LONG_LINES = 8;

type AgentReply = { text: string; tokens: number | null; permissionDenied: boolean; session: string | null };

function loadProjects(): Project[] {
  try {
    return restoreProjects(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

const projects = createStore(loadProjects());
const selected = createStore(0);
const running = createStore<string | null>(null);
const errors = createStore<Record<string, string>>({});

// The whole history is written as one piece, so a draft is saved after a pause in typing, and when the window goes away.
let saveTimer = 0;
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects.get()));
  } catch {
    // A full or unavailable storage area still allows working until Crest exits.
  }
}
function saveSoon() {
  if (!saveTimer) saveTimer = window.setTimeout(save, 500);
}
window.addEventListener("pagehide", () => saveTimer && save());

function update(change: (items: Project[]) => Project[], now = false) {
  projects.set(change(projects.get()));
  if (now) save();
  else saveSoon();
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
  busy: "Ein Agent arbeitet bereits",
};

/** What the page shows for a code from the backend; `cli:` carries what the CLI itself said. */
function failure(error: unknown): string {
  const code = String(error);
  if (code.startsWith("cli:")) return t("Die CLI meldet: {reason}", { reason: code.slice(4) });
  return t(errorText[code] ?? "Die CLI konnte die Anfrage nicht abschließen");
}

async function send(project: Project) {
  const text = project.draft.trim();
  if (!isNative || running.get() !== null || !text) return;
  const { cwd, agent, model, effort, messages, sessions } = project;
  const ask = (turn: Turn) => invoke<AgentReply>("agents_chat", { agent, cwd, model, effort, prompt: turn.prompt, session: turn.session ?? null });
  running.set(cwd);
  errors.set((all) => ({ ...all, [cwd]: "" }));
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
      { role: agent, model, text: reply.text, tokens: reply.tokens ?? undefined, permissionDenied: reply.permissionDenied },
    ];
    edit(cwd, (current) => ({
      draft: "",
      messages: [...current.messages, ...turn].slice(-80),
      sessions: { ...current.sessions, [agent]: reply.session ?? undefined },
    }), true);
  } catch (error) {
    // A conversation that failed to continue must not be tried again.
    if (String(error) === "session-lost") edit(cwd, (current) => ({ sessions: { ...current.sessions, [agent]: undefined } }), true);
    errors.set((all) => ({ ...all, [cwd]: failure(error) }));
  } finally {
    running.set(null);
  }
}

const isLong = (text: string) => text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

export function AgentChat() {
  useUsageViewer();
  const { providers } = usage.use();
  const items = projects.use();
  const index = selected.use();
  const busy = running.use();
  const error = errors.use();
  const project = items[index];
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [reading, setReading] = useState<Message | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [index, project?.messages.length, busy]);
  useEffect(() => setReading(null), [index]);

  function add(event: FormEvent) {
    event.preventDefault();
    const cwd = path.trim();
    if (!cwd) return;
    const existing = items.findIndex((item) => item.cwd.toLowerCase() === cwd.toLowerCase());
    if (existing === -1) {
      update((all) => [...all, { cwd, agent: "codex", model: modelsOf("codex")[0], effort: "medium", draft: "", messages: [], sessions: {} }], true);
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
  const working = !!project && busy === project.cwd;
  const tab = "text-footnote pressable-fill rounded-md";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <HeaderLead>
        <div className="flex min-w-0 items-baseline gap-3" role="group" aria-label={t("Projekte")}>
          {items.map(({ cwd }, i) => (
            <button key={cwd} type="button" title={cwd} aria-pressed={i === index} onClick={() => selected.set(i)}
              className={`${tab} max-w-28 shrink-0 truncate text-label-2 aria-pressed:font-semibold aria-pressed:text-label`}>
              {folderName(cwd)}
            </button>
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
          <div className="min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-width:none]" role="log" aria-label={t("Unterhaltung")}>
            <div className="flex min-h-full flex-col justify-end gap-3">
              {project.messages.map((message, i) => <Entry key={i} message={message} onRead={() => setReading(message)} />)}
              {working && (
                <p role="status" className="flex items-center gap-[5px] text-caption text-label-2">
                  <span style={{ color: brandColor[project.agent] }}><BrandLogo id={project.agent} size={12} /></span>
                  {AGENTS[project.agent].name} · {t("Arbeitet")}
                </p>
              )}
              <div ref={bottom} />
            </div>
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
            <span className="flex-1" />
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
            <div role="group" aria-label={t("Agent")} className="flex h-10 items-center gap-0.5 rounded-[14px] bg-fill-2 p-0.5">
              {agentIds.map((id) => {
                const on = project.agent === id;
                const value = quota(id);
                return (
                  <button key={id} type="button" disabled={working} aria-pressed={on}
                    aria-label={AGENTS[id].name} title={`${AGENTS[id].name}${value === null ? "" : ` · ${Math.round(value)}%`}`}
                    onClick={() => { if (!on) edit(project.cwd, { agent: id, model: modelsOf(id)[0] }, true); }}
                    className={`pressable relative flex h-9 w-[42px] items-center justify-center rounded-[12px] transition-colors duration-150 disabled:opacity-60 ${on ? "bg-fill-3" : ""}`}
                    style={{ color: brandColor[id] }}>
                    <BrandLogo id={id} size={18} />
                    {on && <span aria-hidden className="absolute bottom-[3px] left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-label" />}
                  </button>
                );
              })}
            </div>
            <form className="flex min-h-10 min-w-0 flex-1 items-end gap-2 rounded-[14px] bg-fill-1 pe-1.5 ps-3.5" onSubmit={(event) => { event.preventDefault(); void send(project); }}>
              <textarea rows={1} maxLength={5000} required aria-label={t("Nachricht")} placeholder={t("Nachricht oder Code eingeben")}
                className="max-h-24 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-[11px] text-body text-label [field-sizing:content]"
                value={project.draft} disabled={working} onChange={(event) => edit(project.cwd, { draft: event.target.value })}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter breaks the line, and Enter that only confirms an input method's text does neither.
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void send(project);
                }} />
              <button type="submit" aria-label={t("Senden")} disabled={!isNative || busy !== null || !project.draft.trim()}
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

function Entry({ message, onRead }: { message: Message; onRead: () => void }) {
  const long = isLong(message.text);
  const body = (
    <p className={`whitespace-pre-wrap break-words text-body text-label ${long ? "line-clamp-6" : ""}`}>{message.text}</p>
  );
  const expand = long && (
    <button type="button" onClick={onRead} className="pressable-fill mt-0.5 inline-flex items-center gap-1 rounded text-caption text-label-3 hover:text-label-2">
      <ArrowsOutSimple size={11} weight="bold" />{t("Vollständig lesen")}
    </button>
  );
  if (message.role === "user") {
    return (
      <article className="max-w-[78%] self-end rounded-[16px] bg-fill-1 px-3 py-2">
        {body}
        {expand}
      </article>
    );
  }
  return (
    <article className="max-w-[90%]">
      <div className="flex items-center gap-[5px] text-caption text-label-2">
        <span style={{ color: brandColor[message.role] }}><BrandLogo id={message.role} size={12} /></span>
        {AGENTS[message.role].name} · {message.model}
      </div>
      <div className="mt-[3px]">{body}</div>
      {expand}
      {message.permissionDenied && <p className="text-caption text-orange">{t("Die CLI hat mindestens eine Aktion abgelehnt")}</p>}
    </article>
  );
}

/** One message in full, over the chat: for text too long for the log. Escape closes this and not the notch. */
function Reader({ message, onClose }: { message: Message; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
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
      initial={{ opacity: 0, transform: "translateY(6px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transform: "translateY(4px)" }}
      transition={fade}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 pe-1.5 ps-3">
        {message.role !== "user" && <span style={{ color: brandColor[message.role] }}><BrandLogo id={message.role} size={12} /></span>}
        <span className="min-w-0 flex-1 truncate text-footnote font-semibold">{title}</span>
        <button type="button" onClick={onClose} aria-label={t("Schließen")} title={t("Schließen")}
          className="pressable pressable-fill flex size-6 items-center justify-center rounded-full text-label-3 hover:text-label">
          <X size={13} weight="bold" />
        </button>
      </div>
      <div className="min-h-0 flex-1 select-text overflow-y-auto px-3 pb-3">
        <p className="whitespace-pre-wrap break-words text-body text-label">{message.text}</p>
      </div>
    </motion.div>
  );
}
