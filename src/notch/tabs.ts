import type { ComponentType } from "react";
import {
  ArrowsLeftRight,
  BellSimple,
  Calculator,
  CalendarBlank,
  CheckCircle,
  ClipboardText,
  CloudSun,
  Code,
  Cpu,
  Drop,
  Gauge,
  GearSix,
  Gift,
  HandWaving,
  MagnifyingGlass,
  GithubLogo,
  RocketLaunch,
  SquaresFour,
  MusicNotesSimple,
  NotePencil,
  Sparkle,
  Timer,
  Tray,
  Vault,
  TerminalWindow,
  type Icon,
} from "@phosphor-icons/react";
import { DepotIcon } from "../ui/icons";
import type { Hue } from "../features/themes/hues";
import { DiscordLogo } from "../ui/brands";
import { OverviewView } from "../features/overview/OverviewView";
import { NowPlayingView } from "../features/now-playing/NowPlayingView";
import { TimerView } from "../features/timer/TimerView";
import { TodosView } from "../features/todos/TodosView";
import { NotesView } from "../features/notes/NotesView";
import { ClipboardView } from "../features/clipboard/ClipboardView";
import { ShelfView } from "../features/shelf/ShelfView";
import { AskView } from "../features/ask/AskView";
import { ConvertView } from "../features/convert/ConvertView";
import { TradingView } from "../features/trading/TradingView";
import { UsageView } from "../features/usage/UsageView";
import { WeatherView } from "../features/weather/WeatherView";
import { SystemView } from "../features/system/SystemView";
import { DiscordView } from "../features/discord/DiscordView";
import { VaultView } from "../features/vault/VaultView";
import { WaterView } from "../features/water/WaterView";
import { ScratchpadView } from "../features/scratchpad/ScratchpadView";
import { QUOTE_LINE_H } from "../features/quotes/QuoteLine";
import { settings } from "../settings/store";
import { NoticesView } from "../features/notices/NoticesView";
import { SettingsView } from "../features/settings/SettingsView";
import { TerminalView } from "../features/terminal/TerminalView";
import { LauncherView } from "../features/launcher/LauncherView";
import { GithubView } from "../features/github/GithubView";
import { CalendarView } from "../features/calendar/CalendarView";
import { CaptureView } from "../features/capture/CaptureView";
import { SetupView } from "../features/setup/SetupView";
import { WhatsNewView } from "../features/whatsnew/WhatsNewView";
import { Camera, VideoCamera, Waveform } from "@phosphor-icons/react";
import { RecorderView } from "../features/recorder/RecorderView";
import { CameraView } from "../features/camera/CameraView";
import { FindView } from "../features/find/FindView";
import { CalendarCheck } from "@phosphor-icons/react";
import { HabitsView } from "../features/habits/HabitsView";
import { ColourView } from "../features/colour/ColourView";
import { Eyedropper } from "@phosphor-icons/react";
import { GlobeHemisphereWest } from "@phosphor-icons/react";
import { ClocksView } from "../features/clocks/ClocksView";
import { Scroll } from "@phosphor-icons/react";
import { TeleprompterView } from "../features/teleprompter/TeleprompterView";
import { Robot } from "@phosphor-icons/react";
import { AgentsView } from "../features/agents/AgentsView";
import { CalcView } from "../features/calc/CalcView";
import { pluginTab } from "../features/plugins/tabs";
import { isMac } from "../platform/native";

/** Tools built on Windows APIs with no Mac version yet (src-tauri/src/macos/); a Mac doesn't list them. */
const WINDOWS_ONLY = new Set(["shelf", "system", "discord", "vault", "terminal", "launcher", "notices", "capture", "recorder", "camera"]);

/**
 * Registry of all tools in the open notch. New tool = new entry here
 * + ID in `TOOL_IDS` (src/settings/tools.ts). Visibility and order
 * are up to the user in the settings.
 *
 * `size` is the open notch size for this tool (incl. header and dock);
 * the shape morphs there on tab switch. Max. 740 × 540 (window size).
 * Tools can grow it at runtime: `requestSize` (src/notch/size.ts).
 */
export interface NotchTab {
  id: string;
  label: string;
  icon: Icon;
  /** Its colour in the tool bar while coloured icons are on (Settings, Themes); plugins have none. */
  hue?: Hue;
  size: { w: number; h: number };
  View: ComponentType;
}

export const tabs: NotchTab[] = ([
  {
    id: "overview",
    hue: "blue",
    label: "Übersicht",
    icon: SquaresFour,
    // Taller while the quote line is on; read on every render, so the shape follows the setting.
    get size() {
      return { w: 520, h: 252 + (settings.get().productivity.quotes ? QUOTE_LINE_H : 0) };
    },
    View: OverviewView,
  },
  { id: "media", hue: "pink", label: "Wiedergabe", icon: MusicNotesSimple, size: { w: 520, h: 232 }, View: NowPlayingView },
  { id: "timer", hue: "orange", label: "Timer", icon: Timer, size: { w: 520, h: 192 }, View: TimerView },
  { id: "todos", hue: "green", label: "To-Dos", icon: CheckCircle, size: { w: 600, h: 276 }, View: TodosView },
  { id: "notes", hue: "yellow", label: "Notiz", icon: NotePencil, size: { w: 520, h: 260 }, View: NotesView },
  { id: "clipboard", hue: "teal", label: "Zwischenablage", icon: ClipboardText, size: { w: 600, h: 236 }, View: ClipboardView },
  { id: "shelf", hue: "amber", label: "Ablage", icon: Tray, size: { w: 560, h: 236 }, View: ShelfView },
  { id: "ask", hue: "violet", label: "Ask", icon: Sparkle, size: { w: 560, h: 440 }, View: AskView },
  { id: "convert", hue: "rose", label: "Converter", icon: ArrowsLeftRight, size: { w: 520, h: 210 }, View: ConvertView },
  { id: "trading", hue: "emerald", label: "Depot", icon: DepotIcon, size: { w: 560, h: 380 }, View: TradingView },
  { id: "usage", hue: "purple", label: "AI-Nutzung", icon: Gauge, size: { w: 600, h: 320 }, View: UsageView },
  { id: "weather", hue: "sky", label: "Wetter", icon: CloudSun, size: { w: 640, h: 330 }, View: WeatherView },
  { id: "system", hue: "red", label: "Hardware", icon: Cpu, size: { w: 720, h: 380 }, View: SystemView },
  { id: "discord", hue: "indigo", label: "Discord", icon: DiscordLogo, size: { w: 520, h: 210 }, View: DiscordView },
  { id: "vault", hue: "slate", label: "Tresor", icon: Vault, size: { w: 560, h: 324 }, View: VaultView },
  { id: "water", hue: "cyan", label: "Wasser", icon: Drop, size: { w: 520, h: 236 }, View: WaterView },
  { id: "scratchpad", hue: "lime", label: "Code-Notizblock", icon: Code, size: { w: 600, h: 320 }, View: ScratchpadView },
  { id: "terminal", hue: "slate", label: "Terminal", icon: TerminalWindow, size: { w: 720, h: 460 }, View: TerminalView },
  { id: "launcher", hue: "orange", label: "Launcher", icon: RocketLaunch, size: { w: 520, h: 210 }, View: LauncherView },
  { id: "github", hue: "violet", label: "GitHub", icon: GithubLogo, size: { w: 520, h: 236 }, View: GithubView },
  { id: "calendar", hue: "red", label: "Kalender", icon: CalendarBlank, size: { w: 560, h: 340 }, View: CalendarView },
  { id: "notices", hue: "amber", label: "Mitteilungen", icon: BellSimple, size: { w: 560, h: 320 }, View: NoticesView },
  { id: "capture", hue: "cyan", label: "Erfassen", icon: Camera, size: { w: 620, h: 336 }, View: CaptureView },
  { id: "recorder", hue: "rose", label: "Rekorder", icon: Waveform, size: { w: 520, h: 280 }, View: RecorderView },
  { id: "camera", hue: "pink", label: "Kamera", icon: VideoCamera, size: { w: 520, h: 330 }, View: CameraView },
  { id: "habits", hue: "teal", label: "Gewohnheiten", icon: CalendarCheck, size: { w: 520, h: 260 }, View: HabitsView },
  { id: "colour", hue: "purple", label: "Farbe", icon: Eyedropper, size: { w: 620, h: 420 }, View: ColourView },
  { id: "clocks", hue: "indigo", label: "Uhren", icon: GlobeHemisphereWest, size: { w: 620, h: 372 }, View: ClocksView },
  { id: "teleprompter", hue: "amber", label: "Prompter", icon: Scroll, size: { w: 560, h: 340 }, View: TeleprompterView },
  { id: "agents", hue: "indigo", label: "Agents", icon: Robot, size: { w: 620, h: 460 }, View: AgentsView },
  { id: "calc", hue: "indigo", label: "Rechner", icon: Calculator, size: { w: 600, h: 320 }, View: CalcView },
] satisfies NotchTab[]).filter((t) => !isMac || !WINDOWS_ONLY.has(t.id));

/** Settings: reached via the gear, not in the tool bar. */
export const settingsTab: NotchTab = { id: "settings", label: "Einstellungen", icon: GearSix, size: { w: 660, h: 460 }, View: SettingsView };

/** First-run setup: opens by itself until finished or skipped, and again from Settings, General. Not in the tool bar either. */
export const setupTab: NotchTab = { id: "setup", label: "Einrichtung", icon: HandWaving, size: { w: 600, h: 400 }, View: SetupView };

/** Pages reached outside the tool bar; they show whether or not a tool is enabled. */
/** What's new: opened from its notice in the closed notch (src/features/whatsnew/). Not in the tool bar. */
export const whatsNewTab: NotchTab = { id: "whatsnew", label: "Neuerungen", icon: Gift, size: { w: 560, h: 360 }, View: WhatsNewView };

/** Find on screen: opened by its shortcut (Settings, Window), reads the screens with OCR (src/features/find/). */
export const findOnScreenTab: NotchTab = { id: "find", label: "Auf dem Bildschirm suchen", icon: MagnifyingGlass, size: { w: 600, h: 320 }, View: FindView };

export const pageTabs = [settingsTab, setupTab, whatsNewTab, findOnScreenTab];

/** A built-in tool, a page, or an installed plugin (`plugin:<id>`). */
export function findTab(id: string): NotchTab | undefined {
  return pageTabs.find((t) => t.id === id) ?? tabs.find((t) => t.id === id) ?? pluginTab(id);
}
