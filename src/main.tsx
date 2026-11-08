import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "./styles/global.css";
import { Notch } from "./notch/Notch";
import { DesktopMock } from "./dev/DesktopMock";
import { isMac, isNative } from "./platform/native";
import { startDropListener } from "./platform/drop";
import { clipboard } from "./platform/clipboard";
import { settings } from "./settings/store";
import { applyDisplay, placementKey } from "./notch/drag";
import { closedLive } from "./notch/ClosedResize";
import { focusMode, startFocusMode } from "./notch/focus";
import { monitor, monitors, reloadMonitor, startMonitorWatch } from "./notch/monitor";
import { startSystemPolling } from "./features/system/store";
import { startUsagePolling } from "./features/usage/store";
import { startGamingWatch } from "./features/system/gaming";
import { startStatusWatch } from "./features/status/store";
import { startDiscord } from "./features/discord/store";
import { startNotices } from "./features/notices/store";
import { startAgentsWatch } from "./features/agents/store";
import { startUpdateWatch } from "./lib/update";
import { startTodoReminders } from "./features/todos/store";
import { startWaterReminders } from "./features/water/store";
import { startBreaks } from "./features/breaks/store";
import { startMusic } from "./features/now-playing/music";
import { startThemes } from "./features/themes/store";
import { startLauncher } from "./features/launcher/store";
import { startGithub } from "./features/github/store";
import { startCalendar } from "./features/calendar/store";
import { screen, startWindowBehavior } from "./features/window/store";
import { startCapture } from "./features/capture/store";
import { startDownloads } from "./features/downloads/store";
import { startPlugins } from "./features/plugins/store";
import { startMeeting } from "./features/meeting/store";
import { demo, showcase } from "./dev/showcase-data";
import { startShowcase } from "./dev/showcase";
import { startDemo } from "./dev/demo";
import { language, startLanguage, t } from "./i18n";
import { setTrayTexts } from "./platform/native";

if (showcase) startShowcase();
if (demo) startDemo();

startDropListener();
startFocusMode();
startMonitorWatch();
startSystemPolling();
startUsagePolling();
startGamingWatch();
startStatusWatch();
startDiscord();
startNotices();
startUpdateWatch();
startTodoReminders();
startWaterReminders();
startBreaks();
startMusic();
startThemes();
startLauncher();
startGithub();
startAgentsWatch();
startCalendar();
startWindowBehavior();
startCapture();
startDownloads();
startPlugins();
startMeeting();

// Send display settings (monitor, fullscreen, offset, window top, gaming) to Rust on start and on every change.
// The window top follows the style, the capsule's y, focus mode and the monitor once it has loaded.
let lastDisplay = "";
let lastScale = 100;
const syncDisplay = () => {
  const { display, gaming, behavior } = settings.get();
  const rules = JSON.stringify([behavior.rules, behavior.apps, behavior.scale]);
  const key = `${rules}|${display.monitor}|${display.monitorMode}|${display.offset}|${placementKey()}|${gaming.mode}`;
  if (key === lastDisplay) return;
  lastDisplay = key;
  // The monitor's size in CSS px changes with the panel scale: until it is read again (once Rust has the new one, same command queue)
  // the line and the window top are converted from the old scale's metrics.
  if (behavior.scale !== lastScale) {
    applyDisplay(undefined, undefined, undefined, behavior.scale / lastScale);
    lastScale = behavior.scale;
    reloadMonitor();
  } else applyDisplay();
};
syncDisplay();
settings.subscribe(syncDisplay);
monitor.subscribe(syncDisplay);
monitors.subscribe(syncDisplay);
focusMode.subscribe(syncDisplay);
closedLive.subscribe(syncDisplay);
screen.subscribe(syncDisplay);

// Clipboard history only records what an enabled tool uses (Ask: the latest text).
let lastClipMode = "";
const syncClipboardMode = () => {
  const on = (id: string) => settings.get().tools.some((t) => t.id === id && t.enabled);
  const mode = on("clipboard") ? "all" : on("ask") ? "text" : "off";
  if (mode === lastClipMode) return;
  lastClipMode = mode;
  clipboard.mode(mode);
};
syncClipboardMode();
settings.subscribe(syncClipboardMode);

// The tray menu is Rust's; its texts follow the language from here.
language.subscribe(() =>
  setTrayTexts({ open: t("Crest öffnen"), settings: t("Einstellungen …"), focus: t("Fokus-Modus"), autostart: isMac ? t("Bei der Anmeldung öffnen") : t("Mit Windows starten"), quit: t("Crest beenden") }),
);
const languageReady = startLanguage(settings);

// The notch isn't a web page: no browser context menu (except in text fields for
// cut/paste) and in the app no browser shortcuts like reload or print.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});
if (isNative) {
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.key === "F5" || e.key === "F7" || e.key === "F12" || (e.ctrlKey && ["r", "p", "f", "g", "j", "u", "s"].includes(k))) e.preventDefault();
  });
}

/** Re-renders everything when the language changes, so every t() runs again (no remount: open tools keep their state). */
function App() {
  language.use();
  return (
    // reducedMotion="user": Motion respects the Windows "Animation effects" setting.
    <MotionConfig reducedMotion="user">
      {!isNative && <DesktopMock />}
      <Notch />
    </MotionConfig>
  );
}

// The first frame waits for the dictionary, so it is never English for a moment.
void languageReady.then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
