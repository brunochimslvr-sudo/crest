import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, Reorder } from "motion/react";
import {
  AppWindow,
  ArrowsInLineHorizontal,
  BellSimple,
  CalendarBlank,
  ChartDonut,
  CloudSun,
  CheckCircle,
  Clock,
  Cpu,
  DownloadSimple,
  GithubLogo,
  DotsSixVertical,
  Keyboard,
  LockSimple,
  MagnifyingGlass,
  Monitor,
  MusicNote,
  Palette,
  Play,
  Plugs,
  PuzzlePiece,
  Bug,
  TerminalWindow,
  SlidersHorizontal,
  Sparkle,
  SquaresFour,
  SignOut,
  Stop,
  Timer,
  Waveform,
  type Icon,
} from "@phosphor-icons/react";
import { content, fade, springs } from "../../design/motion";
import { alarmSounds, playAlarm, type AlarmDuration } from "../../lib/sound";
import { nav, navigate } from "../../notch/nav";
import { findTab, setupTab } from "../../notch/tabs";
import { PluginSettings } from "../plugins/PluginSettings";
import { plugins } from "../plugins/store";
import {
  autostart,
  build,
  display,
  openSponsors,
  openBugReport,
  openStoreReview,
  portable,
  secrets,
  systemDiagnostics,
  unlockFps,
  type MonitorInfo,
  type SecretName,
} from "../../platform/services";
import { diagnosticsText } from "./diagnostics";
import { searchSettings, type SearchEntry } from "./search";
import { github } from "../github/store";
import { settings, updateAsk, updateSettings, type AskProvider } from "../../settings/store";
import { DiscordLogo } from "../../ui/brands";
import { Button, Group, Row, Segmented, Select, Slider, StyleCards, Switch, TextField } from "../../ui/controls";
import { PET_IDS, PET_SIZE, type ClosedSettings, type PartId, type PetId } from "../../notch/row/parts";
import { PetArt } from "../../notch/pet/Nest";
import { PET_NAMES } from "../../notch/pet/art";
import { effortLevels, providerInfo } from "../ask/providers";
import { discordState, reconnectDiscord } from "../discord/store";
import { fps, useFpsPolling } from "../system/gaming";
import { PlaceSearch } from "../weather/WeatherView";
import { VaultSettings } from "../vault/VaultSettings";
import { ClockLookSettings, TimerLookSettings } from "../timer/LookSettings";
import { focusSounds, type FocusSound } from "../timer/focusSound";
import { ProductivitySettings } from "../water/WaterSettings";
import { BreaksSettings } from "../breaks/BreaksSettings";
import { TerminalSettings } from "../terminal/TerminalSettings";
import { MusicSettings } from "../now-playing/MusicSettings";
import { setMusic } from "../now-playing/music";
import { UsageSettings } from "../usage/UsageSettings";
import { SystemSettings } from "../system/SystemSettings";
import { LauncherSettings } from "../launcher/LauncherSettings";
import { GithubSettings } from "../github/GithubSettings";
import { CalendarSettings } from "../calendar/CalendarSettings";
import { NoticesSettings } from "../notices/NoticesSettings";
import { WindowSettings, keyText } from "../window/WindowSettings";
import { keycaps } from "../window/hotkeys";
import { hotkeyStatus } from "../window/store";
import { TradingSettings } from "../trading/TradingSettings";
import { detectPlace } from "../weather/store";
import { focusMode, setFocusMode } from "../../notch/focus";
import { checkForUpdate, installUpdate, update } from "../../lib/update";
import { across } from "../../notch/edge";
import { EdgeSettings } from "../../notch/EdgeSettings";
import { SizeSettings } from "../../notch/SizeSettings";
import { PortableNote } from "../portable/PortableNote";
import { between, changelog, markSeen, useUnseen } from "../../lib/changelog";
import { privacy, togglePresentation, usePresenting } from "../privacy/store";
import { english, LANGUAGE_NAMES, LANGUAGES, t, tBackend, type LanguageSetting } from "../../i18n";
import { ChangelogList } from "../whatsnew/ChangelogList";
import { isMac } from "../../platform/native";
import { ThemeSettings } from "../themes/ThemeSettings";
import { HideFromSharingRow } from "../meeting/HideFromSharingRow";
import { hueVar, useIconColors, type Hue } from "../themes/hues";
import { ClipboardSettings } from "../clipboard/ClipboardSettings";

type PageId = "general" | "display" | "window" | "tools" | "timer" | "ai" | "accounts" | "themes" | "notices" | "plugins";

const allPages: { id: PageId; label: string; icon: Icon; hue: Hue }[] = [
  { id: "general", label: "Allgemein", icon: SlidersHorizontal, hue: "slate" },
  { id: "display", label: "Darstellung", icon: Monitor, hue: "blue" },
  { id: "window", label: "Fenster", icon: AppWindow, hue: "indigo" },
  { id: "tools", label: "Tools", icon: SquaresFour, hue: "orange" },
  { id: "timer", label: "Timer", icon: Timer, hue: "amber" },
  { id: "ai", label: "AI", icon: Sparkle, hue: "violet" },
  { id: "accounts", label: "Verbindungen", icon: Plugs, hue: "teal" },
  { id: "themes", label: "Themen", icon: Palette, hue: "pink" },
  { id: "notices", label: "Mitteilungen", icon: BellSimple, hue: "red" },
  { id: "plugins", label: "Plugins", icon: PuzzlePiece, hue: "green" },
];
// Plugin pages are served over http://crestplugin.localhost, which only works on Windows, and live notices have no Mac
// version (the tool is in WINDOWS_ONLY, src/notch/tabs.ts).
const pages = allPages.filter((p) => !(isMac && (p.id === "plugins" || p.id === "notices")));

/** Deep links from other tools (`navigate("settings", "<section>")`) → page holding that section. */
const sectionPage: Record<string, PageId> = {
  weather: "general",
  updates: "general",
  display: "display",
  presentation: "display",
  window: "window",
  alarm: "timer",
  ask: "ai",
  usage: "ai",
  discord: "accounts",
  trading: "accounts",
  vault: "tools",
  todos: "tools",
  water: "tools",
  terminal: "tools",
  themes: "themes",
  system: "tools",
  launcher: "tools",
  github: "accounts",
  calendar: "accounts",
  notices: "notices",
  plugins: "plugins",
};

/** Last open page survives closing/opening the notch (the component is rebuilt). */
let savedPage: PageId = "general";

type Hit = SearchEntry & { page: PageId; groupId: string };

const textOf = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";
/** The Row whose label and group a hit names, inside `root`. */
const findRow = (root: Element, h: Hit) =>
  [...root.querySelectorAll<HTMLElement>("[data-row]")].find((r) => textOf(r.querySelector("[data-row-label]")) === h.label && (r.closest("section")?.id ?? "") === h.groupId);

/** Every Row of the pages rendered under `root` (one `data-page` wrapper each), with its group's title and the English texts. */
function readRows(root: HTMLElement): Hit[] {
  const seen = new Set<string>();
  return [...root.querySelectorAll<HTMLElement>("[data-page]")].flatMap((pageEl) =>
    [...pageEl.querySelectorAll("[data-row]")].flatMap((row) => {
      const page = pageEl.dataset.page as PageId;
      const section = row.closest("section");
      const groupId = section?.id ?? "";
      const label = textOf(row.querySelector("[data-row-label]"));
      const key = `${page}|${groupId}|${label}`;
      if (!label || seen.has(key)) return [];
      seen.add(key);
      const hint = textOf(row.querySelector("[data-row-hint]"));
      const group = textOf(section?.querySelector(":scope > h3"));
      return [{ page, groupId, label, hint, group, en: { label: english(label), hint: english(hint), group: english(group) } }];
    }),
  );
}

/**
 * Settings like macOS: categories on the left, only their content on the right.
 * Other tools jump straight to their section via `navigate("settings", "<section>")`.
 */
export function SettingsView() {
  const { section } = nav.use();
  const [page, setPageState] = useState<PageId>(() => (section && sectionPage[section]) || savedPage);
  const iconColors = useIconColors();
  const scroller = useRef<HTMLDivElement>(null);
  const setPage = (p: PageId) => {
    savedPage = p;
    setPageState(p);
  };
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Hit[]>([]);
  const [target, setTarget] = useState<Hit | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const hidden = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const results = searching ? searchSettings(rows, query) : [];

  // The index is the real pages, rendered hidden while searching and read again on every keystroke, so it never goes stale.
  useLayoutEffect(() => {
    if (searching && hidden.current) setRows(readRows(hidden.current));
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rows that wait for data (monitors, vault, plugins) join the hidden pages after the first read.
  useEffect(() => {
    const root = hidden.current;
    if (!searching || !root) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRows(readRows(root)));
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [searching]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      field.current?.focus();
      field.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openHit = (h: Hit) => {
    setQuery("");
    setPage(h.page);
    setTarget(h);
  };

  useEffect(() => {
    if (!target) return;
    // Like the deep link below: the row only exists after the page switch.
    const id = window.setTimeout(() => {
      const box = scroller.current;
      const row = box && findRow(box, target);
      if (!row) return;
      const group = row.closest("section");
      const fits = !!group && row.getBoundingClientRect().bottom - group.getBoundingClientRect().top <= box.clientHeight;
      (fits ? group : row).scrollIntoView({ behavior: "smooth", block: fits ? "start" : "center" });
      row.animate([{ backgroundColor: "var(--color-fill-3)" }, { backgroundColor: "var(--color-fill-3)", offset: 0.4 }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
    }, 120);
    return () => window.clearTimeout(id);
  }, [target]);

  useEffect(() => {
    if (!section || !sectionPage[section]) return;
    setPage(sectionPage[section]);
    // The section only exists after the page switch.
    const id = window.setTimeout(
      () => scroller.current?.querySelector<HTMLElement>(`#settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      120,
    );
    return () => window.clearTimeout(id);
  }, [section]);

  return (
    <div className="flex h-full gap-3 px-4 pt-1 pb-3">
      <nav className="flex w-[136px] shrink-0 flex-col gap-0.5">
        <label className="mb-1 flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] bg-fill-1 px-2 text-label-3 focus-within:bg-fill-2">
          <MagnifyingGlass size={12} weight="bold" className="shrink-0" />
          <input
            ref={field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || !query) return;
              // Esc clears first; only an empty field lets it through to close the notch.
              e.stopPropagation();
              setQuery("");
            }}
            placeholder={t("Suchen")}
            aria-label={t("Suchen")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-footnote text-label outline-none placeholder:text-label-4"
          />
        </label>
        {pages.map((p) => {
          const active = p.id === page && !searching;
          return (
            <button
              key={p.id}
              onClick={() => {
                setQuery("");
                setPage(p.id);
              }}
              aria-current={active ? "page" : undefined}
              className={`pressable relative flex h-8 items-center gap-2 rounded-[8px] px-2.5 text-start text-body transition-colors duration-150 ${
                active ? "text-label" : "text-label-3 hover:text-label-2"
              }`}
            >
              {active && <motion.span layoutId="settings-page" className="absolute inset-0 rounded-[8px] bg-fill-2" transition={springs.snappy} />}
              <p.icon size={15} weight={active ? "fill" : "bold"} className="relative shrink-0" style={iconColors ? { color: hueVar(p.hue) } : undefined} />
              <span className="relative truncate">{t(p.label)}</span>
            </button>
          );
        })}
        {/* Not a page: opens GitHub's form, with this version filled in. */}
        <button
          onClick={openBugReport}
          title={t("Öffnet das Formular auf GitHub, mit deiner Crest-Version schon eingetragen")}
          className="pressable relative flex min-h-8 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-start text-body text-label-3 transition-colors duration-150 hover:text-label-2"
        >
          <Bug size={15} weight="bold" className="relative shrink-0" style={iconColors ? { color: hueVar("rose") } : undefined} />
          {/* Longer in some languages than the pages' names: it wraps rather than being cut. */}
          <span className="relative leading-tight">{t("Fehler melden")}</span>
        </button>
      </nav>
      {/* Ref on the stable container: popLayout doesn't pass refs to the child. */}
      <div ref={scroller} className="relative min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={searching ? "search" : page}
            className="absolute inset-0 flex flex-col gap-4 overflow-y-auto pb-6 [scrollbar-width:none]"
            style={{ maskImage: "linear-gradient(180deg, #000 calc(100% - 28px), transparent)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: content.enter }}
            exit={{ opacity: 0, transition: content.exit }}
          >
            {searching ? <SearchResults hits={results} onOpen={openHit} /> : <PageContent page={page} />}
          </motion.div>
        </AnimatePresence>
      </div>
      {searching && (
        // Every page, never shown: only read for the index. The LayoutGroup keeps their layoutIds apart from the visible ones.
        <div ref={hidden} hidden inert>
          <LayoutGroup id="settings-search">
            {pages.map((p) => (
              <div key={p.id} data-page={p.id}>
                <PageContent page={p.id} />
              </div>
            ))}
          </LayoutGroup>
        </div>
      )}
    </div>
  );
}

function SearchResults({ hits, onOpen }: { hits: Hit[]; onOpen: (h: Hit) => void }) {
  if (!hits.length) return <div className="px-3 pt-2 text-caption text-label-3">{t("Nichts gefunden")}</div>;
  return (
    <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-[12px] bg-fill-1">
      {hits.map((h) => {
        const pageName = t(pages.find((p) => p.id === h.page)!.label);
        return (
          <button
            key={`${h.page}|${h.groupId}|${h.label}`}
            onClick={() => onOpen(h)}
            className="flex min-h-9 flex-col items-stretch px-3 py-1.5 text-start outline-none hover:bg-fill-2 focus-visible:bg-fill-2"
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-body text-label">{h.label}</span>
              <span className="shrink-0 text-caption text-label-4">{[...new Set([pageName, h.group])].filter(Boolean).join(" · ")}</span>
            </span>
            {h.hint && <span className="text-caption text-label-3">{h.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** One settings page's groups; also rendered hidden for the search index. */
function PageContent({ page }: { page: PageId }) {
  return (
    <>
      {page === "general" && (
        <>
          <General />
          <Weather />
          <Updates />
          <Support />
        </>
      )}
      {page === "display" && (
        <>
          <Display />
          <MusicSettings />
          <Presentation />
        </>
      )}
      {page === "window" && <WindowSettings />}
      {page === "tools" && (
        <>
          <Tools />
          {!isMac && <SystemSettings />}
          {findTab("vault") && <VaultSettings />}
          <ProductivitySettings />
          {findTab("terminal") && <TerminalSettings />}
          {findTab("launcher") && <LauncherSettings />}
          <ClipboardSettings />
        </>
      )}
      {page === "timer" && (
        <>
          <Alarm />
          <FocusSoundSettings />
          <TimerLookSettings />
          <ClockLookSettings />
          <BreaksSettings />
        </>
      )}
      {page === "notices" && <NoticesSettings />}
      {page === "plugins" && <PluginSettings />}
      {page === "ai" && (
        <>
          <Ask />
          <UsageSettings />
          <KeysNote />
        </>
      )}
      {page === "accounts" && (
        <>
          {findTab("discord") && <Discord />}
          <TradingSettings />
          <GithubSettings />
          <CalendarSettings />
          <KeysNote />
        </>
      )}
      {page === "themes" && <ThemeSettings />}
    </>
  );
}

/** Version, update check and install on click. Nothing downloads unasked. */
function Updates() {
  const auto = settings.use().updates.auto;
  const u = update.use();
  const unseen = useUnseen();
  // Remember what was new when the section opened, so the labels stay while reading.
  const [fresh] = useState(() => new Set(unseen.map((e) => e.version)));
  const [showLog, setShowLog] = useState(false);
  const busy = u.phase === "checking" || u.phase === "downloading";
  const status = {
    idle: undefined,
    checking: t("Suche …"),
    current: t("Du hast die neueste Version"),
    available: u.installFailed ? t("Download fehlgeschlagen, später noch einmal versuchen") : t("Neue Version gefunden"),
    downloading: t("Wird geladen … {n} %", { n: Math.round(u.progress * 100) }),
    error: t("Prüfung fehlgeschlagen, später erneut versuchen"),
  }[u.phase];
  const upcoming = u.notes && u.version && u.current ? between(u.notes, u.current, u.version) : [];

  return (
    <Group title={t("Updates")} id="settings-updates">
      <Row label={t("Version {v}", { v: u.current ?? "–" })} hint={status}>
        {!u.store && (
          <Button disabled={busy} onClick={() => void checkForUpdate()}>
            {t("Jetzt suchen")}
          </Button>
        )}
      </Row>
      {u.store && <Row label={t("Updates kommen über den Microsoft Store")} />}
      <DiagnosticsRow />
      <PortableNote />
      <AnimatePresence initial={false}>
        {(u.phase === "available" || u.phase === "downloading") && u.version && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <Row label={t("Version {v} verfügbar", { v: u.version })} hint={t("Lädt, installiert und startet neu")}>
              {u.phase === "downloading" ? (
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-fill-2">
                  <div className="h-full origin-left rtl:origin-right rounded-full bg-label transition-transform duration-150 ease-linear" style={{ transform: `scaleX(${u.progress})` }} />
                </div>
              ) : (
                <Button primary onClick={() => void installUpdate()}>
                  {t("Jetzt aktualisieren")}
                </Button>
              )}
            </Row>
            {upcoming.length > 0 && <ChangelogList entries={upcoming} />}
          </motion.div>
        )}
      </AnimatePresence>
      <Row
        label={
          <span className="flex items-center gap-1.5">
            {t("Neuerungen")}
            {unseen.length > 0 && !showLog && <span className="size-[7px] rounded-full bg-link" />}
          </span>
        }
        hint={unseen.length > 0 ? t(unseen.length === 1 ? "Neu in Version {v}" : "{n} Versionen seit deinem letzten Update", { v: unseen[0].version, n: unseen.length }) : undefined}
      >
        <Button
          onClick={() => {
            if (!showLog) markSeen();
            setShowLog((v) => !v);
          }}
        >
          {showLog ? t("Ausblenden") : t("Anzeigen")}
        </Button>
      </Row>
      <AnimatePresence initial={false}>
        {showLog && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <ChangelogList entries={between(changelog, null, u.current ?? changelog[0].version)} fresh={fresh} />
          </motion.div>
        )}
      </AnimatePresence>
      {!u.store && (
        <Row label={t("Automatisch suchen")} hint={t("Einmal täglich, anonym bei GitHub, ohne deine Daten")}>
          <Switch label={t("Automatisch suchen")} checked={auto} onChange={(on) => updateSettings({ updates: { auto: on } })} />
        </Row>
      )}
    </Group>
  );
}

/** Copies a plain-text block for bug reports (diagnostics.ts): versions, Windows, monitors, settings and error codes only. */
function DiagnosticsRow() {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const copy = async () => {
    const s = settings.get();
    const u = update.get();
    try {
      const [sys, info, port] = await Promise.all([systemDiagnostics(), build.info(), portable.info()]);
      const text = diagnosticsText({
        version: u.current ?? "unknown",
        build: info.store ? "store" : port.portable ? "portable" : "installer",
        os: sys.os,
        osBuild: sys.build,
        arch: sys.arch,
        machine: sys.machine,
        scales: sys.scales,
        panelScale: s.behavior.scale,
        tools: s.tools.filter((x) => x.enabled).map((x) => x.id),
        closedStyle: s.display.idleStyle,
        edge: s.dock.edge,
        anchor: s.dock.anchor,
        errors: [
          ["update", u.phase === "error" ? "check-failed" : null],
          ["github", github.get().error],
          ["fps", fps.get().error],
          ["discord", discordState.get().error],
        ],
      });
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 1600);
  };
  const hint =
    copied === "ok"
      ? t("Kopiert")
      : copied === "failed"
        ? t("Kopieren fehlgeschlagen")
        : t("Version, Windows, Bildschirme und Einstellungen für einen Fehlerbericht, ohne persönliche Daten");
  return (
    <Row label={t("Diagnose kopieren")} hint={hint}>
      <Button onClick={() => void copy()}>{t("Kopieren")}</Button>
    </Row>
  );
}

function Support() {
  const { store } = update.use();
  return (
    <Group title={t("Unterstützen")} id="settings-support">
      <Row label={t("Crest unterstützen")} hint={t("Kostenlos und ohne Werbung. Spenden über GitHub Sponsors sind freiwillig")}>
        <Button onClick={openSponsors}>{t("Sponsern")}</Button>
      </Row>
      {store && (
        <Row label={t("Crest bewerten")} hint={t("Eine Bewertung im Microsoft Store hilft anderen, Crest zu finden")}>
          <Button onClick={openStoreReview}>{t("Bewerten")}</Button>
        </Row>
      )}
    </Group>
  );
}

/** Versions with their short notes; `fresh` marks the ones new since your last update. */
function KeysNote() {
  return (
    <div className="flex items-start gap-1.5 px-3 pb-1 text-caption text-label-4">
      <LockSimple size={11} weight="bold" className="mt-0.5 shrink-0" />
      {isMac ? t("Schlüssel liegen im Schlüsselbund von macOS. Alles bleibt auf diesem Mac.") : t("Schlüssel liegen in der Windows-Anmeldeinformationsverwaltung. Alles bleibt auf diesem PC.")}
    </div>
  );
}

function Ask() {
  const s = settings.use();
  return (
    <Group title={t("AI-Chat")} id="settings-ask">
      <Row label={t("Anbieter")}>
        <Segmented<AskProvider>
          id="ask-provider"
          size="sm"
          value={s.ask.provider}
          onChange={(provider) => updateSettings({ ask: { ...s.ask, provider } })}
          options={(Object.keys(providerInfo) as AskProvider[]).map((p) => ({ value: p, label: t(providerInfo[p].label) }))}
        />
      </Row>
      {s.ask.provider === "custom" && (
        <Row label={t("Base-URL")} hint={t("OpenAI-kompatibel, endet meist auf /v1")}>
          <TextField
            value={s.ask.configs.custom.baseUrl}
            onChange={(baseUrl) => updateAsk("custom", { baseUrl: baseUrl.trim() })}
            placeholder="https://…/v1"
            width="w-52"
          />
        </Row>
      )}
      <SecretRow name={`ai.${s.ask.provider}` as SecretName} label={t("API-Schlüssel")} />
      <Row label={t("Modell")} hint={s.ask.provider === "openrouter" ? t("Modell-ID von openrouter.ai/models") : undefined}>
        <TextField
          value={s.ask.configs[s.ask.provider].model}
          onChange={(model) => updateAsk(s.ask.provider, { model: model.trim() })}
          placeholder={t(providerInfo[s.ask.provider].modelHint)}
          width="w-52"
        />
      </Row>
      <Row label={t("Denkaufwand")} hint={t("Wie gründlich das Modell nachdenkt")}>
        <Segmented
          id="ask-effort-settings"
          size="sm"
          value={s.ask.configs[s.ask.provider].effort}
          onChange={(effort) => updateAsk(s.ask.provider, { effort })}
          options={effortLevels.map((e) => ({ ...e, label: t(e.label) }))}
        />
      </Row>
    </Group>
  );
}

/** Open on hover or click, and the hover delay (also in the first-run setup). */
export function OpenRows() {
  const s = settings.use();
  // The tools in the tool bar, by name: the notch opens on the one picked here unless something else decides (src/notch/Notch.tsx).
  const starts = [
    { value: "", label: t("Zuletzt genutzt") },
    ...s.tools.filter((tool) => tool.enabled).flatMap((tool) => {
      const tab = findTab(tool.id);
      return tab ? [{ value: tool.id, label: t(tab.label) }] : [];
    }),
  ];
  return (
    <>
      <Row label={t("Öffnet auf")}>
        <Select width="w-44" value={starts.some((o) => o.value === s.startTab) ? s.startTab : ""} onChange={(startTab) => updateSettings({ startTab })} options={starts} />
      </Row>
      <Row label={t("Öffnen")}>
        <Segmented
          id="open-mode"
          size="sm"
          value={s.openMode}
          onChange={(openMode) => updateSettings({ openMode })}
          options={[
            { value: "hover", label: t("Hover") },
            { value: "click", label: t("Klick") },
          ]}
        />
      </Row>
      <AnimatePresence initial={false}>
        {s.openMode === "hover" && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <Row label={t("Hover-Verzögerung")}>
              <Segmented
                id="hover-delay"
                size="sm"
                value={s.hoverDelay}
                onChange={(hoverDelay) => updateSettings({ hoverDelay })}
                options={[
                  { value: "fast", label: t("Schnell") },
                  { value: "normal", label: t("Normal") },
                  { value: "patient", label: t("Geduldig") },
                ]}
              />
            </Row>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** The open shortcut as keycaps, with a warning when another program holds it. */
export function ShortcutRow() {
  const keys = settings.use().behavior.hotkeys.open;
  const openKey = hotkeyStatus.use().open;
  return (
    <Row
      label={t("Tastenkürzel")}
      hint={
        !keys ? (
          t("Nicht gesetzt; festlegen unter Fenster")
        ) : openKey === "in-use" ? (
          <span className="text-orange">{t("Ein anderes Programm nutzt diese Kombination, sie ist nicht aktiv; ändern unter Fenster")}</span>
        ) : (
          t("Öffnet und schließt die Notch von überall; ändern unter Fenster")
        )
      }
    >
      {/* Key combinations read left to right in any language. */}
      <span dir="ltr" className="flex items-center gap-1 text-caption text-label-2">
        <Keyboard size={13} weight="bold" className="text-label-3" />
        {keys ? (
          keycaps(keys).map(keyText).map((k) => (
            <kbd key={k} className="rounded-[5px] bg-fill-2 px-1.5 py-0.5 font-sans text-caption">{k}</kbd>
          ))
        ) : (
          t("Nicht gesetzt")
        )}
      </span>
    </Row>
  );
}

function General() {
  const s = settings.use();
  const [auto, setAuto] = useState<boolean | null>(null);
  const autostartLabel = isMac ? t("Bei der Anmeldung öffnen") : t("Mit Windows starten");
  const [autoError, setAutoError] = useState<string | null>(null);
  useEffect(() => {
    void autostart.get().then(setAuto);
  }, []);

  return (
    <Group>
      <Row label={t("Sprache")}>
        <Select<LanguageSetting>
          width="w-40"
          value={s.lang}
          onChange={(lang) => updateSettings({ lang })}
          options={[{ value: "system", label: t("Systemsprache") }, ...LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] }))]}
        />
      </Row>
      <Row label={t("Uhrzeit")}>
        <Segmented
          id="clock-format"
          size="sm"
          value={s.units.clock}
          onChange={(clock) => updateSettings((p) => ({ units: { ...p.units, clock } }))}
          options={[
            { value: "24", label: t("24 Std.") },
            { value: "12", label: t("12 Std.") },
          ]}
        />
      </Row>
      <OpenRows />
      <Row label={t("Schließen-Verzögerung")} hint={t("Wie lange die Notch offen bleibt, nachdem der Zeiger sie verlassen hat")}>
        <Segmented
          id="close-delay"
          size="sm"
          value={s.behavior.closeDelay}
          onChange={(closeDelay) => updateSettings((cur) => ({ behavior: { ...cur.behavior, closeDelay } }))}
          options={[
            { value: "fast", label: t("Schnell") },
            { value: "normal", label: t("Normal") },
            { value: "patient", label: t("Geduldig") },
          ]}
        />
      </Row>
      <Row label={autostartLabel} hint={autoError ?? undefined}>
        {auto !== null && (
          <Switch
            label={autostartLabel}
            checked={auto}
            onChange={(v) => {
              setAuto(v);
              setAutoError(null);
              // Windows can refuse (the Store build's startup task switched off in Task Manager): say so and show the real state.
              autostart.set(v).catch((e) => {
                setAutoError(tBackend(String(e)));
                void autostart.get().then(setAuto);
              });
            }}
          />
        )}
      </Row>
      <ShortcutRow />
      <Row label={t("Einrichtung")} hint={t("Voreinstellung, Aussehen und Öffnen noch einmal wählen")}>
        <Button onClick={() => navigate(setupTab.id)}>{t("Erneut starten")}</Button>
      </Row>
    </Group>
  );
}

const statusAlerts: [keyof ClosedSettings["statusAlerts"], string, string][] = [
  ["power", "Ladegerät und Akku", "Beim Ein- und Ausstecken, Akku bei 20 und 10 %"],
  ["net", "Netzwerk", "Wenn das Internet wegfällt und zurückkommt"],
  ["bt", "Bluetooth-Geräte", "Beim Verbinden oder Trennen, mit Akku, wenn das Gerät ihn meldet"],
  ["volume", "Lautstärke", "Mit Pegel, wenn sich die Lautstärke oder Stummschaltung ändert"],
  ["brightness", "Helligkeit", "Eingebauter Bildschirm sofort, externe Monitore über DDC/CI alle 2 Sekunden"],
  ["lock", "Feststell- und Num-Taste", "Wenn die Feststelltaste oder die Num-Taste umgeschaltet wird"],
  ["mic", "Mikrofon", "Wenn das Tastenkürzel das Mikrofon stumm- oder wieder einschaltet"],
  ["hideOsd", "Windows-Anzeige ausblenden", "Blendet die Lautstärke- und Helligkeitsanzeige von Windows aus, solange Crest läuft; braucht Lautstärke und Helligkeit"],
];

/** Where and when the notch shows up. */
function Display() {
  const s = settings.use();
  const d = s.display;
  const focus = focusMode.use();
  const fpsError = fps.use().error;
  // The unlock row shows once the counter has answered "no-admin", so ask while gaming mode is on, not only when a game is up.
  useFpsPolling(!isMac && s.gaming.mode !== "off");
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    void display.monitors().then(setMonitors);
  }, []);
  const label = (m: MonitorInfo, i: number) => `${m.primary ? t("Hauptbildschirm") : t("Bildschirm {n}", { n: i + 1 })} · ${m.width}×${m.height}`;

  return (
    <Group id="settings-display">
      {/* Also with one monitor while "follow" or "all" is saved (a laptop undocked), or it could not be changed back. */}
      {(monitors.length > 1 || d.monitorMode !== "chosen") && (
        <Row
          label={t("Monitor")}
          hint={d.monitorMode === "follow" ? t("Geschlossen wandert die Notch auf den Bildschirm mit dem Mauszeiger") : d.monitorMode === "all" ? t("Eine geschlossene Notch auf jedem Bildschirm; sie öffnet sich dort, wo du sie berührst") : undefined}
        >
          <Select
            width="w-56"
            value={d.monitorMode !== "chosen" ? d.monitorMode : (d.monitor ?? monitors.find((m) => m.primary)?.name ?? monitors[0].name)}
            onChange={(value) =>
              updateSettings((cur) => ({
                display:
                  value === "follow" || value === "all"
                    ? { ...cur.display, monitorMode: value }
                    : { ...cur.display, monitorMode: "chosen", monitor: monitors.find((m) => m.name === value)?.primary ? null : value },
              }))
            }
            options={[
              ...(isMac ? [] : [{ value: "follow", label: t("Dem Mauszeiger folgen") }, { value: "all", label: t("Alle Monitore") }]),
              ...monitors.map((m, i) => ({ value: m.name, label: label(m, i) })),
            ]}
          />
        </Row>
      )}
      <EdgeSettings />
      {(d.offset !== 0 || d.y !== 5) && (
        <Row label={t("Position")} hint={t("Notch an der Kopfzeile oder geschlossen ziehen, um sie zu verschieben")}>
          <Button onClick={() => updateSettings((cur) => ({ display: { ...cur.display, offset: 0, y: 5 } }))}>
            <span className="flex items-center gap-1.5">
              <ArrowsInLineHorizontal size={13} weight="bold" /> {t("Zur Mitte")}
            </span>
          </Button>
        </Row>
      )}
      <ClosedStyle />
      <SizeSettings />
      <ClosedParts />
      {d.idleStyle !== "line" && <PetSettingsRows />}
      <Row label={t("Fortschritt auf der Linie")} hint={t("Zeigt, wie weit das Lied ist, solange Musik läuft")}>
        <Switch label={t("Fortschritt auf der Linie")} checked={s.closed.lineProgress} onChange={(lineProgress) => updateSettings((cur) => ({ closed: { ...cur.closed, lineProgress } }))} />
      </Row>
      <Row label={t("Hinweis bei Kontingent 70 und 90 %")} hint={t("Braucht den Teil AI-Nutzung")}>
        <Switch label={t("Hinweis bei Kontingent 70 und 90 %")} checked={s.closed.quotaAlerts} onChange={(quotaAlerts) => updateSettings((cur) => ({ closed: { ...cur.closed, quotaAlerts } }))} />
      </Row>
      {/* The download watcher and the status events (power, network, Bluetooth, volume, brightness, lock keys) have no Mac backend. */}
      {!isMac && (
        <>
          <Row label={t("Hinweis bei fertigem Download")} hint={t("Mit Im Ordner zeigen und Zur Ablage, nicht in den Ruhezeiten")}>
            <Switch label={t("Hinweis bei fertigem Download")} checked={s.closed.downloadAlerts} onChange={(downloadAlerts) => updateSettings((cur) => ({ closed: { ...cur.closed, downloadAlerts } }))} />
          </Row>
          <Row label={t("Statusmeldungen")} />
          {statusAlerts.map(([k, label, hint]) => (
            <Row key={k} label={t(label)} hint={t(hint)}>
              <Switch label={t(label)} checked={s.closed.statusAlerts[k]} onChange={(v) => updateSettings((cur) => ({ closed: { ...cur.closed, statusAlerts: { ...cur.closed.statusAlerts, [k]: v } } }))} />
            </Row>
          ))}
        </>
      )}
      <Row label={t("Fokus-Modus")} hint={t("Klicks gehen durch. 3× schnell auf die Notch klicken schaltet um, oder im Tray-Menü.")}>
        <Switch label={t("Fokus-Modus")} checked={focus} onChange={setFocusMode} />
      </Row>
      <Row
        label={t("Fokus-Darstellung")}
        hint={d.focusStyle === "line" ? t("Nur eine dünne Linie am Rand, ohne Musik und Co.") : t("Halb durchsichtig, Musik und Co. bleiben sichtbar")}
      >
        <Segmented
          id="focus-style"
          size="sm"
          value={d.focusStyle}
          onChange={(focusStyle) => updateSettings((cur) => ({ display: { ...cur.display, focusStyle } }))}
          options={[
            { value: "dim", label: t("Durchsichtig") },
            { value: "line", label: t("Linie") },
          ]}
        />
      </Row>
      {/* Hardware readings and FPS have no Mac backend yet. */}
      {!isMac && (
        <>
          <Row
            label={t("Gaming-Modus")}
            hint={t("FPS und Auslastung in der geschlossenen Notch")}
          >
            <Segmented
              id="gaming-mode"
              size="sm"
              value={s.gaming.mode}
              onChange={(mode) => updateSettings({ gaming: { mode } })}
              options={[
                { value: "off", label: t("Aus") },
                { value: "fullscreen", label: t("Bei Vollbild") },
                { value: "on", label: t("Immer") },
              ]}
            />
          </Row>
          {fpsError === "no-admin" && <FpsUnlockRow />}
          {fpsError === "relogin" && (
            <Row label={t("FPS freischalten")} hint={t("Fertig: einmal ab- und wieder anmelden, dann laufen die FPS")}>
              <SignOut size={18} weight="bold" className="text-orange" />
            </Row>
          )}
        </>
      )}
      {/* macOS shows its own recording dots, and Crest cannot read the state there. */}
      {!isMac && (
        <Row label={t("Aufnahme-Punkte")} hint={t("Grün: Mikrofon/Kamera aktiv · Rot: Bildschirm wird aufgenommen")}>
          <Switch label={t("Aufnahme-Punkte")} checked={s.privacyDots} onChange={(privacyDots) => updateSettings({ privacyDots })} />
        </Row>
      )}
    </Group>
  );
}

/** Closed look: notch, capsule or line, with previews (also in the first-run setup). */
export function ClosedStyle() {
  const style = settings.use().display.idleStyle;
  return (
    <div className="pb-3">
      <Row
        label={t("Geschlossen")}
        hint={
          style === "line"
            ? t("Nur eine dünne Linie, ein abgelaufener Timer klappt trotzdem auf")
            : style === "capsule"
              ? t("Schwebt frei, zum Verschieben ziehen")
              : t("Die Notch zeigt Musik, Timer und Co.")
        }
      />
      <div className="px-3">
        <StyleCards
          label={t("Geschlossen")}
          value={style}
          onChange={(idleStyle) => updateSettings((cur) => ({ display: { ...cur.display, idleStyle } }))}
          options={[
            { value: "notch", label: t("Notch"), preview: <ShapePreview d="M6 0H54C51 0 50 1.5 50 4V8C50 11 48 13 45 13H15C12 13 10 11 10 8V4C10 1.5 9 0 6 0Z" /> },
            { value: "capsule", label: t("Kapsel"), preview: <ShapePreview d="M16.5 4H43.5A4.5 4.5 0 0 1 43.5 13H16.5A4.5 4.5 0 0 1 16.5 4Z" /> },
            { value: "line", label: t("Linie"), preview: <ShapePreview d="M15 0H45A1 1 0 0 1 45 2H15A1 1 0 0 1 15 0Z" /> },
          ]}
        />
      </div>
    </div>
  );
}

/** Miniature of a closed shape hanging from the screen's top edge (viewBox 60 × 16). */
function ShapePreview({ d }: { d: string }) {
  return (
    <svg width={90} height={24} viewBox="0 0 60 16" aria-hidden>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

const partInfo: Record<PartId, { label: string; icon: Icon; hue: Hue }> = {
  timer: { label: "Timer", icon: Timer, hue: "orange" },
  discord: { label: "Discord", icon: DiscordLogo, hue: "indigo" },
  rings: { label: "AI-Nutzung", icon: ChartDonut, hue: "purple" },
  title: { label: "Songtitel", icon: MusicNote, hue: "pink" },
  readings: { label: "Auslastung", icon: Cpu, hue: "red" },
  equalizer: { label: "Equalizer", icon: Waveform, hue: "pink" },
  clock: { label: "Uhrzeit", icon: Clock, hue: "blue" },
  github: { label: "GitHub heute", icon: GithubLogo, hue: "violet" },
  calendar: { label: "Nächster Termin", icon: CalendarBlank, hue: "red" },
  script: { label: "Skript-Anzeigen (crest-notify)", icon: TerminalWindow, hue: "slate" },
  downloads: { label: "Downloads", icon: DownloadSimple, hue: "teal" },
  weather: { label: "Wetter", icon: CloudSun, hue: "sky" },
};

/** Small labelled switch for a part's own options, next to its main switch. */
function SubSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="flex items-center gap-1.5 text-caption text-label-3 select-none">
      {label}
      <Switch label={label} checked={checked} onChange={onChange} />
    </span>
  );
}

/** The nest beside the closed notch: which pet (or none), its size, independent of the notch's, and the side it sits on. */
function PetSettingsRows() {
  const { closed: { pet }, dock } = settings.use();
  const setPet = (patch: Partial<ClosedSettings["pet"]>) => updateSettings((cur) => ({ closed: { ...cur.closed, pet: { ...cur.closed.pet, ...patch } } }));
  return (
    <>
      <Row
        label={t("Haustier")}
        hint={isMac ? t("Neben der Notch: tanzt zur Musik, freut sich über Erledigtes und schläft, wenn nichts los ist") : t("Neben der Notch: tanzt zur Musik, rennt mit der CPU, freut sich über Erledigtes und schläft, wenn nichts los ist")}
      >
        <div className="flex items-center gap-2">
          {pet.id && <PetArt id={pet.id} mood="idle" pace=".5s" size={30} />}
          <Select
            value={pet.id ?? "none"}
            width="w-48"
            options={[{ value: "none", label: t("Aus") }, ...PET_IDS.map((p) => ({ value: p, label: t(PET_NAMES[p]) }))]}
            onChange={(v) => setPet({ id: v === "none" ? null : (v as PetId) })}
          />
        </div>
      </Row>
      {pet.id && (
        <>
          <Row label={t("Größe des Haustiers")} hint={t("Unabhängig von der Größe der Notch")}>
            <div className="flex w-52 items-center gap-2">
              <Slider label={t("Größe des Haustiers")} value={pet.size} min={PET_SIZE.min} max={PET_SIZE.max} step={2} onChange={(size) => setPet({ size })} />
              <span className="tabular w-8 text-end text-caption text-label-2">{pet.size}</span>
            </div>
          </Row>
          <Row label={t("Seite")}>
            <Segmented id="pet-side" size="sm" value={pet.side} options={across(dock.edge) ? [{ value: "left", label: t("Oben") }, { value: "right", label: t("Unten") }] : [{ value: "left", label: t("Linke Seite") }, { value: "right", label: t("Rechte Seite") }]} onChange={(side) => setPet({ side })} />
          </Row>
        </>
      )}
    </>
  );
}

/** Closed-row parts fed by Windows-only code (hardware readings, the Discord tool, the download watcher). */
const NO_MAC_PARTS = new Set<PartId>(["readings", "discord", "downloads"]);

/** Parts of the closed row (notch and capsule share them): drag to reorder, switch on/off. Same pattern as `Tools()`. */
function ClosedParts() {
  const { closed: c, music, tools, notices, github } = settings.use();
  const [dragging, setDragging] = useState<PartId | null>(null);
  const setClosed = (patch: (cur: ClosedSettings) => Partial<ClosedSettings>) => updateSettings((cur) => ({ closed: { ...cur.closed, ...patch(cur.closed) } }));
  // Only these always show; battery, power and temperature can be missing, so they cannot keep the part alone. The network
  // counts too, so the part can show only the download and upload speed (issue #11).
  const mainReadings = ["cpu", "ram", "gpu", "net"] as const;
  const shown = c.order.filter((id) => !(isMac && NO_MAC_PARTS.has(id)));
  const readingsOn = mainReadings.filter((k) => c.readings[k]).length;
  const iconColors = useIconColors();
  // What a part shows nothing without; the part itself says so while it is on.
  const needs: Partial<Record<PartId, string | false>> = {
    calendar: !tools.some((x) => x.id === "calendar" && x.enabled) && t("Braucht das Tool Kalender"),
    script: !(notices.enabled && notices.cli) && t("Braucht Live-Mitteilungen und crest-notify"),
    github: !github.user.trim() && t("Braucht deinen GitHub-Namen"),
  };

  return (
    <div>
      <Row label={t("Inhalt")} hint={t("Gilt für Notch und Kapsel, zum Sortieren ziehen")} />
      {/* Parts a Mac does not show keep their place at the end of the order. */}
      <Reorder.Group
        as="div"
        axis="y"
        values={shown}
        onReorder={(order: PartId[]) => setClosed((cur) => ({ order: [...order, ...cur.order.filter((id) => !order.includes(id))] }))}
        className="divide-y divide-separator"
      >
        {shown.map((id) => {
          const { label, icon: I, hue } = partInfo[id];
          const on = c.parts[id];
          return (
            <Reorder.Item
              key={id}
              value={id}
              as="div"
              transition={springs.snappy}
              onDragStart={() => setDragging(id)}
              onDragEnd={() => setDragging(null)}
              whileDrag={{ scale: 1.02 }}
              className={`group relative flex h-9 cursor-grab items-center gap-2.5 px-3 active:cursor-grabbing ${
                dragging === id ? "z-10 rounded-[10px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)]" : ""
              }`}
            >
              <DotsSixVertical size={13} weight="bold" className="-ms-1 text-label-4 transition-colors group-hover:text-label-3" />
              <I size={15} weight="bold" className={on && iconColors ? "" : on ? "text-label-2" : "text-label-4"} style={on && iconColors ? { color: hueVar(hue) } : undefined} />
              <span className={`flex-1 text-body select-none ${on ? "text-label" : "text-label-3"}`}>
                {t(label)}
                {on && needs[id] && <span className="ms-2 text-caption text-label-3">{needs[id]}</span>}
              </span>
              <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-3">
                {on && id === "readings" &&
                  mainReadings.map((k) => (
                    <SubSwitch
                      key={k}
                      label={k.toUpperCase()}
                      checked={c.readings[k]}
                      // One reading stays on, otherwise the part would be empty.
                      onChange={(v) => (v || readingsOn > 1) && setClosed((cur) => ({ readings: { ...cur.readings, [k]: v } }))}
                    />
                  ))}
                {on && id === "clock" && <SubSwitch label={t("Sekunden")} checked={c.clockSeconds} onChange={(clockSeconds) => setClosed(() => ({ clockSeconds }))} />}
                {on && id === "title" && <SubSwitch label={t("Songtext")} checked={music.titleLyrics} onChange={(titleLyrics) => setMusic({ titleLyrics })} />}
                <Switch label={t(label)} checked={on} onChange={(v) => setClosed((cur) => ({ parts: { ...cur.parts, [id]: v } }))} />
              </div>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
    </div>
  );
}

/** Presentation mode: one switch, plus automatic while the screen is recorded or shared. */
function Presentation() {
  const { manual, auto } = settings.use().presentation;
  const presenting = usePresenting();
  const recording = privacy.use().screen;
  return (
    <Group title={t("Präsentationsmodus")} id="settings-presentation">
      <Row
        label={t("Präsentationsmodus")}
        hint={presenting && !manual ? t("Aktiv, Bildschirmaufnahme erkannt") : t("Blendet Zwischenablage, Kontostände, Tresor, Aufnahmen und Ablage aus")}
      >
        <Switch label={t("Präsentationsmodus")} checked={presenting} onChange={togglePresentation} />
      </Row>
      {!isMac && (
        <Row label={t("Bei Bildschirmaufnahme")} hint={t("Teams, Discord, OBS … schaltet sich danach wieder ab")}>
          <Switch
            label={t("Bei Bildschirmaufnahme")}
            checked={auto}
            onChange={(on) => updateSettings((cur) => ({ presentation: { ...cur.presentation, auto: on } }))}
          />
        </Row>
      )}
      {auto && recording && !presenting && (
        <Row label={t("Für diese Aufnahme aus")} hint={t("Schaltet sich bei der nächsten wieder ein")} />
      )}
      <HideFromSharingRow />
    </Group>
  );
}

const discordStatus: Record<string, string> = {
  off: "Aus, Tool „Discord“ einschalten",
  "no-config": "Client-ID und Secret fehlen",
  "no-client": "Discord läuft nicht",
  connecting: "Verbinde …",
  authorizing: "In Discord bestätigen",
  ready: "Verbunden",
  error: "Fehler",
};

/** Discord call: your own app in the developer portal (the only way Discord grants voice scopes). */
function Discord() {
  const s = settings.use();
  const state = discordState.use();
  const [id, setId] = useState(s.discord.clientId);
  const save = () => updateSettings({ discord: { clientId: id.trim() } });
  return (
    <Group title="Discord" id="settings-discord">
      <Row label={t("Status")} hint={state.error ? tBackend(state.error) : undefined}>
        <span className={`text-caption ${state.status === "ready" ? "text-green" : "text-label-2"}`}>{t(discordStatus[state.status] ?? state.status)}</span>
      </Row>
      <Row label={t("Client-ID")}>
        <div className="flex items-center gap-1.5">
          <TextField value={id} onChange={setId} onSubmit={save} placeholder="123456789012345678" width="w-40" />
          {id.trim() !== s.discord.clientId && <Button onClick={save}>{t("Sichern")}</Button>}
        </div>
      </Row>
      <SecretRow name="discord.secret" label={t("Client-Secret")} onSaved={reconnectDiscord} />
      <div className="px-3 py-2 text-caption text-label-3">
        {t("discord.com/developers → New Application → OAuth2: Client-ID und Client-Secret kopieren und unter Redirects http://localhost eintragen und speichern. Beim ersten Verbinden fragt Discord einmal nach.")}
      </div>
    </Group>
  );
}

const durations: { value: string; label: string }[] = [
  { value: "0", label: "1×" },
  { value: "5", label: "{n} s" },
  { value: "15", label: "{n} s" },
  { value: "30", label: "{n} s" },
  { value: "-1", label: "Bis Stopp" },
];

/** Timer alarm: sound, volume, duration, with preview. */
function Alarm() {
  const a = settings.use().alarm;
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  // Only this preview's own stop: the timer's real alarm shares the global one.
  const stopPreview = useRef<(() => void) | null>(null);
  const set = (patch: Partial<typeof a>) => updateSettings((cur) => ({ alarm: { ...cur.alarm, ...patch } }));

  const preview = (next = a) => {
    window.clearTimeout(timer.current);
    stopPreview.current = playAlarm(next.sound, next.volume, 0);
    setPreviewing(true);
    timer.current = window.setTimeout(() => setPreviewing(false), 2500);
  };
  useEffect(() => () => stopPreview.current?.(), []);

  return (
    <Group id="settings-alarm">
      <Row label={t("Alarm-Ton")}>
        <div className="flex items-center gap-1.5">
          <button
            aria-label={previewing ? t("Stopp") : t("Probehören")}
            title={previewing ? t("Stopp") : t("Probehören")}
            onClick={() => {
              if (!previewing) return preview();
              stopPreview.current?.();
              setPreviewing(false);
            }}
            className="pressable pressable-fill flex size-7 items-center justify-center rounded-full bg-fill-2 text-label"
          >
            {previewing ? <Stop size={11} weight="fill" /> : <Play size={11} weight="fill" />}
          </button>
          <Select
            width="w-36"
            value={a.sound}
            onChange={(sound) => {
              set({ sound });
              preview({ ...a, sound });
            }}
            options={alarmSounds.map((o) => ({ ...o, label: t(o.label) }))}
          />
        </div>
      </Row>
      <Row label={t("Lautstärke")}>
        <div className="flex w-52 items-center gap-2">
          <Slider label={t("Lautstärke")} value={Math.round(a.volume * 100)} min={5} max={100} step={5} onChange={(v) => set({ volume: v / 100 })} />
          <span className="tabular w-8 text-end text-caption text-label-2">{Math.round(a.volume * 100)}</span>
        </div>
      </Row>
      <Row label={t("Dauer")} hint={t("Wie lange der Alarm klingelt")}>
        <Segmented id="alarm-duration" size="sm" value={String(a.duration)} onChange={(v) => set({ duration: Number(v) as AlarmDuration })} options={durations.map((o) => ({ ...o, label: t(o.label, { n: o.value }) }))} />
      </Row>
    </Group>
  );
}

/** Timer: background sound while a focus timer runs, and its volume. */
function FocusSoundSettings() {
  const { focusSound, focusVolume } = settings.use().timer;
  const set = (patch: Partial<{ focusSound: FocusSound; focusVolume: number }>) => updateSettings((cur) => ({ timer: { ...cur.timer, ...patch } }));
  return (
    <Group id="settings-focus-sound">
      <Row label={t("Fokus-Klang")} hint={t("Spielt, solange ein Fokus-Timer läuft")}>
        <Select width="w-44" value={focusSound} onChange={(v) => set({ focusSound: v })} options={focusSounds.map((o) => ({ ...o, label: t(o.label) }))} />
      </Row>
      <Row label={t("Lautstärke")}>
        <div className="flex w-52 items-center gap-2">
          <Slider label={t("Lautstärke")} value={Math.round(focusVolume * 100)} min={5} max={100} step={5} onChange={(v) => set({ focusVolume: v / 100 })} />
          <span className="tabular w-8 text-end text-caption text-label-2">{Math.round(focusVolume * 100)}</span>
        </div>
      </Row>
    </Group>
  );
}

/** FPS without admin: unlock once instead of running the notch as administrator every time. */
function FpsUnlockRow() {
  const [state, setState] = useState<"idle" | "busy" | "ok" | "relogin" | "cancelled" | "failed">("idle");
  const hint = {
    idle: t("Einmalige Windows-Abfrage, danach nie wieder Administratorrechte"),
    busy: t("Bitte die Windows-Abfrage bestätigen …"),
    ok: t("Freigeschaltet, die FPS laufen"),
    relogin: t("Fertig: einmal ab- und wieder anmelden, dann laufen die FPS"),
    cancelled: t("Abgebrochen"),
    failed: t("Hat nicht geklappt, Crest einmal als Administrator starten"),
  }[state];
  return (
    <Row label={t("FPS freischalten")} hint={hint}>
      {state === "ok" || state === "relogin" ? (
        <CheckCircle size={18} weight="fill" className="text-green" />
      ) : (
        <Button
          disabled={state === "busy"}
          onClick={() => {
            setState("busy");
            void unlockFps().then(setState);
          }}
        >
          {t("Freischalten")}
        </Button>
      )}
    </Row>
  );
}

/** Weather location: automatic via IP or fixed, right here without opening the weather tool. */
function Weather() {
  const { weather: w, units } = settings.use();
  const [searching, setSearching] = useState(false);
  return (
    <Group title={t("Wetter")} id="settings-weather">
      <Row label={t("Standort")} hint={w?.auto ? t("Ungefähr, aus deiner IP-Adresse") : undefined}>
        <Segmented<"auto" | "manual">
          id="weather-mode"
          size="sm"
          value={!w || w.auto ? "auto" : "manual"}
          onChange={(m) => {
            if (m === "auto") {
              setSearching(false);
              void detectPlace(true);
            } else setSearching(true);
          }}
          options={[
            { value: "auto", label: t("Automatisch") },
            { value: "manual", label: t("Manuell") },
          ]}
        />
      </Row>
      <Row label={t("Einheit")}>
        <Segmented
          id="temp-unit"
          size="sm"
          value={units.temp}
          onChange={(temp) => updateSettings((p) => ({ units: { ...p.units, temp } }))}
          options={[
            { value: "c", label: "°C" },
            { value: "f", label: "°F" },
          ]}
        />
      </Row>
      <Row label={t("Ort")}>
        <Button onClick={() => setSearching((v) => !v)}>{w?.name ?? t("Wird erkannt …")}</Button>
      </Row>
      <AnimatePresence initial={false}>
        {searching && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <div className="p-2">
              <PlaceSearch compact canCancel onDone={() => setSearching(false)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Group>
  );
}

/** Show/hide tools and drag to reorder. At least one stays on. */
function Tools() {
  const s = settings.use();
  // Plugin tools are listed once their list has been read.
  plugins.use();
  // Only tools this platform lists count: one hidden on a Mac cannot be the one that stays on.
  const enabledCount = s.tools.filter((x) => x.enabled && findTab(x.id)).length;
  const [dragging, setDragging] = useState<string | null>(null);

  return (
    <Group>
      <Reorder.Group
        as="div"
        axis="y"
        values={s.tools.map((x) => x.id)}
        onReorder={(ids: string[]) => updateSettings((cur) => ({ tools: ids.map((id) => cur.tools.find((x) => x.id === id)!) }))}
        className="divide-y divide-separator"
      >
        {s.tools.map((tool) => {
          const tab = findTab(tool.id);
          if (!tab) return null;
          return (
            <Reorder.Item
              key={tool.id}
              value={tool.id}
              as="div"
              transition={springs.snappy}
              onDragStart={() => setDragging(tool.id)}
              onDragEnd={() => setDragging(null)}
              whileDrag={{ scale: 1.02 }}
              className={`group relative flex h-9 cursor-grab items-center gap-2.5 px-3 active:cursor-grabbing ${
                dragging === tool.id ? "z-10 rounded-[10px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)]" : ""
              }`}
            >
              <DotsSixVertical size={13} weight="bold" className="-ms-1 text-label-4 transition-colors group-hover:text-label-3" />
              <tab.icon size={15} weight="bold" className={tool.enabled ? "text-label-2" : "text-label-4"} />
              <span className={`flex-1 text-body select-none ${tool.enabled ? "text-label" : "text-label-3"}`}>{t(tab.label)}</span>
              <div onPointerDown={(e) => e.stopPropagation()}>
                <Switch
                  label={t(tab.label)}
                  checked={tool.enabled}
                  onChange={(enabled) => {
                    if (!enabled && enabledCount <= 1) return;
                    updateSettings((cur) => ({ tools: cur.tools.map((x) => (x.id === tool.id ? { ...x, enabled } : x)) }));
                  }}
                />
              </div>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
    </Group>
  );
}

/**
 * Field for a key. Stored values are never read back, it only shows
 * "saved ✓". Typing a new one overwrites it, saving empty deletes it.
 */
export function SecretRow({ name, label, hint, onSaved }: { name: SecretName; label: string; hint?: string; onSaved?: () => void }) {
  const [stored, setStored] = useState(false);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setValue("");
    void secrets.has(name).then(setStored);
  }, [name]);

  useEffect(() => {
    if (!confirm) return;
    const id = window.setTimeout(() => setConfirm(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirm]);

  const save = async () => {
    setConfirm(false);
    await secrets.set(name, value);
    setStored(!!value.trim());
    setValue("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
    onSaved?.();
  };

  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-1.5">
        <AnimatePresence>
          {(saved || (stored && !value)) && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
              <CheckCircle size={14} weight="fill" className="text-green" />
            </motion.span>
          )}
        </AnimatePresence>
        <TextField secret value={value} onChange={setValue} onSubmit={() => value && void save()} placeholder={stored ? t("Gespeichert") : t("Einfügen")} width="w-40" />
        {(value || stored) && (
          <Button onClick={() => (value || confirm ? void save() : setConfirm(true))} disabled={!value && !stored}>
            {value ? t("Sichern") : confirm ? t("Wirklich löschen?") : t("Löschen")}
          </Button>
        )}
      </div>
    </Row>
  );
}
