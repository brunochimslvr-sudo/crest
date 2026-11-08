import { createStore, setAside } from "../lib/store";
import { isMac } from "../platform/native";
import { isLanguage, type LanguageSetting } from "../i18n/core";
import type { AlarmDuration, AlarmSound } from "../lib/sound";
import { CLOSED_DEFAULTS, normalizeClosed, type ClosedSettings } from "../notch/row/parts";
import { normalizeClockLook, normalizeLook, normalizeLookColor, type ClockLook, type LookColor, type TimerLook } from "../features/timer/looks";
import { normalizeFocusSound, type FocusSound } from "../features/timer/focusSound";
import { WATER_DEFAULTS, normalizeWater, type WaterConfig } from "../features/water/water";
import { normalizeCards, USAGE_CARDS_DEFAULTS, type UsageCards } from "../features/usage/cards";
import { THEME_DEFAULTS, legacyIconColors, normalizeThemeSettings, type ThemeSettings } from "../features/themes/themes";
import type { ColorScheme } from "../features/system/levels";
import { normalizeFavorites, type Favorite } from "../features/launcher/apps";
import { NOTICE_DEFAULTS, normalizeNotices, type NoticeSettings } from "../features/notices/rules";
import { WINDOW_DEFAULTS, normalizeWindow, type WindowSettings } from "../features/window/model";
import { DOCK_DEFAULTS, normalizeDock, type Dock } from "../notch/edge";
import { normalizeMonitorMode, type MonitorMode } from "../notch/follow";
import { CALENDAR_DEFAULTS, normalizeCalendar, type CalendarSettings } from "../features/calendar/model";
import { CLOSED_SIZE_DEFAULTS, fitCapsuleTop, normalizeClosedSize, type ClosedSize } from "../notch/collapsed";
import { DEFAULT_OFF, TOOL_IDS } from "./tools";
import { LYRIC_SOURCE_DEFAULTS, normalizeSources, type LyricSourceSetting } from "../features/now-playing/lyricSources";

export type AskProvider = "openrouter" | "openai" | "anthropic" | "custom";
export type AskEffort = "off" | "low" | "medium" | "high" | "xhigh";

export interface AskProviderConfig {
  model: string;
  effort: AskEffort;
  /** Only for "custom": OpenAI-compatible base, e.g. https://…/v1 */
  baseUrl: string;
}

export interface Settings {
  /** Open on hover or only on click. */
  openMode: "hover" | "click";
  hoverDelay: "fast" | "normal" | "patient";
  /**
   * The tool the notch opens on when nothing else decides (a tray entry, a clicked notice, the part of the closed row under the pointer,
   * a timer or call): its id, or "" for the one used last. Music playing in the background does not decide either. A tool that is not in
   * the tool bar counts as "".
   */
  startTab: string;
  /** Order = order in the tool bar. Installed plugins are tools `plugin:<id>` (src/features/plugins). */
  tools: { id: string; enabled: boolean }[];
  /** Portfolio: Trading 212 account, and the base currency ("" = not chosen yet, see features/trading/base.ts). */
  trading: { env: "live" | "demo"; base: string };
  /** AI usage: which providers are shown (order = display order). */
  usage: { claude: boolean; codex: boolean; gemini: boolean; cursor: boolean; openrouter: boolean; deepseek: boolean; zai: boolean };
  /** AI usage cards: order, names typed by the user, model prices set by hand. */
  aiUsage: UsageCards;
  ask: { provider: AskProvider; configs: Record<AskProvider, AskProviderConfig> };
  /** `auto` = detected via IP (again on every start); a picked location stays. */
  weather: { name: string; detail?: string; lat: number; lon: number; auto?: boolean } | null;
  /**
   * Display: always on top or hidden in fullscreen; monitor name (null = primary);
   * `offset` = horizontal offset from the center in CSS px (set by dragging).
   */
  display: {
    /** Replaced by `behavior.rules`; only read once to seed them for older installs. */
    visibility: "always" | "hide-fullscreen";
    monitor: string | null;
    /** "chosen": on `monitor`; "follow": where the pointer is while closed; "all": a closed copy on every other monitor (src/notch/monitor.ts). */
    monitorMode: MonitorMode;
    offset: number;
    /** Focus mode look: half transparent (as before) or shrunk to a thin line at the edge. */
    focusStyle: "dim" | "line";
    /**
     * Closed look outside focus mode: the notch, the floating capsule, or a thin line (no
     * music etc.; only a finished timer opens it into the notch until dismissed). Hover and
     * click work as usual.
     */
    idleStyle: "notch" | "capsule" | "line";
    /** Distance of the capsule from the top edge of the monitor in CSS px at 100 % (set by dragging or in the settings, 0 to 8000). */
    y: number;
  };
  /** What the closed notch row shows: which parts, in which order, and their options. */
  closed: ClosedSettings;
  /** Size of the closed notch, capsule and line, and the line's distance from the edge (src/notch/collapsed.ts). */
  closedSize: ClosedSize;
  /** Gaming mode: FPS + load in the closed notch: off, only in fullscreen, or always. */
  gaming: { mode: "off" | "fullscreen" | "on" };
  /** Dots like on iPhone: mic/camera (green) or screen recording (red) in use. */
  privacyDots: boolean;
  /** Discord call in the notch (local RPC, on = Discord tool enabled). The client secret is stored with the secrets. */
  discord: { clientId: string };
  alarm: { sound: AlarmSound; volume: number; duration: AlarmDuration };
  /** Interface language: "system" follows Windows (English when it is not one of src/i18n/core.ts). */
  lang: LanguageSetting;
  /** Temperature and clock format; picked from the Windows region on first start. */
  units: { temp: "c" | "f"; clock: "24" | "12" };
  /**
   * Presentation mode: hides clipboard previews, balances and the vault while sharing
   * the screen. `manual` = switched on by hand, `auto` = on while a recording is detected.
   * `hideFromCapture`: Crest's windows stay out of other apps' screen sharing and recordings (src-tauri sharing.rs), off by default.
   */
  presentation: { manual: boolean; auto: boolean; hideFromCapture: boolean };
  /** Check for a new version once a day, anonymously (installs only on click). */
  updates: { auto: boolean };
  /** Look of the big countdown in the Timer tool and the detached timer window; background sound while a focus timer runs, volume 0 to 1. */
  timer: { look: TimerLook; clockLook: ClockLook; color: LookColor; clockColor: LookColor; focusSound: FocusSound; focusVolume: number };
  /** To-do reminders (sound), dates in plain words in the new-task field, the water reminder and the quote line in Overview. */
  productivity: { reminderSound: boolean; nlDates: boolean; quotes: boolean; water: WaterConfig };
  /** Terminal tool: shell, font size in px, start folder ("" = home), end the shell when the notch closes. */
  terminal: { shell: "pwsh" | "powershell" | "cmd"; fontSize: number; startDir: string; endOnClose: boolean };
  /**
   * Music: the lyrics panel in Now Playing is open; the Song title part shows the current lyric line; the closed notch
   * shows only cover and line while synced lyrics play; the player shown whatever else plays (media app ID, null = automatic).
   * Lyrics: the sources in the order they are asked; word-by-word highlighting where the source times words; the source's
   * translation; a translation through the Ask provider for songs without one; romanisation of Japanese, Chinese and Korean.
   * Looks of the equalizer and the progress bar in the Music tool (the closed row keeps its four bars).
   */
  music: {
    lyricsOpen: boolean;
    titleLyrics: boolean;
    notchLyrics: boolean;
    pinned: string | null;
    lyricSources: LyricSourceSetting[];
    lyricWords: boolean;
    lyricTranslation: boolean;
    lyricRoman: boolean;
    /** The closed notch's lyric line in Latin letters instead of as sung, where it has a romanisation (issue #10). */
    closedRoman: boolean;
    /** The closed notch's lyric line translated instead of as sung, where the song has a translation. */
    closedTranslation: boolean;
    /** Lyrics translated on this computer into Crest's language, with downloaded models (offline.ts). */
    offlineTranslation: boolean;
    /** The language to translate into ("" = Crest's own, offline.ts `targetOf`). */
    offlineTarget: string;
    eqStyle: "bars" | "spectrum" | "wave";
    progressStyle: "line" | "wavy";
  };
  /** Panel theme, custom themes and the day and night switch (src/features/themes). */
  themes: ThemeSettings;
  /** Hardware tool: colours of the readings, the GPU shown (adapter name, "" = automatic: the busiest; index among adapters of that name), process ranking. */
  system: { colors: ColorScheme; gpu: string; gpuIndex: number; sort: "cpu" | "mem" };
  /**
   * App launcher: pinned apps, `null` until the first app list arrives, which pins the detected
   * AI apps once. `hotkeys`: the first six on Alt+1 to Alt+6, opt-in (other apps lose those keys).
   */
  launcher: { favorites: Favorite[] | null; hotkeys: boolean };
  /** GitHub activity: the public username. An optional token is stored with the secrets. */
  github: { user: string };
  /** Calendar: ICS links and CalDAV accounts (the link or app password is stored with the secrets), the notice before an event, the next-event part's horizon. */
  calendar: CalendarSettings;
  /** Live notices: Windows notifications and crest-notify in the closed notch, with per-app rules and quiet hours. */
  notices: NoticeSettings;
  /** Window behaviour: full-screen and app rules, shortcuts, panel sizes and scale, close delay, mouse (src/features/window). */
  behavior: WindowSettings;
  /** The screen edge the notch and the line hang from, and whether from the screen's edge or the taskbar's (the capsule floats on the top frame). */
  dock: Dock;
  /**
   * Capture tool: what a screenshot takes ("all" or a monitor id), the recording source
   * (null = primary monitor), frame rate, microphone and system audio, and whether new
   * screenshots also go on the Shelf, and whether Windows' yellow frame marks what is recorded.
   */
  capture: { shotTarget: string; source: string | null; fps: 30 | 60; mic: boolean; system: boolean; shelf: boolean; border: boolean };
  /** Recorder tool: which inputs a sound-only recording takes, and whether its note on consent was read. */
  recorder: { mic: boolean; system: boolean; noted: boolean };
  /** Camera tool: the camera picked by its deviceId ("" = the first one) and whether the picture is mirrored. */
  camera: { deviceId: string; mirror: boolean };
  /** First-run setup (src/features/setup) finished or skipped. Settings saved without the field come from an older version, which counts as done. */
  setup: { done: boolean };
  /** Clipboard tool: the small chip that decodes a JWT, Unix time, Base64, UUID, JSON, colour or tracking link on an entry. Only visual, on by default. */
  clipChips: boolean;
}

const defaults: Settings = {
  openMode: "hover",
  hoverDelay: "normal",
  startTab: "agents",
  tools: TOOL_IDS.map((id) => ({ id, enabled: !DEFAULT_OFF.has(id) })),
  trading: { env: "live", base: "" },
  usage: { claude: true, codex: true, gemini: true, cursor: false, openrouter: false, deepseek: false, zai: false },
  aiUsage: USAGE_CARDS_DEFAULTS,
  ask: {
    provider: "custom",
    configs: {
      openrouter: { model: "", effort: "medium", baseUrl: "" },
      openai: { model: "", effort: "off", baseUrl: "" },
      anthropic: { model: "claude-opus-5-5", effort: "medium", baseUrl: "" },
      custom: { model: "", effort: "off", baseUrl: "" },
    },
  },
  weather: null,
  display: { visibility: "always", monitor: null, monitorMode: "chosen", offset: 0, focusStyle: "dim", idleStyle: "notch", y: 5 },
  closed: CLOSED_DEFAULTS,
  closedSize: CLOSED_SIZE_DEFAULTS,
  gaming: { mode: "off" },
  privacyDots: false,
  discord: { clientId: "" },
  alarm: { sound: "chime", volume: 0.7, duration: 5 },
  lang: "system",
  units: regionUnits(),
  presentation: { manual: false, auto: true, hideFromCapture: false },
  updates: { auto: true },
  timer: { look: "clean", clockLook: "standard", color: "orange", clockColor: "white", focusSound: "off", focusVolume: 0.3 },
  productivity: { reminderSound: true, nlDates: true, quotes: false, water: WATER_DEFAULTS },
  terminal: { shell: "pwsh", fontSize: 13, startDir: "", endOnClose: false },
  music: {
    lyricsOpen: false,
    titleLyrics: false,
    notchLyrics: false,
    pinned: null,
    lyricSources: LYRIC_SOURCE_DEFAULTS,
    lyricWords: true,
    lyricTranslation: true,
    lyricRoman: false,
    closedRoman: false,
    closedTranslation: false,
    offlineTranslation: false,
    offlineTarget: "",
    eqStyle: "bars",
    progressStyle: "line",
  },
  themes: THEME_DEFAULTS,
  system: { colors: "calm", gpu: "", gpuIndex: 0, sort: "cpu" },
  launcher: { favorites: null, hotkeys: false },
  github: { user: "" },
  calendar: CALENDAR_DEFAULTS,
  notices: NOTICE_DEFAULTS,
  behavior: WINDOW_DEFAULTS,
  dock: DOCK_DEFAULTS,
  capture: { shotTarget: "all", source: null, fps: 30, mic: false, system: true, shelf: false, border: true },
  recorder: { mic: true, system: true, noted: false },
  camera: { deviceId: "", mirror: true },
  setup: { done: false },
  clipChips: true,
};

/** °F and 12 h where the Windows region uses them (US & co.), otherwise °C and 24 h. */
function regionUnits(): Settings["units"] {
  const loc = navigator.language || "en-US";
  let region = "";
  let cycle: string | undefined;
  try {
    region = new Intl.Locale(loc).maximize().region ?? "";
    cycle = new Intl.DateTimeFormat(loc, { hour: "numeric" }).resolvedOptions().hourCycle;
  } catch {
    // Unknown locale → metric, 24 h.
  }
  return {
    temp: ["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH"].includes(region) ? "f" : "c",
    clock: cycle === "h12" || cycle === "h11" ? "12" : "24",
  };
}

export const hoverDelayMs: Record<Settings["hoverDelay"], number> = { fast: 90, normal: 220, patient: 480 };

/** No settings saved yet = fresh install (read before the store writes its defaults). */
export const firstRun = (() => {
  try {
    return localStorage.getItem("notch:settings") === null;
  } catch {
    return false;
  }
})();

export const settings = createStore<Settings>(defaults, { persist: "settings" });

// Fill in settings from older versions: new fields + append new tools.
try {
  settings.set(migrate);
} catch {
  // A saved value of the wrong shape must not stop the app from loading: keep it aside and start from the defaults.
  setAside("notch:settings", localStorage.getItem("notch:settings"));
  settings.set(defaults);
}

function migrate({ language: _old, ...s }: Settings & { language?: unknown }): Settings {
  const known = new Set<string>(TOOL_IDS);
  // Plugin tools stay; src/features/plugins/store.ts drops those no longer installed once it has read the list.
  const tools = (s.tools ?? []).filter((t) => known.has(t.id) || /^plugin:[a-z0-9-]{3,32}$/.test(t.id));
  for (const id of TOOL_IDS) {
    if (tools.some((t) => t.id === id)) continue;
    // Overview is the start page, so put it first for existing installs.
    if (id === "overview") tools.unshift({ id, enabled: true });
    else tools.push({ id, enabled: !DEFAULT_OFF.has(id) });
  }
  return {
    ...defaults,
    ...s,
    // The old `language` was forced to English, never a choice: those settings start from the system language.
    lang: s.lang === "system" || isLanguage(s.lang) ? s.lang : "system",
    tools,
    // Saved before the field existed: the default. Anything that is not a string would never match a tool, so it reads as "last used".
    startTab: s.startTab === undefined ? defaults.startTab : typeof s.startTab === "string" ? s.startTab : "",
    trading: { ...defaults.trading, ...s.trading },
    usage: { ...defaults.usage, ...s.usage },
    aiUsage: normalizeCards(s.aiUsage),
    // A saved y that is not a finite number (null, a string) would place the capsule nowhere; a Mac has no Follow or All modes (an older build offered them).
    display: { ...defaults.display, ...s.display, y: fitCapsuleTop(s.display?.y), monitorMode: isMac ? "chosen" : normalizeMonitorMode(s.display?.monitorMode) },
    gaming: { ...defaults.gaming, ...s.gaming },
    discord: { ...defaults.discord, ...s.discord },
    alarm: { ...defaults.alarm, ...s.alarm },
    units: { ...defaults.units, ...s.units },
    presentation: { ...defaults.presentation, ...s.presentation },
    updates: { ...defaults.updates, ...s.updates },
    timer: {
      ...defaults.timer,
      ...s.timer,
      look: normalizeLook(s.timer?.look),
      clockLook: normalizeClockLook(s.timer?.clockLook),
      color: normalizeLookColor(s.timer?.color, "orange"),
      clockColor: normalizeLookColor(s.timer?.clockColor, "white"),
      focusSound: normalizeFocusSound(s.timer?.focusSound),
    },
    productivity: { ...defaults.productivity, ...s.productivity, water: normalizeWater(s.productivity?.water) },
    terminal: { ...defaults.terminal, ...s.terminal },
    music: { ...defaults.music, ...s.music, lyricSources: normalizeSources(s.music?.lyricSources) },
    // Coloured icons moved from Hardware (closed-row readings only) to Themes (the whole app).
    themes: normalizeThemeSettings(s.themes, legacyIconColors(s.system)),
    system: (({ iconColors: _moved, ...rest }: Partial<Settings["system"]> & { iconColors?: unknown }) => ({ ...defaults.system, ...rest }))(s.system ?? {}),
    // Only an explicit opt-in turns the keys on; an older saved `shortcuts: true` does not.
    launcher: { favorites: normalizeFavorites(s.launcher?.favorites), hotkeys: s.launcher?.hotkeys === true },
    github: { ...defaults.github, ...s.github },
    calendar: normalizeCalendar(s.calendar),
    capture: { ...defaults.capture, ...s.capture },
    recorder: { ...defaults.recorder, ...s.recorder },
    camera: { ...defaults.camera, ...s.camera },
    closed: normalizeClosed(s.closed),
    closedSize: normalizeClosedSize(s.closedSize),
    notices: normalizeNotices(s.notices),
    ask: migrateAsk(s.ask),
    behavior: normalizeWindow(s.behavior, s.display?.visibility),
    dock: normalizeDock(s.dock),
    // Only a fresh install starts from the defaults (done: false); settings saved by 0.2.x have no `setup` and never see it.
    setup: { done: s.setup ? s.setup.done === true : true },
  };
}

/** Migrates the old shape ({ provider: "demo", model }) and adds missing providers. */
function migrateAsk(old: Partial<Settings["ask"]> | undefined): Settings["ask"] {
  const known = Object.keys(defaults.ask.configs) as AskProvider[];
  const provider = old?.provider && known.includes(old.provider) ? old.provider : defaults.ask.provider;
  const configs = { ...defaults.ask.configs };
  for (const p of known) configs[p] = { ...defaults.ask.configs[p], ...old?.configs?.[p] };
  return { provider, configs };
}

export function updateAsk(provider: AskProvider, patch: Partial<AskProviderConfig>) {
  settings.set((s) => ({ ...s, ask: { ...s.ask, configs: { ...s.ask.configs, [provider]: { ...s.ask.configs[provider], ...patch } } } }));
}

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  settings.set((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
}
