import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence, animate, frame, motion, useMotionValue, useTransform, type MotionValue, type Transition } from "motion/react";
import { GearSix, PushPin, Selection } from "@phosphor-icons/react";
import { content, springs } from "../design/motion";
import { livePosition, useNowPlaying } from "../platform/media";
import { isNative, keyboardFocus, onNativeBlur, onNativeHover, onNativeHoverAt, onShortcut, onTrayOpen, setHitRect, setMemoryLow, setPassthrough } from "../platform/native";
import { PrivacyDots } from "../features/privacy/PrivacyDots";
import { FOCUS_CLICKS, focusMode, setFocusMode } from "./focus";
import { dragArea, edgeOf, useDragToMove, viewLine, windowLength, windowY } from "./drag";
import { useLiveActivity } from "./live";
import { useAgentsNeedYou } from "../features/agents/store";
import { CompactRow } from "./row/CompactRow";
import { CompactColumn } from "./row/CompactColumn";
import { NoticeLayer } from "./row/NoticeLayer";
import { Nest } from "./pet/Nest";
import { statusAlert } from "../features/status/store";
import { effectiveIdleStyle, screen } from "../features/window/store";
import { ResizeHandles, stepToolSize, useToolSize, wheelTaken } from "../features/window/panel";
import { cycle } from "../features/window/model";
import { windowShell } from "../platform/services";
import { DOCK_HEIGHT, HEADER_HEIGHT, closedGeometry, columnGeometry, lineGeometry, openGeometry, peekGeometry, type NotchGeometry } from "./geometry";
import { across, frameCss, pointerIn, windowLine, type Edge } from "./edge";
import { columnRoom, columnSurface } from "./column";
import { capsuleY, hasBridge, panelTop, windowYFor } from "./capsule";
import { contentScale, sideLength } from "./collapsed";
import { monitor, monitorMetrics, monitors, notchBusy, sharedSpan } from "./monitor";
import { useMirror } from "./mirror";
import { ROW, rowRoom, surfaceWidth } from "./row/layout";
import { limits, toPageCss } from "../features/window/panelSize";
import { HeaderButton, ToolScope, activeTool, headerSlot, leadSlot } from "./header";
import { isMac } from "../platform/native";
import { sizeOverride } from "./size";
import { NotchShape } from "./NotchShape";
import { ClosedResize, ClosedResizeBar, closedEdit, closedLive } from "./ClosedResize";
import { drop, takeDropped } from "../platform/drop";
import { settings } from "../settings/store";
import { useUnseen } from "../lib/changelog";
import { nav, navigate, openOn, takeOpenTarget } from "./nav";
import { update } from "../lib/update";
import { findOnScreenTab, findTab, pageTabs, settingsTab, setupTab, tabs, type NotchTab } from "./tabs";
import { scanScreens } from "../features/find/store";
import { holdOpen, pinned, stayUntilVisit, togglePin, useNotchState, visited, type NotchStatus } from "./useNotchState";
import { t } from "../i18n";
import { timer, useSecondTick } from "../features/timer/store";
import { dueTasks } from "../features/todos/store";
import { asks } from "../features/notices/store";
import { refreshTheme, useClosedInk, useThemedAccent } from "../features/themes/store";
import { useHue, type Hue } from "../features/themes/hues";
import { recording } from "../features/capture/store";
import { plugins } from "../features/plugins/store";

/** If the notch was closed at most this long, it reopens on the last used tool. */
const RESUME_MS = 60_000;
const NOOP = () => {};
/** A part seen under the pointer this recently still decides the tool a hover opens (natively the page may miss the pointer leaving). */
const POINTED_MS = 1500;
/** Closed this long → lower WebView2's memory target. */
const MEMORY_LOW_AFTER_MS = 20_000;
/** After a drag ends without files, the native drop's paths may still be on their way for this long. */
const DROP_WAIT_MS = 500;

export function Notch() {
  const { status, open, close, dismiss, toggle, onPointerEnter, onPointerLeave } = useNotchState();
  const focus = focusMode.use();
  const { tools: toolSettings, display: displaySettings, behavior, closedSize: savedSizes, themes, closed: closedSettings } = settings.use();
  // Resize mode (ClosedResize.tsx): the closed shape shows grips instead of its parts and neither opens nor moves; a grip's drag draws at once.
  const editing = closedEdit.use();
  const liveSize = closedLive.use();
  const sizes = liveSize ? { ...savedSizes, ...liveSize } : savedSizes;
  // Window rules (display.rs): "line" turns the closed look into the idle line, "hide" means Rust hid the window.
  const screenBehavior = screen.use();
  // The resize mode changes the chosen look, not the line a window rule turned it into for now.
  const idleStyle = editing ? displaySettings.idleStyle : effectiveIdleStyle(displaySettings.idleStyle, screenBehavior);
  // Focus mode as a line: no live activity, no dots, only the thin strip at the edge.
  const line = focus && displaySettings.focusStyle === "line";
  // Line as the normal closed look: hover and click work as usual, but nothing shows
  // while closed but the song's progress. Only an urgent notice opens it into the notch, until answered or for its time:
  // a finished timer, a due to-do reminder (the user asked to be told at that time), a running recording (its stop button stays in reach) or a status alert.
  // Each store hook runs on every render: chained with || a finished timer skipped the other two and broke the hook order.
  const timerFinished = timer.use().finished;
  const tasksDue = dueTasks.use().length > 0;
  const recordingOn = recording.use().phase !== "idle";
  // A crest-notify ask: a coding agent waits on the answer.
  const asking = asks.use().length > 0;
  const urgent = timerFinished || tasksDue || recordingOn || asking;
  const statusOn = statusAlert.use() !== null;
  const idleLine = !focus && idleStyle === "line";
  const alert = idleLine && (urgent || statusOn);
  // Plugin tools exist once their list has been read.
  plugins.use();
  const visible = toolSettings.filter((t) => t.enabled).map((t) => findTab(t.id)).filter((t): t is NotchTab => !!t);
  const { tabId } = nav.use();
  // Hidden tool active (e.g. just disabled) → first visible one.
  const tab = pageTabs.find((t) => t.id === tabId) ?? visible.find((t) => t.id === tabId) ?? visible[0] ?? tabs[0];
  // Header actions follow the tool on screen (header.tsx).
  useLayoutEffect(() => {
    activeTool.set(tab.id);
  }, [tab.id]);
  const np = useNowPlaying();
  const live = useLiveActivity();
  const accent = useThemedAccent(np?.accent);
  const closedInk = useClosedInk(np?.accent);
  const tinted = themes.coverTint && !!np?.artwork;

  // Like the Dynamic Island: opening jumps to the running activity's tool,
  // but only after a pause. Closed briefly (copying a key, grabbing a file) → you
  // land where you were, e.g. in the settings.
  // Layout effect runs before paint → no frame with the old tab size.
  const prevStatus = useRef(status);
  const closedAt = useRef(0);
  // A target tool from the tray (settings entry) or a clicked notice takes priority over the live activity.
  const trayTab = useRef<string | null>(null);
  // The closed-row part last under the pointer: the hover that opens the notch over it opens its tool.
  const pointed = useRef<{ tool: string | null; at: number }>({ tool: null, at: 0 });
  /**
   * The tool of the closed-row part at a point (data-open, CompactRow), when that tool is in the tool bar. Every element there is looked
   * at, not only the top one: the panel fading out after a close still lies over the row for a moment. A row covered by a notice is
   * skipped: a click on the notice is the notice's own (What's new opens its page, not the Hardware readings under it).
   */
  const partTarget = (e: { clientX: number; clientY: number }) => {
    const part = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest("[data-open]") && !el.closest("[data-covered]"));
    const tool = part?.closest("[data-open]")?.getAttribute("data-open");
    return tool && visible.some((t) => t.id === tool) ? tool : null;
  };
  // Natively the page sees no pointermove until the window stops letting the pointer through, after the hover: Rust says where it came in.
  const partTargetRef = useRef(partTarget);
  partTargetRef.current = partTarget;
  useEffect(() => onNativeHoverAt((x, y) => (pointed.current = { tool: partTargetRef.current({ clientX: x, clientY: y }), at: Date.now() })), []);
  useLayoutEffect(() => {
    if (status === "open" && prevStatus.current !== "open") {
      const resumed = Date.now() - closedAt.current < RESUME_MS;
      const startTab = settings.get().startTab;
      const home = startTab && visible.some((t) => t.id === startTab) ? startTab : null;
      const pointedTool = Date.now() - pointed.current.at < POINTED_MS ? pointed.current.tool : null;
      // The quota rings sit in the middle of the closed row, so with a start tool chosen the pointer crossing them does not decide:
      // a click on them still opens AI usage.
      const hovered = home && pointedTool === "usage" ? null : pointedTool;
      const target = trayTab.current ?? takeOpenTarget() ?? hovered;
      const liveTool = live.id && visible.some((t) => t.id === live.id) ? live.id : null;
      // Music is the one activity that only plays in the background: it does not outrank the start tool.
      const landing = liveTool && !(liveTool === "media" && home) ? liveTool : home;
      if (target) navigate(target);
      // A fresh install opens on the setup until it is finished or skipped.
      else if (!settings.get().setup.done) navigate(setupTab.id);
      else if (!resumed && landing) navigate(landing);
      trayTab.current = null;
    }
    if (status !== "open" && prevStatus.current === "open") closedAt.current = Date.now();
    prevStatus.current = status;
  });

  useQuickDrop(status, open, dismiss);

  const override = sizeOverride.use();
  const toolSize = useToolSize(tab.id, tab.size);
  // A tool's own runtime request (e.g. the clipboard's image preview) wins over the dragged size.
  const overridden = override?.tabId === tab.id;
  // Held to the monitor like a saved size is.
  const size = overridden ? { w: override.w, h: Math.min(override.h, limits(tab.size, monitorMetrics().height).maxH) } : toolSize;
  // The idle line never passes through the small notch: line → slightly bigger line on
  // hover → open, and straight back to the line on close.
  const lineIdle = idleLine && !alert;
  const style = line ? "line" : idleStyle;
  const surface = style === "capsule" ? "capsule" : "notch";
  // The row is on screen closed or peeking, not as a line, not in focus mode, not while Rust hides the window for a window rule.
  const hiddenForFullscreen = screenBehavior === "hide";
  const showRow = status !== "open" && !line && !idleLine && !focus && !hiddenForFullscreen && !editing;
  // Content width of the closed row, as it last reported it (kept while open, so closing goes straight to it).
  const [rowWidth, setRowWidth] = useState(0);
  // Notices cover the row; on the idle line and in dimmed focus mode only urgent ones show (timer, reminder, and on the line a status alert). While one shows the shape takes its width.
  // The capsule snaps with its closed shape, read when a drag moves (closedW and closedH are set below).
  const drag = useDragToMove(status, () => closedGeometry(surface, closedW, closedH));
  // The edge it hangs from (the capsule floats on the top frame); on a side edge the row stands as a column, which shows notices as an icon line.
  const edge = edgeOf(style, drag.dock);
  const side = across(edge);
  const noticeTime = status !== "open" && (showRow || alert || (urgent && !line && !hiddenForFullscreen));
  const showNotices = !side && noticeTime && !editing;
  // On the idle line or dimmed, only an urgent notice brings the column up: its icon alone, so the shape always has something to click.
  const showColumn = side && noticeTime && !editing;
  const [noticeSize, setNoticeSize] = useState<{ width: number; height: number } | null>(null);
  const notice = showNotices ? noticeSize : null;
  // The chosen size (collapsed.ts): the content is drawn at the height over its designed 30, the width is a minimum the content widens,
  // and the monitor along the edge only narrows what is drawn. On a side edge the height is the column's depth, the width its length.
  monitor.use(); // the span, windowY and the bridge read the monitor's size and work area
  monitors.use(); // with "All monitors" the span is the narrowest one's
  const area = dragArea(), span = sharedSpan(side ? area.height : area.width, side);
  const closedH = surface === "capsule" ? sizes.capsuleHeight : sizes.notchHeight, scale = contentScale(closedH);
  const closedW = surfaceWidth(surface, notice?.width ?? (showRow || status === "open" ? rowWidth : 0), surface === "capsule" ? sizes.capsuleWidth : sizes.notchWidth, scale, span);
  // A notice card (NoticeCard.tsx) is taller than the row: the closed shape grows to it, drawn at the same content scale.
  const shapeH = notice ? Math.max(closedH, notice.height * scale) : closedH;
  const [column, setColumn] = useState({ length: 0, width: 0, notice: false });
  const columnShows = showColumn || status === "open";
  const sideSize = side ? columnSurface(columnShows ? column.length : 0, columnShows ? column.width : 0, scale, sideLength(sizes.notchWidth), span) : null;

  // Natively the window sits at windowY and the capsule drag.y below the monitor's top; in the browser the
  // viewport stands in for the monitor and the window is only imagined, so the same rules place the panel.
  const workTop = monitorMetrics().workTop;
  const capY = capsuleY(drag.y, sizes.capsuleHeight, isNative ? monitorMetrics().height : window.innerHeight);
  const bridged = hasBridge(style, capY, workTop);
  const winTop = isNative ? windowY(capY) : windowYFor(style, capY, window.innerHeight, workTop);
  const capsuleTop = style === "capsule" ? capY - winTop : 0;
  const lineShape = line || (lineIdle && status !== "open");
  // Open, a bridged capsule hangs from the edge like the notch; a floating one opens from its top, moved up as far as the panel needs (a notice card the same, so it stays in the window).
  // The line's distance from the edge is a place on the screen, saved at 100 % like display.y.
  const shapeTop = status !== "open" ? (lineShape ? toPageCss(sizes.lineTop, behavior.scale) : notice ? panelTop(capsuleTop, shapeH) : capsuleTop) : bridged ? 0 : panelTop(capsuleTop, size.h);
  const top = (isNative ? 0 : winTop) + shapeTop;

  const shape = lineShape
    ? lineGeometry(Math.min(sizes.lineLength, span), sizes.lineThickness, sizes.lineTop > 0, !line && status === "peek")
    : shapeFor(status, surface, closedW, shapeH, size, !bridged, sideSize);
  const tightHit = lineShape && !editing;
  // On a side edge the open panel reaches across the screen as far as the page is wide.
  const sticky = useStickyHitZone(status, side ? size.w : size.h, edge);
  const transition = useTransitionFor(status, shape);
  const topValue = useSpringTop(top, transition, drag.dragging);
  // The pet's nest stands beside the closed shape, its top a little below the shape's (topValue: as padding or margin, the shape's top).
  const pet = closedSettings.pet;
  const nestShown = !!pet.id && status !== "open" && !lineShape && !hiddenForFullscreen && !editing && !focus;
  const nestTop = useTransform(topValue, (v) => v + 4);

  // "Follow the cursor" and "All monitors" (monitor.ts) move the notch only while it is closed, not dragged and not recording.
  const busy = status !== "closed" || drag.dragging || recordingOn;
  useEffect(() => notchBusy.set(busy), [busy]);
  // "All monitors": the copies on the other monitors draw the closed notch as it is here.
  const rootRef = useRef<HTMLDivElement>(null);
  useMirror(rootRef, status === "closed" && screenBehavior === "normal");

  // Click outside closes (in the browser the fake desktop, in Tauri the window blur).
  const hitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      // A select menu is portaled into the body (controls.tsx) but belongs to the notch.
      if (!hitRef.current?.contains(target) && !target.closest?.("[data-notch-menu]")) dismiss();
    };
    window.addEventListener("pointerdown", onDown);
    const offBlur = onNativeBlur(dismiss);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      offBlur();
    };
  }, [dismiss]);

  // Hover stays off in focus mode (a card there takes the pointer, see below) and while a question waits, or the card would vanish under the pointer.
  // Open, the enter still has to run: it cancels the close timer a leave started.
  const hoverOff = editing || focus || (asking && status !== "open");
  useNativeBridge(hitRef, topValue, hoverOff ? NOOP : onPointerEnter, onPointerLeave, edge);
  // Focus mode is click-through, except while a card with buttons shows (a question, a finished timer, a reminder, the recording): its buttons need the pointer.
  useEffect(() => setPassthrough(focus && !noticeTime), [focus, noticeTime]);
  // Starting the resize mode from the settings closes the panel onto the closed shape it changes.
  useEffect(() => {
    if (editing) close();
  }, [editing, close]);

  // Focus mode on → notch closes, no more hover.
  useEffect(() => {
    if (focus) close();
  }, [focus, close]);

  // Three quick clicks toggle focus mode (in the browser also off; natively Rust counts).
  const onClick = (e: React.MouseEvent) => {
    if (drag.moved() || editing) return;
    if (e.detail >= FOCUS_CLICKS && !isInteractive(e.target)) return setFocusMode(!focus);
    if (focus || status === "open") return;
    // A click on a part of the closed row opens its tool (a click elsewhere, as usual).
    const part = partTarget(e);
    if (part) openOn(part);
    else open();
  };

  /** Opens on `tab` (null = as usual). */
  const openOn = (tab: string | null) => {
    // Only remember it while opening, otherwise it would stick for the next open.
    trayTab.current = status === "open" ? null : tab;
    if (tab) navigate(tab);
    open();
  };

  // Right click on the notch opens the settings; text fields keep their menu.
  const onContextMenu = (e: React.MouseEvent) => {
    if (!behavior.rightClickSettings || focus || editing || isTextField(e.target) || drag.moved()) return;
    openOn(settingsTab.id);
  };

  // The wheel over the open panel switches tools, one step per gesture, unless something under the pointer scrolls or took it.
  const wheelAt = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (status !== "open" || !behavior.wheelTools || pageTabs.includes(tab)) return;
    if (e.nativeEvent.defaultPrevented || wheelTaken(e.target, e.currentTarget, e.deltaX, e.deltaY)) return;
    const now = performance.now(), quiet = now - wheelAt.current > 350;
    wheelAt.current = now;
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const next = quiet && delta !== 0 ? cycle(visible.map((t) => t.id), tab.id, delta > 0 ? 1 : -1) : null;
    if (next) navigate(next);
  };

  // Shortcut: opening takes focus (Esc, typing), closing gives it back.
  useEffect(() => onShortcut(() => toggle() === "open" && keyboardFocus(true)), [toggle]);
  useEffect(
    () =>
      onTrayOpen((tab) => {
        openOn(tab);
        keyboardFocus(true);
      }),
    [open, status],
  );
  // Find on screen: opening the page reads the screens; pressed again while it is open, it reads them again.
  useEffect(
    () =>
      windowShell.onFindKey(() => {
        if (status === "open" && tab.id === findOnScreenTab.id) scanScreens();
        else openOn(findOnScreenTab.id);
        keyboardFocus(true);
      }),
    [open, status, tab],
  );
  // Resize shortcut: each arrow press resizes the open tool; while closed the first press opens it.
  useEffect(
    () =>
      windowShell.onResizeKey((dir) => {
        if (status !== "open") {
          open();
          keyboardFocus(true);
        } else if (!overridden) stepToolSize(tab.id, tab.size, dir);
      }),
    [open, status, tab, overridden],
  );
  useEffect(() => {
    if (status === "closed") keyboardFocus(false);
    // A day/night change missed in sleep or across a clock shift shows up on the next open.
    if (status === "open") refreshTheme();
  }, [status]);

  // Closed for a while → WebView2 may trim memory; back to normal on the first touch
  // (peek), so the hover delay covers paging it back in before the notch opens.
  useEffect(() => {
    if (status !== "closed") return setMemoryLow(false);
    const id = window.setTimeout(() => setMemoryLow(true), MEMORY_LOW_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  // 1–9 switches tools while open and not typing.
  useEffect(() => {
    if (status !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const tab = visible[Number(e.key) - 1];
      if (!tab) return;
      // Else the digit lands in the field the new tool focuses.
      e.preventDefault();
      navigate(tab.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, visible]);

  // Off the top edge everything below is drawn in the edge's frame (edge.ts): as long as the window along the edge, mapped onto it.
  const frame = frameCss(edge, isNative ? windowLine(edge) : viewLine(drag.dock));
  const slide = isNative ? undefined : `translateX(${drag.offset}px)`;
  return (
    <div
      ref={rootRef}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center transition-opacity duration-200"
      // In the browser the notch moves inside the window; natively the whole window moves (display.rs).
      style={{
        ["--accent" as string]: accent,
        opacity: focus && !line ? 0.5 : 1,
        transform: frame ? [frame, slide].filter(Boolean).join(" ") : slide,
        ...(frame && { right: "auto", width: isNative ? windowLength(drag.dock) : side ? window.innerHeight : window.innerWidth, transformOrigin: "0 0" }),
      }}
    >
      {/* Hit zone: bigger than the visible shape (Fitts) and flush with the top edge, unless the capsule floats. */}
      <motion.div
        ref={hitRef}
        data-notch-hit
        // The line is meant to stay out of the way: only a hair of extra hit zone, so
        // the cursor has to be on it (the normal notch gets the generous Fitts margin).
        // In resize mode the zone reaches below the shape, over its size and the Done button.
        className={`pointer-events-auto relative ${tightHit ? "px-1 pb-1" : editing ? (side ? "px-6 pb-28" : "px-6 pb-12") : "px-4 pb-3"}`}
        // Bridged, the strip up to the screen edge is part of the zone (pushing the pointer up opens it); floating, only the capsule is (CollapsedHover.cs).
        style={{ minHeight: sticky.minHeight, cursor: drag.dragging ? "grabbing" : undefined, paddingTop: bridged ? topValue : 0, marginTop: bridged ? 0 : topValue }}
        onPointerMove={(e) => {
          visited();
          sticky.onPointerMove(e);
          if (status !== "open") pointed.current = { tool: partTarget(e), at: Date.now() };
        }}
        onPointerDown={focus || editing ? undefined : drag.onPointerDown}
        // In Tauri, hover comes from the Rust poll (useNativeBridge), not the DOM.
        onPointerEnter={isNative || hoverOff ? undefined : onPointerEnter}
        onPointerLeave={() => {
          pointed.current = { tool: null, at: 0 };
          if (!isNative && !focus) onPointerLeave();
        }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
      >
        <NotchShape geometry={shape} transition={transition} elevated={status === "open"} edge={edge} thin={lineShape}>
          {/* The closed parts keep the dark tokens on the black notch whatever the theme (src/features/themes), and their order on screen in any language. */}
          <div data-theme-ink dir="ltr" className="contents" style={closedInk}>
            {/* Laid out at their designed size and drawn at the content scale, from the edge (the column from its centre). */}
            <div className="absolute inset-0" style={{ transform: `scale(${scale})`, transformOrigin: side ? "50% 50%" : "50% 0" }}>
              <AnimatePresence>
                {side
                  ? showColumn && <CompactColumn key="column" parts={showRow} room={columnRoom(scale, span)} onSize={setColumn} />
                  : showRow && <CompactRow key="row" room={rowRoom(surface, scale, span)} scale={scale} covered={notice !== null} onWidth={setRowWidth} />}
              </AnimatePresence>
              {/* The notch's insets are the larger ones, so a notice fits either surface. */}
              <AnimatePresence>{showNotices && <NoticeLayer key="notices" max={rowRoom("notch", scale, span)} scale={scale} onSize={setNoticeSize} urgentOnly={!showRow} />}</AnimatePresence>
              {/* Closed, the dots are the row's last part; dimmed for focus there is no row, and under a notice the row is faded out, so they stand on their own (beside the notice, in the shape's inset). */}
              {(focus || (showRow && notice)) && status !== "open" && !line && (
                <PrivacyDots centered={side} beside={!focus && notice ? notice.width / 2 + (surface === "capsule" ? ROW.insetCapsule : ROW.insetNotch) / 2 : undefined} />
              )}
            </div>
            {lineIdle && status !== "open" && !hiddenForFullscreen && <LineProgress along={side ? "y" : "x"} />}
          </div>
          {editing && status !== "open" && <ClosedResize style={style} edge={edge} widest={span} />}
          {/* Open they stand in the header. */}
          {status === "open" && !line && !idleLine && <PrivacyDots />}

          <AnimatePresence>
            {status === "open" && (
              <motion.div
                key="open"
                data-open-panel
                // Anchored at the edge it hangs from, so it stays put while the shape grows from there.
                className={`absolute isolate flex flex-col ${PANEL_ANCHOR[edge]}`}
                style={{ width: size.w, height: size.h, ...(side ? { marginTop: -size.h / 2 } : { marginLeft: -size.w / 2 }) }}
                // No scale here: scaling re-rasterizes the small dock icons at shifting subpixels every frame, which reads as jitter (issue #3).
                // No blur either: blurring the whole panel cost a 50-70 ms frame on every open in WebView2 at 200 %.
                initial={{ opacity: 0, transform: SLIDE_IN[edge] }}
                animate={{ opacity: 1, transform: "translate(0px, 0px)", transition: content.enter }}
                exit={{ opacity: 0, transform: SLIDE_OUT[edge], transition: content.exit }}
              >
                {/* Below the content (-z-10 in the panel's own stacking context), so it never sits over text. */}
                <div aria-hidden data-ambience={tinted ? "on" : "off"} className="pointer-events-none absolute inset-0 -z-10" style={tinted ? { ["--ambience" as string]: accent } : undefined} />
                <Header title={t(tab.label)} />
                <div className="relative min-h-0 flex-1 overflow-clip">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={tab.id}
                      className="absolute inset-0"
                      // A plain crossfade: a blur over a whole tool dropped a frame on most switches.
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1, transition: content.enter }}
                      exit={{ opacity: 0, transition: content.exit }}
                    >
                      <ToolScope.Provider value={tab.id}>
                        <tab.View />
                      </ToolScope.Provider>
                    </motion.div>
                  </AnimatePresence>
                </div>
                <Dock tabs={visible} activeId={tab.id} />
                {/* The grips and their sizes assume a panel hanging from the top edge. */}
                {!overridden && edge === "top" && <ResizeHandles id={tab.id} def={tab.size} size={size} />}
              </motion.div>
            )}
          </AnimatePresence>
        </NotchShape>

        {editing && status !== "open" && <ClosedResizeBar style={style} edge={edge} />}
      </motion.div>
      {/* The pet's nest, beside the shape and outside its hit zone. */}
      <AnimatePresence>
        {nestShown && pet.id && <Nest key="nest" pet={{ ...pet, id: pet.id }} edge={edge} top={nestTop} shapeWidth={shape.w} shapeTransition={transition} notice={notice !== null || (showColumn && column.notice)} hovered={status === "peek"} />}
      </AnimatePresence>
    </div>
  );
}

/** Where the open panel sits in the upright shape, per edge. */
const PANEL_ANCHOR: Record<Edge, string> = { top: "top-0 left-1/2", bottom: "bottom-0 left-1/2", left: "left-0 top-1/2", right: "right-0 top-1/2" };
/** The panel comes out of its edge and goes back into it (upright, i.e. screen, axes). */
const SLIDE_IN: Record<Edge, string> = { top: "translate(0px, -6px)", bottom: "translate(0px, 6px)", left: "translate(-6px, 0px)", right: "translate(6px, 0px)" };
const SLIDE_OUT: Record<Edge, string> = { top: "translate(0px, -4px)", bottom: "translate(0px, 4px)", left: "translate(-4px, 0px)", right: "translate(4px, 0px)" };

/** The song's progress along the idle line, as thick as the line: moved once a second with a 1 s linear transition, only while playing. `along`: the upright axis the edge runs on. */
function LineProgress({ along }: { along: "x" | "y" }) {
  const on = settings.use().closed.lineProgress;
  const np = useNowPlaying();
  const playing = on && !!np?.isPlaying && np.duration > 0;
  useSecondTick(playing);
  if (!playing || !np) return null;
  const f = Math.min(1, Math.max(0, livePosition(np) / np.duration));
  return (
    <span
      aria-hidden
      className={`absolute inset-0 bg-accent ${along === "x" ? "origin-left" : "origin-top"}`}
      style={{ transform: along === "x" ? `scaleX(${f})` : `scaleY(${f})`, transition: "transform 1s linear" }}
    />
  );
}

/** Header: tool title on the left, actions + pin on the right. The middle (camera) stays free. */
function Header({ title }: { title: string }) {
  const isPinned = pinned.use();
  return (
    // Empty header space = drag handle; the hit zone around it starts the drag (one handler, or two drags would run).
    <div data-drag-handle className="flex shrink-0 items-center justify-between gap-3 ps-5 pe-3" style={{ height: HEADER_HEIGHT + 4 }}>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <div className="relative min-w-0 shrink-0">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.h2
              key={title}
              className="truncate text-title font-semibold"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
              exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
            >
              {title}
            </motion.h2>
          </AnimatePresence>
        </div>
        {/* A tool's own choices next to the title (<HeaderLead>). On a Mac with a camera it stops short of the middle. */}
        <div ref={(el) => leadSlot.set(el)} className={`grid min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] ${isMac ? "max-w-[190px]" : ""}`} />
      </div>
      <div className="flex items-center gap-1">
        {/* Tools render here via <HeaderActions> (src/notch/header.tsx). The grid stacks old and new during a switch. */}
        <div ref={(el) => headerSlot.set(el)} className="grid" />
        <HeaderButton label={t("Fokus-Modus (3× klicken zum Beenden)")} onClick={() => setFocusMode(true)}>
          <Selection size={14} weight="bold" />
        </HeaderButton>
        <HeaderButton label={isPinned ? t("Lösen") : t("Offen halten")} active={isPinned} onClick={togglePin}>
          <PushPin size={14} weight={isPinned ? "fill" : "bold"} />
        </HeaderButton>
      </div>
    </div>
  );
}

/** Tool bar at the bottom (like OmniNotch). The gear at the end toggles between settings and the last tool. */
function Dock({ tabs, activeId }: { tabs: NotchTab[]; activeId: string }) {
  const lastTool = useRef(tabs[0]?.id);
  if (!pageTabs.some((p) => p.id === activeId)) lastTool.current = activeId;
  const inSettings = activeId === settingsTab.id;
  const updateReady = update.use().phase === "available";
  // Dot on the gear = update ready or unseen changes → jump straight to that section.
  const unseen = useUnseen().length > 0;
  const badge = updateReady || unseen;
  const agentsWait = useAgentsNeedYou();

  // A strip of its own: buttons share its width up to 42 px each and never go below 24 px (WCAG target size), so a crowded dock
  // scrolls. The gear stays outside the scrolling part, always in reach, and a fade marks the side with more tools.
  const strip = useRef<HTMLDivElement>(null);
  const more = useScrollEdges(strip);
  const fade = more.start || more.end ? `linear-gradient(90deg, ${more.start ? "transparent, #000 20px" : "#000"}, ${more.end ? "#000 calc(100% - 20px), transparent" : "#000"})` : undefined;
  return (
    <div className="flex shrink-0 items-start justify-center px-3 pt-1" style={{ height: DOCK_HEIGHT }}>
      <div className="flex h-10 max-w-full items-center rounded-[14px] bg-fill-2 p-0.5">
        <div ref={strip} className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" style={{ maskImage: fade, WebkitMaskImage: fade }}>
          {tabs.map((tab) => (
            <DockButton key={tab.id} label={t(tab.label)} icon={tab.icon} hue={tab.hue} active={tab.id === activeId} badge={tab.id === "agents" && agentsWait} onClick={() => switchTo(tab.id)} />
          ))}
        </div>
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        <DockButton
          label={t(settingsTab.label)}
          icon={GearSix}
          active={inSettings}
          badge={badge}
          onClick={() => {
            stayUntilVisit();
            if (inSettings) navigate(lastTool.current ?? tabs[0].id);
            else navigate(settingsTab.id, badge ? "updates" : null);
          }}
        />
      </div>
    </div>
  );
}

/** A tool picked in the dock: the new panel may be smaller and leave the pointer outside it, which must not close the notch. */
function switchTo(id: string) {
  stayUntilVisit();
  navigate(id);
}

/** Whether a horizontal strip has more to scroll to at its start and its end (either direction of writing). */
function useScrollEdges(ref: RefObject<HTMLDivElement | null>) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      // Right to left, scrollLeft runs from 0 down to negative values.
      const pos = Math.abs(el.scrollLeft);
      const room = el.scrollWidth - el.clientWidth;
      const next = { start: pos > 1, end: room - pos > 1 };
      setEdges((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const size = new ResizeObserver(read);
    size.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      size.disconnect();
    };
  }, [ref]);
  return edges;
}

function DockButton(props: { label: string; icon: NotchTab["icon"]; hue?: Hue; active: boolean; onClick: () => void; badge?: boolean }) {
  const I = props.icon;
  const color = useHue(props.hue);
  const ref = useRef<HTMLButtonElement>(null);
  // A key shortcut can pick a tool scrolled out of the dock's view.
  useEffect(() => {
    if (props.active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.active]);
  return (
    <button
      ref={ref}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={`pressable relative flex h-9 w-[42px] min-w-6 shrink items-center justify-center rounded-[12px] transition-colors duration-150 ${
        props.active ? "text-label" : color ? "" : "text-label-2 hover:text-label"
      }`}
      style={color ? { color } : undefined}
    >
      {/* The current tool: a brighter pill with a mark under the icon, sliding from tool to tool. */}
      {props.active && (
        <motion.span layoutId="dock-pill" className="absolute inset-0 rounded-[12px] bg-fill-3" transition={springs.snappy}>
          <span className="absolute bottom-[3px] left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-label" />
        </motion.span>
      )}
      <I size={18} weight={props.active ? "fill" : "bold"} className="relative" />
      {/* Badge dot (e.g. update available) at the icon's top right. */}
      <AnimatePresence>
        {props.badge && (
          <motion.span
            className="absolute top-[6px] left-1/2 ml-[4px] size-[7px] rounded-full bg-link ring-2 ring-notch"
            initial={{ opacity: 0, transform: "scale(0.9)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.9)" }}
            transition={springs.snappy}
          />
        )}
      </AnimatePresence>
    </button>
  );
}

/**
 * With the dock at the bottom, a shorter tool moves it up, so the cursor would
 * suddenly be outside and the notch would close. So the hit zone only shrinks
 * once the cursor is back over the shape (or the notch closes).
 * Applies natively too: Rust gets this zone's rectangle.
 */
function useStickyHitZone(status: NotchStatus, height: number, edge: Edge) {
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  const prev = useRef(height);
  useLayoutEffect(() => {
    if (status !== "open") setMinHeight(undefined);
    else if (height < prev.current) {
      const from = prev.current + HIT_PAD_BOTTOM;
      setMinHeight((m) => Math.max(m ?? 0, from));
    }
    prev.current = height;
  }, [status, height]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (minHeight === undefined) return;
    // Measured away from the edge it hangs from: on top that is the client y below the zone's top.
    if (pointerIn(edge, e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY).depth < height) setMinHeight(undefined);
  };
  return { minHeight, onPointerMove };
}

/** pb-3 of the hit zone. */
const HIT_PAD_BOTTOM = 12;

/** `w` and `h` are the closed size; the hover nudge grows from it, so it also fits the live state. `side`: the column's closed shape on a side edge, where the open page lies across the frame. */
function shapeFor(status: NotchStatus, surface: "notch" | "capsule", w: number, h: number, size: { w: number; h: number }, floating: boolean, side: { w: number; h: number } | null): NotchGeometry {
  if (side) return status === "open" ? openGeometry(size.h, size.w) : columnGeometry(side.w, side.h, status === "peek");
  if (status === "open") return openGeometry(size.w, size.h, floating);
  return status === "peek" ? peekGeometry(surface, w, h) : closedGeometry(surface, w, h);
}

/** The shape's top in the wrapper as a value that springs with the shape, and follows the pointer while dragging. */
function useSpringTop(top: number, transition: Transition, dragging: boolean): MotionValue<number> {
  const value = useMotionValue(top);
  useEffect(() => {
    if (dragging) return value.jump(top);
    const c = animate(value, top, { ...transition, restDelta: 0.01, restSpeed: 0.1 });
    return () => c.stop();
  }, [top, transition, dragging, value]);
  return value;
}

/** Picks the spring for the transition (open ≠ close ≠ morph). */
function useTransitionFor(status: NotchStatus, shape: NotchGeometry): Transition {
  const prev = useRef(status);
  const key = `${shape.w}x${shape.h}x${shape.r}x${shape.ear}x${shape.rt}`;
  const prevKey = useRef(key);

  let t: Transition;
  if (status === "open") t = prev.current === "open" ? springs.morph : springs.open;
  else if (status === "peek") t = springs.peek;
  else t = prev.current === "open" ? springs.close : springs.morph;

  // Only switch when the shape actually changes, otherwise the running spring continues.
  const stable = useRef(t);
  if (prevKey.current !== key) stable.current = t;

  useEffect(() => {
    prev.current = status;
    prevKey.current = key;
  });

  return stable.current;
}

/**
 * Quick drop: drag files over the notch and it opens on the Shelf, ahead of a live activity.
 * A cancelled drag closes it again if it only opened for that. With the Shelf off nothing takes files:
 * the drag is ignored and a drop forgotten, so it cannot turn up when the Shelf is switched on later.
 */
function useQuickDrop(status: NotchStatus, open: () => void, dismiss: () => void) {
  const openedByDrag = useRef(false);
  const holding = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  // A native drop sets dragging false before its paths arrive (platform/drop.ts), so closing waits a moment for them.
  const closing = useRef(0);

  useEffect(
    () => {
      const off = drop.subscribe(() => {
        const { dragging, dropped } = drop.get();
        if (dragging || dropped) window.clearTimeout(closing.current);
        if (!findTab("shelf") || !settings.get().tools.some((t) => t.id === "shelf" && t.enabled)) {
          if (dropped) takeDropped();
          return;
        }
        if (dragging && !holding.current) {
          holding.current = true;
          holdOpen(true);
          if (statusRef.current !== "open") {
            openedByDrag.current = true;
            open();
          }
          if (nav.get().tabId !== "shelf") openOn("shelf");
        } else if (!dragging && holding.current) {
          // Drag over: dropped → stay open, cancelled → close again.
          holding.current = false;
          holdOpen(false);
          if (!dropped && openedByDrag.current) closing.current = window.setTimeout(dismiss, DROP_WAIT_MS);
          openedByDrag.current = false;
        }
      });
      return off;
    },
    [open, dismiss],
  );
}

/**
 * Link to the native shell: reports the hit zone to Rust (click-through), receives
 * hover from the Rust poll and keeps the window clickable while typing.
 */
function useNativeBridge(
  hitRef: RefObject<HTMLDivElement | null>,
  top: MotionValue<number>,
  onEnter: () => void,
  onLeave: () => void,
  // Another edge moves the zone by a transform, which the observer doesn't see either: the effect runs again and reports it.
  edge: Edge,
) {
  useEffect(() => {
    const el = hitRef.current;
    if (!isNative || !el) return;

    // The shape's size is animated by a spring → ResizeObserver fires every frame.
    const report = () => {
      const r = el.getBoundingClientRect();
      setHitRect({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    // Moving the capsule changes padding or margin, which the observer doesn't see; measured after Motion has rendered the new value.
    const offTop = top.on("change", () => frame.postRender(report));

    const offHover = onNativeHover((inside) => (inside ? onEnter() : onLeave()));
    // Text field focused → hold (clickable, no collapse) until focus leaves.
    let typing = false;
    const onFocusIn = (e: FocusEvent) => {
      if (isTextField(e.target) && !typing) holdOpen((typing = true));
    };
    const onFocusOut = (e: FocusEvent) => {
      if (typing && !isTextField(e.relatedTarget)) holdOpen((typing = false));
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);

    return () => {
      ro.disconnect();
      offTop();
      offHover();
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      if (typing) holdOpen(false);
    };
  }, [hitRef, top, onEnter, onLeave, edge]);
}

function isInteractive(el: EventTarget | null): boolean {
  return el instanceof Element && !!el.closest("button, input, textarea, a, [role=slider], [role=button], [role=radio], [role=switch], [role=option], [role=tab], [data-no-drag]");
}

function isTextField(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
