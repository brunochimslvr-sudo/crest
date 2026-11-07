import { useState } from "react";
import { motion } from "motion/react";
import { ArrowClockwise, Check, Copy, Robot, WarningCircle } from "@phosphor-icons/react";
import { content, spin } from "../../design/motion";
import { formatAgo } from "../../lib/format";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { Button, Empty, Skeleton } from "../../ui/controls";
import { t } from "../../i18n";
import { agents, refreshAgentsNow, useAgentsViewer, type AgentsError } from "./store";
import { resumeCommand, spanParts, waitedMs, type AgentSession, type Phase } from "./sessions";
import { AgentChat } from "./AgentChat";

/** Rows drawn; the order puts the sessions that need the user first, so what is cut is the least urgent. */
const SHOWN = 200;
/** A wait shorter than this is only the reason, not a time. */
const SHOW_WAIT_MS = 60_000;

const TONE: Record<Phase, { dot: string; text: string }> = {
  waiting: { dot: "bg-orange", text: "text-orange" },
  failed: { dot: "bg-red", text: "text-red" },
  working: { dot: "bg-link", text: "text-link" },
  idle: { dot: "bg-label-3", text: "text-label-2" },
  done: { dot: "bg-green", text: "text-green" },
  stopped: { dot: "bg-label-3", text: "text-label-3" },
  other: { dot: "bg-fill-3", text: "text-label-3" },
};

const PHASE_LABEL: Record<Exclude<Phase, "other">, string> = {
  waiting: "Braucht dich",
  failed: "Fehlgeschlagen",
  working: "Arbeitet",
  idle: "Leerlauf",
  done: "Fertig",
  stopped: "Angehalten",
};

/** What `waitingFor` says, as Claude Code words it. A new one is shown as it comes. */
const REASON: Record<string, string> = {
  "permission prompt": "Genehmigung nötig",
  "input needed": "Eingabe nötig",
  "sandbox request": "Sandbox-Anfrage",
  "worker request": "Worker-Anfrage",
  "dialog open": "Dialog offen",
};

const KIND: Record<string, string> = { interactive: "Interaktiv", background: "Hintergrund" };

const agentsError: Record<AgentsError, { title: string; hint?: string }> = {
  "not-found": { title: "Claude Code wurde auf diesem PC nicht gefunden", hint: "Installiere Claude Code oder starte Crest neu, falls es gerade erst installiert wurde" },
  "too-old": { title: "Dafür braucht es ein neueres Claude Code", hint: "Aktualisieren geht mit: claude update" },
  invalid: { title: "Claude Code hat ungültiges JSON geliefert" },
  timeout: { title: "Claude Code hat nicht rechtzeitig geantwortet" },
  "too-big": { title: "Die Antwort von Claude Code ist zu groß" },
  failed: { title: "Claude Code hat einen Fehler gemeldet" },
};

function phaseText(s: AgentSession): string {
  return s.phase === "other" ? (s.status ?? s.state ?? t("Unbekannt")) : t(PHASE_LABEL[s.phase]);
}

function reasonText(s: AgentSession): string {
  if (!s.waitingFor) return s.state === "blocked" || s.status === "waiting" ? t("Blockiert") : "";
  return REASON[s.waitingFor] ? t(REASON[s.waitingFor]) : s.waitingFor;
}

/** "3 min", "2 h 5 min", "1 d 3 h". */
function span(ms: number): string {
  const { d, h, m } = spanParts(ms);
  if (d) return `${t("{n} T.", { n: d })} ${t("{n} Std.", { n: h })}`;
  if (h) return `${t("{n} Std.", { n: h })} ${t("{n} Min.", { n: m })}`;
  return m ? t("{n} Min.", { n: m }) : t("gerade eben");
}

/*
 *   3 sessions · 1 needs you
 *   ● Needs you   Tune the notch spring                          47 min   [copy]
 *                 Approval needed · Waiting for 3 min · Interactive · C:\…\crest
 *   ● Working     Update dependencies                            12 min   [copy]
 *   ● Idle        docs                                            3 min   [copy]
 */
export function AgentsView() {
  const [showSessions, setShowSessions] = useState(false);
  // Polled while this tool is open, not only in the list, so the dot can tell that a session needs the user.
  useAgentsViewer();
  const { sessions, loading } = agents.use();
  const needsYou = sessions.some((s) => s.phase === "waiting");
  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2 px-4 pb-3 pt-1">
      <HeaderActions>
        {showSessions && (
          <HeaderButton label={t("Aktualisieren")} onClick={refreshAgentsNow}>
            <motion.span className="flex" animate={{ rotate: loading ? 360 : 0 }} transition={loading ? spin : { duration: 0 }}>
              <ArrowClockwise size={14} weight="bold" />
            </motion.span>
          </HeaderButton>
        )}
        <button
          type="button"
          aria-pressed={showSessions}
          onClick={() => setShowSessions(!showSessions)}
          className="pressable pressable-fill flex h-7 items-center gap-1.5 rounded-full px-2.5 text-footnote text-label-2 aria-pressed:bg-fill-3 aria-pressed:text-label"
        >
          {needsYou && <span className="size-2 rounded-full bg-orange" aria-hidden />}
          {showSessions ? t("Unterhaltung") : t("Sitzungen")}
        </button>
      </HeaderActions>
      {showSessions ? <div className="min-h-0 flex-1"><SessionsView /></div> : <AgentChat />}
    </div>
  );
}

function SessionsView() {
  const { sessions, skipped, waits, error, updatedAt } = agents.use();
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(null);

  const copy = async (s: AgentSession) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(resumeCommand(s.sessionId!));
    } catch {
      ok = false;
    }
    setCopied({ key: s.key, ok });
    window.setTimeout(() => setCopied((c) => (c?.key === s.key ? null : c)), 1600);
  };

  // Nothing to show yet, or the CLI is missing or too old.
  if (!sessions.length && error) {
    const e = agentsError[error];
    return (
      <>
        <Empty icon={WarningCircle} title={t(e.title)} text={e.hint && t(e.hint)} action={<Button onClick={refreshAgentsNow}>{t("Erneut versuchen")}</Button>} />
      </>
    );
  }
  if (updatedAt === null) {
    return (
      <>
        <div className="flex h-full flex-col gap-2 px-4 pt-1" aria-busy="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </>
    );
  }
  if (!sessions.length) {
    return (
      <>
        <Empty icon={Robot} title={t("Keine Sitzungen")} text={t("Starte claude in einem Terminal, dann erscheint die Sitzung hier")} />
      </>
    );
  }

  const waiting = sessions.filter((s) => s.phase === "waiting").length;
  const shown = sessions.slice(0, SHOWN);
  const more = sessions.length - shown.length + skipped;
  return (
    <motion.div className="flex h-full flex-col gap-2 px-4 pt-1 pb-3" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: content.enter }}>
      <div className="flex shrink-0 items-baseline gap-1.5 text-caption text-label-3" aria-live="polite">
        <span>{t(sessions.length === 1 ? "{n} Sitzung" : "{n} Sitzungen", { n: sessions.length })}</span>
        {waiting > 0 && <span className="font-medium text-orange">· {t(waiting === 1 ? "{n} braucht dich" : "{n} brauchen dich", { n: waiting })}</span>}
      </div>
      {error && (
        <div className="flex shrink-0 items-center gap-1.5 text-caption text-orange" role="status">
          <WarningCircle size={13} weight="bold" className="shrink-0" />
          <span className="truncate">
            {t(agentsError[error].title)}
            {updatedAt !== null && ` · ${t("Stand {ago}", { ago: formatAgo(Date.now() - updatedAt) })}`}
          </span>
        </div>
      )}
      <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 [scrollbar-width:none]" aria-label={t("Agents")}>
        {shown.map((s) => (
          <Row key={s.key} s={s} now={updatedAt} wait={waitedMs(waits, s.key, updatedAt)} copied={copied?.key === s.key ? copied.ok : null} onCopy={() => void copy(s)} />
        ))}
        {more > 0 && <li className="px-2 py-1 text-caption text-label-3">{t("+{n} weitere", { n: more })}</li>}
      </ul>
    </motion.div>
  );
}

function Row({ s, now, wait, copied, onCopy }: { s: AgentSession; now: number; wait: number; copied: boolean | null; onCopy: () => void }) {
  const tone = TONE[s.phase];
  const waitText = s.phase === "waiting" && wait >= SHOW_WAIT_MS ? t("Wartet seit {time}", { time: span(wait) }) : "";
  const details = [s.phase === "waiting" ? reasonText(s) : "", waitText, KIND[s.kind] ? t(KIND[s.kind]) : s.kind].filter(Boolean).join(" · ");
  const copyLabel = copied === null ? t("Befehl zum Fortsetzen kopieren") : copied ? t("Kopiert") : t("Kopieren fehlgeschlagen");
  return (
    <li className="flex shrink-0 items-center gap-2.5 rounded-md bg-fill-1 py-1.5 pe-1.5 ps-2.5">
      <span className={`size-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
      <span className={`w-24 shrink-0 truncate text-caption font-medium ${tone.text}`} title={phaseText(s)}>
        {phaseText(s)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium text-label">{s.title || t("Sitzung")}</div>
        <div className="flex min-w-0 items-center text-caption text-label-3" title={[s.cwd, waitText && t("Ab dem Moment gezählt, in dem Crest die Sitzung zum ersten Mal wartend sah")].filter(Boolean).join("\n")}>
          {details && <span className={`shrink-0 ${s.phase === "waiting" ? "text-label-2" : ""}`}>{details}</span>}
          {details && s.cwd && <span className="shrink-0 px-1">·</span>}
          {s.cwd && (
            <span dir="ltr" className="min-w-0 truncate">
              {s.cwd}
            </span>
          )}
        </div>
      </div>
      {s.startedAt !== null && (
        <span className="tabular shrink-0 text-caption text-label-3" title={t("Seit dem Start")}>
          {span(now - s.startedAt)}
        </span>
      )}
      {s.sessionId ? (
        <button
          aria-label={copyLabel}
          title={copyLabel}
          onClick={onCopy}
          className="pressable pressable-fill flex size-7 shrink-0 items-center justify-center rounded-full text-label-3 hover:text-label-2"
        >
          {copied ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
        </button>
      ) : (
        <span className="size-7 shrink-0" aria-hidden />
      )}
    </li>
  );
}
