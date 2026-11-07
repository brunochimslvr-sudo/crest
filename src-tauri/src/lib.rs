mod agents;
pub mod ai;
#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod banners;
#[cfg(windows)]
mod brightness;
mod calendar;
#[cfg(windows)]
mod camera;
#[cfg(windows)]
mod capture;
mod clipboard;
#[cfg(windows)]
mod controls;
#[cfg(windows)]
mod quick;
pub mod convert;
#[cfg(windows)]
mod discord;
// On a Mac these keep parts only Windows reads yet (screen rules, mirrors, the launcher keys).
#[cfg_attr(not(windows), allow(dead_code))]
mod display;
// Only Windows watches the folder yet; the Mac keeps the command as a no-op.
#[cfg_attr(not(windows), allow(dead_code))]
mod downloads;
#[cfg(windows)]
mod drop;
#[cfg(windows)]
mod fps;
mod github;
mod hit_test;
mod idle;
#[cfg(windows)]
mod loopback;
mod lyrics;
#[cfg(windows)]
mod launcher;
#[cfg(windows)]
mod media;
#[cfg(windows)]
mod media_pick;
#[cfg(windows)]
mod memory;
#[cfg(windows)]
mod mirror;
#[cfg(windows)]
mod mixer;
#[cfg(windows)]
mod notices;
mod notify_wire;
#[cfg(windows)]
mod osd;
mod plugins;
pub mod portable;
mod ports;
#[cfg(windows)]
mod power;
#[cfg(windows)]
mod privacy;
mod phone_share;
mod romanize;
mod standby;
mod translate;
#[cfg_attr(not(windows), allow(dead_code))]
mod screen_policy;
pub mod secrets;
#[cfg(windows)]
mod shelf;
#[cfg_attr(not(windows), allow(dead_code))]
mod shell;
mod startup;
#[cfg(windows)]
mod system;
#[cfg(windows)]
mod sysevents;
mod timer_window;
#[cfg(windows)]
mod terminal;
mod themes;
mod trading;
pub mod usage;
#[cfg(windows)]
mod vault;
mod mic;
mod sharing;

// The Mac's own versions of what the shared modules call into (src/macos/); the other Windows modules have no Mac
// counterpart yet and their tools are hidden there.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::{audio, media, mirror};

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, State, WebviewWindow};
#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

/// Milliseconds since 1970 (0 if the clock is before it).
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A failed request as the frontend's error codes.
pub(crate) fn net_error(e: reqwest::Error) -> String {
    if e.is_timeout() || e.is_connect() { "offline" } else { "failed" }.into()
}

/// Temp file, flushed to disk, then renamed: a crash or a power cut leaves the old file whole.
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&tmp, path)
}

/// Crest's windows only ever show its own pages: a dropped link or a script must not navigate one elsewhere, above all
/// not to a plugin page, which as the top frame would get the app's commands. Plugins run in their iframe (on Windows
/// this check only sees the top frame; on a Mac it sees frames too, where plugins don't load anyway).
pub(crate) fn own_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => url.host_str() == Some("tauri.localhost") || (cfg!(debug_assertions) && url.host_str() == Some("localhost")),
        _ => false,
    }
}

/// The notch window may call every command; the timer and the mirror windows only what they need. Tauri lets every
/// local window call every app command (the capabilities only cover plugins and core), so a bug in one of them would
/// otherwise reach the vault or the terminal.
fn command_allowed(window: &str, command: &str) -> bool {
    match window {
        "notch" => true,
        "timer" => command == "timer_window_close",
        w if w.starts_with("mirror-") => command == "mirror_picture",
        _ => false,
    }
}

/// Opens a web or store link, or a file, in its default handler. Not through Explorer: it reads an address with `?a=1&b=2`
/// or a file name with a comma as something else and opens Documents instead.
pub(crate) fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::{w, HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        // Above 32 is success (the old HINSTANCE convention).
        let ok = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) }.0 as isize > 32;
        if ok { Ok(()) } else { Err("open-failed".into()) }
    }
    #[cfg(not(windows))]
    opener().arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens files and folders: Explorer on Windows, by its full path, since a bare "explorer" is looked up next
/// to crest.exe first, and a portable copy's folder may be one other users can write to. `open` on a Mac.
pub(crate) fn opener() -> std::process::Command {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        std::process::Command::new(std::path::Path::new(&root).join("explorer.exe"))
    } else {
        std::process::Command::new("open")
    }
}

/// For main.rs: elevated "Unlock FPS" call (see fps::fps_unlock).
#[cfg(windows)]
pub fn fps_elevated_unlock(sid: &str) -> i32 {
    fps::elevated_unlock(sid)
}

/// For main.rs: the process that puts the Windows volume and brightness indicator back after Crest (see osd.rs).
#[cfg(windows)]
pub fn osd_guard(pid: &str) -> i32 {
    osd::guard(pid)
}

/// For main.rs: the installer and the uninstaller put the Windows volume and brightness indicator back before they close Crest and its guard (see osd.rs).
#[cfg(windows)]
pub fn restore_osd() {
    osd::restore()
}

/// For main.rs: the uninstaller gives back the Windows banners Crest turned off (see banners.rs).
#[cfg(windows)]
pub fn restore_banners() {
    banners::restore()
}

pub fn run() {
    let builder = tauri::Builder::default()
        // A second launch doesn't open a second notch; it opens the settings of this one.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| shell::second_launch(app)));
    // The Store build starts with Windows through its package (startup.rs) and only the Store may update it.
    #[cfg(not(feature = "store"))]
    let builder = builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        // Updates: signed installers from GitHub, only on click in the settings.
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(windows)]
    let builder = builder
        .manage(mixer::MixerState::default())
        .manage(system::SystemState::default())
        .manage(mirror::MirrorState::default())
        .manage(discord::DiscordState::default())
        .manage(vault::VaultState::default())
        .manage(terminal::TerminalState::default())
        .manage(launcher::LauncherState::default())
        .manage(notices::NoticesState::default())
        .manage(capture::CaptureState::default());
    builder
        .plugin(tauri_plugin_process::init())
        // Shortcuts are set in the settings (shell.rs).
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(shell::on_shortcut).build())
        .manage(shell::Hotkeys::default())
        .manage(hit_test::HitState::default())
        .manage(media::MediaState::default())
        .manage(clipboard::ClipboardState::default())
        .manage(FocusState::default())
        .manage(TrayItems::default())
        .manage(audio::AudioState::default())
        .manage(ai::AiState::default())
        .manage(trading::TradingState::default())
        .manage(usage::UsageState::default())
        .manage(display::DisplayState::default())
        .manage(github::GithubState::default())
        .manage(calendar::CalendarState::default())
        .manage(plugins::PluginsState::default())
        // Plugin pages, each only from its own folder (plugins.rs).
        .register_asynchronous_uri_scheme_protocol(plugins::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let webview = ctx.webview_label().to_string();
            tauri::async_runtime::spawn_blocking(move || responder.respond(plugins::protocol(&app, &webview, &request)));
        })
        .invoke_handler({
            let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            hit_test::set_hit_rect,
            hit_test::set_pet_rect,
            hit_test::set_pinned,
            hit_test::set_passthrough,
            idle::idle_seconds,
            media::media_get,
            media::media_control,
            media::media_pin,
            media::media_sources,
            media::media_lyrics,
            #[cfg(windows)]
            memory::memory_low,
            clipboard::clipboard_list,
            clipboard::clipboard_mode,
            clipboard::clipboard_copy,
            clipboard::clipboard_delete,
            clipboard::clipboard_clear,
            clipboard::clipboard_preview,
            clipboard::clipboard_paste_files,
            clipboard::clipboard_text,
            keyboard_focus,
            audio::audio_levels,
            ai::ai_chat,
            ai::ai_cancel,
            secrets::secret_set,
            secrets::secret_has,
            trading::portfolio_fetch,
            trading::portfolio_prices,
            trading::portfolio_record,
            trading::portfolio_forget,
            usage::usage_fetch,
            usage::usage_tokens,
            #[cfg(windows)]
            system::system_stats,
            #[cfg(windows)]
            sysevents::status_seed,
            #[cfg(windows)]
            sysevents::status_configure,
            #[cfg(windows)]
            system::system_icon,
            convert::convert_probe,
            convert::reveal_file,
            convert::open_path,
            convert::copy_files,
            convert::file_preview,
            downloads::downloads_configure,
            display::display_monitors,
            display::display_apply,
            display::display_screen,
            display::display_fullscreen,
            display::display_raise,
            display::display_apps,
            #[cfg(windows)]
            mirror::display_cursor_monitor,
            #[cfg(windows)]
            mirror::mirror_picture,
            #[cfg(windows)]
            mirror::mirror_picture_set,
            shell::hotkeys_apply,
            shell::crash_log,
            #[cfg(windows)]
            fps::gaming_fps,
            #[cfg(windows)]
            fps::fps_unlock,
            #[cfg(windows)]
            controls::volume_get,
            #[cfg(windows)]
            controls::volume_set,
            #[cfg(windows)]
            controls::audio_outputs,
            #[cfg(windows)]
            controls::audio_set_output,
            #[cfg(windows)]
            mixer::mixer_list,
            #[cfg(windows)]
            mixer::mixer_set,
            #[cfg(windows)]
            mixer::media_open_source,
            tray_focus,
            tray_texts,
            #[cfg(windows)]
            controls::focus_get,
            #[cfg(windows)]
            controls::focus_set,
            #[cfg(windows)]
            power::keep_awake_set,
            #[cfg(windows)]
            power::power_plans,
            #[cfg(windows)]
            power::power_plan_set,
            #[cfg(windows)]
            privacy::privacy_state,
            #[cfg(windows)]
            discord::discord_configure,
            #[cfg(windows)]
            discord::discord_action,
            #[cfg(windows)]
            discord::discord_state,
            #[cfg(windows)]
            vault::vault_status,
            #[cfg(windows)]
            vault::vault_setup,
            #[cfg(windows)]
            vault::vault_unlock,
            #[cfg(windows)]
            vault::vault_lock,
            #[cfg(windows)]
            vault::vault_save_password,
            #[cfg(windows)]
            vault::vault_add_totp,
            #[cfg(windows)]
            vault::vault_delete,
            #[cfg(windows)]
            vault::vault_reveal,
            #[cfg(windows)]
            vault::vault_copy,
            #[cfg(windows)]
            vault::vault_codes,
            #[cfg(windows)]
            vault::vault_options,
            #[cfg(windows)]
            vault::vault_change_pin,
            #[cfg(windows)]
            vault::vault_reset,
            #[cfg(windows)]
            vault::vault_scan,
            #[cfg(windows)]
            vault::vault_hello_supported,
            #[cfg(windows)]
            vault::vault_hello_unlock,
            #[cfg(windows)]
            vault::vault_hello_enable,
            #[cfg(windows)]
            vault::vault_hello_disable,
            autostart_get,
            autostart_set,
            build_info,
            diagnostics_info,
            open_sponsors,
            open_store_review,
            open_bug_report,
            #[cfg(windows)]
            brightness::brightness_get,
            #[cfg(windows)]
            brightness::brightness_set,
            #[cfg(target_os = "macos")]
            macos::brightness::brightness_get,
            #[cfg(target_os = "macos")]
            macos::brightness::brightness_set,
            #[cfg(windows)]
            quick::quick_get,
            #[cfg(windows)]
            quick::quick_radio,
            #[cfg(windows)]
            quick::quick_dark,
            #[cfg(windows)]
            quick::quick_power,
            #[cfg(target_os = "macos")]
            macos::quick::quick_get,
            #[cfg(target_os = "macos")]
            macos::quick::quick_radio,
            #[cfg(target_os = "macos")]
            macos::quick::quick_dark,
            #[cfg(target_os = "macos")]
            macos::quick::quick_power,
            #[cfg(target_os = "macos")]
            macos::memory_low,
            #[cfg(target_os = "macos")]
            macos::status_configure,
            #[cfg(target_os = "macos")]
            macos::privacy_state,
            translate::translate_status,
            translate::translate_download,
            translate::translate_remove,
            translate::translate_file,
            phone_share::phone_share_start,
            phone_share::phone_share_stop,
            timer_window::timer_window_open,
            timer_window::timer_window_close,
            #[cfg(windows)]
            banners::notices_banners,
            #[cfg(windows)]
            shelf::shelf_drag_out,
            #[cfg(windows)]
            shelf::shelf_clipboard_text,
            #[cfg(windows)]
            terminal::terminal_info,
            #[cfg(windows)]
            terminal::terminal_start,
            #[cfg(windows)]
            terminal::terminal_write,
            #[cfg(windows)]
            terminal::terminal_resize,
            #[cfg(windows)]
            terminal::terminal_kill,
            #[cfg(windows)]
            terminal::terminal_clipboard_text,
            themes::themes_folder,
            themes::themes_read,
            themes::themes_write,
            #[cfg(windows)]
            launcher::launcher_apps,
            #[cfg(windows)]
            launcher::launcher_icons,
            #[cfg(windows)]
            launcher::launcher_open,
            #[cfg(windows)]
            launcher::launcher_shortcuts,
            github::github_contributions,
            github::github_open_profile,
            calendar::calendar_fetch,
            calendar::calendar_open_link,
            lyrics::lyrics_fetch,
            romanize::lyrics_romanize,
            romanize::lyrics_dict_status,
            romanize::lyrics_dict_download,
            romanize::lyrics_dict_remove,
            #[cfg(windows)]
            notices::notices_configure,
            #[cfg(windows)]
            notices::notices_status,
            #[cfg(windows)]
            notices::notices_request_access,
            #[cfg(windows)]
            notices::notices_answer,
            #[cfg(windows)]
            notices::notices_remove_windows,
            #[cfg(windows)]
            notices::notices_open_app,
            #[cfg(windows)]
            notices::notices_copy_code,
            plugins::plugins_list,
            plugins::plugins_pick,
            plugins::plugins_stage,
            plugins::plugins_commit,
            plugins::plugins_discard,
            plugins::plugins_remove,
            plugins::plugins_storage,
            plugins::plugins_fetch,
            portable::portable_info,
            portable::portable_check,
            portable::portable_install,
            ports::ports_list,
            ports::ports_end,
            ports::ports_open,
            #[cfg(windows)]
            capture::capture_sources,
            #[cfg(windows)]
            capture::capture_shot,
            #[cfg(windows)]
            capture::capture_state,
            #[cfg(windows)]
            capture::capture_start,
            #[cfg(windows)]
            capture::capture_pause,
            #[cfg(windows)]
            capture::capture_stop,
            #[cfg(windows)]
            capture::capture_list,
            #[cfg(windows)]
            capture::capture_details,
            #[cfg(windows)]
            capture::capture_delete,
            #[cfg(windows)]
            capture::find::find_scan,
            #[cfg(windows)]
            capture::find::find_highlight,
            agents::agents_list,
            agents::agents_chat,
            mic::mic_mute,
            sharing::sharing_hide,
            ];
            move |invoke| {
                if !command_allowed(invoke.message.webview_ref().label(), invoke.message.command()) {
                    invoke.resolver.reject("not-allowed");
                    return true;
                }
                commands(invoke)
            }
        })
        .setup(move |app| {
            // A menu bar app: no Dock icon, like skipTaskbar on Windows.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            shell::init(app);
            let window = portable::create_window(app)?;
            display::place(&window, &app.state::<display::DisplayState>())?;
            window.show()?;
            #[cfg(target_os = "macos")]
            macos::raise(&window);
            // Only after show(): this fails on a window that was never shown.
            window.set_ignore_cursor_events(true)?;
            #[cfg(windows)]
            drop::install(&window);
            #[cfg(windows)]
            camera::install(&window);
            hit_test::spawn(app.handle().clone(), window.clone());
            #[cfg(windows)]
            display::spawn(app.handle().clone(), window);
            mirror::spawn(app.handle().clone());
            media::spawn(app.handle().clone());
            clipboard::spawn(app.handle().clone());
            audio::spawn(app.handle().clone(), &app.state::<audio::AudioState>());
            #[cfg(windows)]
            sysevents::spawn(app.handle().clone());
            #[cfg(windows)]
            brightness::spawn(app.handle().clone());
            // A run that ended without restoring the Windows indicator (and whose guard was ended with it) is cleaned up here.
            #[cfg(windows)]
            osd::restore();

            enable_autostart_once(app.handle());
            build_tray(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Crest")
        .run(|app, event| {
            // A recording still running when Crest quits is finished, so the file is complete.
            #[cfg(windows)]
            if let tauri::RunEvent::Exit = event {
                capture::finish_on_exit(app);
                osd::set(false, false);
                power::keep_awake_stop();
                // Nothing pops notices up once Crest is gone; the next start hides the banners again.
                banners::restore();
                vault::clear_on_exit();
            }
            #[cfg(not(windows))]
            let _ = (app, event);
        });
}

/// Window that was in the foreground before the shortcut opened the notch.
#[derive(Default)]
struct FocusState(Mutex<isize>);

/// Opened via shortcut → take focus (for Esc/typing).
/// Closed → give focus back to the previous app, otherwise typing goes nowhere.
#[cfg(windows)]
#[tauri::command]
fn keyboard_focus(focus: bool, window: WebviewWindow, state: State<'_, FocusState>) {
    let Ok(own) = window.hwnd() else { return };
    let own = own.0 as isize;
    let foreground = unsafe { GetForegroundWindow() }.0 as isize;
    let mut previous = state.0.lock().unwrap();

    if focus {
        if foreground != own {
            *previous = foreground;
        }
        let _ = window.set_focus();
        return;
    }
    if foreground == own && *previous != 0 {
        let _ = unsafe { SetForegroundWindow(HWND(*previous as *mut _)) };
        *previous = 0;
    }
    // Sent when the notch closes: a "hide" rule takes over again.
    display::closed(window.app_handle());
}

/// The same on a Mac, with the frontmost app's process id in place of the foreground window.
#[cfg(target_os = "macos")]
#[tauri::command]
fn keyboard_focus(focus: bool, window: WebviewWindow, state: State<'_, FocusState>) {
    let own = std::process::id() as isize;
    let foreground = macos::frontmost_pid() as isize;
    let mut previous = state.0.lock().unwrap();

    if focus {
        if foreground != own {
            *previous = foreground;
        }
        let _ = window.set_focus();
        return;
    }
    if foreground == own && *previous != 0 {
        macos::activate_pid(*previous as i32);
        *previous = 0;
    }
    display::closed(window.app_handle());
}

/// The pointer came onto the pet: its click activates the window, so note the app it takes the keyboard from;
/// the frontend then calls keyboard_focus(false) to give it back.
#[cfg(windows)]
fn remember_foreground(window: &WebviewWindow) {
    let Ok(own) = window.hwnd() else { return };
    let foreground = unsafe { GetForegroundWindow() }.0 as isize;
    if foreground != own.0 as isize {
        *window.state::<FocusState>().0.lock().unwrap() = foreground;
    }
}

#[cfg(target_os = "macos")]
fn remember_foreground(window: &WebviewWindow) {
    let foreground = macos::frontmost_pid() as isize;
    if foreground != std::process::id() as isize {
        *window.state::<FocusState>().0.lock().unwrap() = foreground;
    }
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    startup::is_enabled(&app)
}

#[tauri::command]
fn autostart_set(enabled: bool, app: AppHandle, state: State<'_, TrayItems>) -> Result<(), String> {
    let result = startup::set(&app, enabled);
    // The tray check shows the real state, also when the switch was refused.
    if let Some(tray) = state.0.lock().unwrap().as_ref() {
        let _ = tray.autostart.set_checked(startup::is_enabled(&app));
    }
    result
}

/// Which build runs: the Microsoft Store one leaves updates to the Store.
#[tauri::command]
fn build_info() -> serde_json::Value {
    serde_json::json!({ "store": cfg!(feature = "store") })
}

/// For Copy diagnostics (Settings, General): Windows edition and build, the architecture of this build and of the PC
/// (an x64 build on an ARM PC runs emulated), and each monitor's scale. Nothing about the user, the PC's name or a path.
#[tauri::command]
fn diagnostics_info(window: tauri::WebviewWindow) -> serde_json::Value {
    let scales: Vec<f64> = window.available_monitors().unwrap_or_default().iter().map(|m| m.scale_factor()).collect();
    serde_json::json!({
        "os": sysinfo::System::long_os_version(),
        "build": sysinfo::System::kernel_version(),
        "arch": std::env::consts::ARCH,
        "machine": native_machine(),
        "scales": scales,
    })
}

/// The PC's own architecture, which GetSystemInfo hides from an emulated process.
#[cfg(windows)]
fn native_machine() -> Option<&'static str> {
    use windows::Win32::System::SystemInformation::{IMAGE_FILE_MACHINE, IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64};
    use windows::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};
    let (mut process, mut native) = (IMAGE_FILE_MACHINE::default(), IMAGE_FILE_MACHINE::default());
    unsafe { IsWow64Process2(GetCurrentProcess(), &mut process, Some(&mut native)) }.ok()?;
    match native {
        IMAGE_FILE_MACHINE_AMD64 => Some("x86_64"),
        IMAGE_FILE_MACHINE_ARM64 => Some("aarch64"),
        _ => Some("other"),
    }
}

/// Not read on a Mac yet (a Rosetta process would need sysctl.proc_translated).
#[cfg(not(windows))]
fn native_machine() -> Option<&'static str> {
    None
}

/// Opens the GitHub Sponsors page in the default browser. The address is fixed here, so the interface cannot open anything else.
#[tauri::command]
fn open_sponsors() -> Result<(), String> {
    open_url("https://github.com/sponsors/andrealo20")
}

/// The bug report form on GitHub, with this version already filled in (issue forms take field ids as query parameters).
#[tauri::command]
fn open_bug_report() -> Result<(), String> {
    let url = concat!("https://github.com/andrealo20/crest/issues/new?template=bug_report.yml&version=", env!("CARGO_PKG_VERSION"));
    open_url(url)
}

/// Crest's rating page in the Microsoft Store app; the buttons that call it show in the Store build only.
#[tauri::command]
fn open_store_review() -> Result<(), String> {
    open_url("ms-windows-store://review/?ProductId=9N2KXJ2924KS")
}

/// Enables autostart on the very first launch; after that the tray check and settings decide.
fn enable_autostart_once(app: &AppHandle) {
    // A portable copy writes nothing outside its folder unless asked to (tray or settings); in the Store build the user turns it on.
    if portable::is_portable() || cfg!(feature = "store") {
        return;
    }
    // The login item stores the running binary's path: one run from a dmg or Downloads would leave it dead after the move.
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join("Applications"));
        let installed = std::env::current_exe()
            .is_ok_and(|p| p.starts_with("/Applications") || home.is_some_and(|h| p.starts_with(h)));
        if !installed {
            return;
        }
    }
    let Ok(dir) = crate::portable::app_data_dir(app) else { return };
    let marker = dir.join("autostart-initialized");
    if marker.exists() {
        return;
    }
    if startup::set(app, true).is_ok() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(marker, "");
    }
}

/// The tray items whose check state or text changes at runtime ("Open Crest" lives in shell.rs with its shortcut).
#[derive(Default)]
struct TrayItems(Mutex<Option<Tray>>);

struct Tray {
    settings: MenuItem<tauri::Wry>,
    focus: CheckMenuItem<tauri::Wry>,
    autostart: CheckMenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// The frontend owns focus mode; the tray check only mirrors it.
#[tauri::command]
fn tray_focus(on: bool, state: State<'_, TrayItems>) {
    if let Some(tray) = state.0.lock().unwrap().as_ref() {
        let _ = tray.focus.set_checked(on);
    }
}

#[derive(serde::Deserialize)]
struct TrayTexts {
    open: String,
    settings: String,
    focus: String,
    autostart: String,
    quit: String,
}

/// The menu in the interface language, sent by the frontend with every language change; English until then.
#[tauri::command]
fn tray_texts(texts: TrayTexts, app: AppHandle, state: State<'_, TrayItems>) {
    if let Some(tray) = state.0.lock().unwrap().as_ref() {
        let _ = tray.settings.set_text(texts.settings);
        let _ = tray.focus.set_text(texts.focus);
        let _ = tray.autostart.set_text(texts.autostart);
        let _ = tray.quit.set_text(texts.quit);
    }
    shell::set_open_text(&app, texts.open);
}

/// Dark tray menu to match the notch instead of the light default.
/// uxtheme only exports this by ordinal: SetPreferredAppMode = 135, FlushMenuThemes = 136
/// (Windows 10 1903+). If missing, the menu just stays light.
#[cfg(windows)]
fn dark_menus() {
    use windows::core::{w, PCSTR};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    const FORCE_DARK: i32 = 2;
    unsafe {
        let Ok(uxtheme) = LoadLibraryW(w!("uxtheme.dll")) else { return };
        if let Some(f) = GetProcAddress(uxtheme, PCSTR(135 as *const u8)) {
            let set_preferred_app_mode: extern "system" fn(i32) -> i32 = std::mem::transmute(f);
            set_preferred_app_mode(FORCE_DARK);
        }
        if let Some(f) = GetProcAddress(uxtheme, PCSTR(136 as *const u8)) {
            let flush_menu_themes: extern "system" fn() = std::mem::transmute(f);
            flush_menu_themes();
        }
    }
}

/// Without a taskbar entry, the tray is where you open, configure and quit.
/// Left click opens the notch, right click shows the menu.
fn build_tray(app: &App) -> tauri::Result<()> {
    #[cfg(windows)]
    dark_menus();
    let enabled = startup::is_enabled(app.handle());
    // Open has its shortcut right-aligned via tab, like Windows menus.
    let open = MenuItem::with_id(app, "open", shell::default_open_label(), true, None::<&str>)?;
    shell::set_tray_open(app, open.clone());
    let settings = MenuItem::with_id(app, "settings", "Settings …", true, None::<&str>)?;
    // The real state follows right after start (the frontend calls tray_focus).
    let focus = CheckMenuItem::with_id(app, "focus", "Focus mode", true, false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, enabled, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Crest", true, None::<&str>)?;
    *app.state::<TrayItems>().0.lock().unwrap() =
        Some(Tray { settings: settings.clone(), focus: focus.clone(), autostart: autostart.clone(), quit: quit.clone() });
    let menu = Menu::with_items(
        app,
        &[&open, &settings, &PredefinedMenuItem::separator(app)?, &focus, &autostart, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let autostart_item = autostart.clone();
    let focus_item = focus.clone();
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Crest")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                shell::open(tray.app_handle(), None);
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => shell::open(app, None),
            "settings" => shell::open(app, Some("settings")),
            "quit" => app.exit(0),
            "focus" => {
                // The click already toggled the check; the frontend applies it and mirrors it back.
                let on = focus_item.is_checked().unwrap_or(false);
                let _ = app.emit("notch://focus-set", on);
            }
            "autostart" => {
                // The check item toggles itself on click; read the new state.
                let on = autostart_item.is_checked().unwrap_or(false);
                // Windows can refuse (Store build: the user switched it off in Task Manager); the check then shows the real state.
                if startup::set(app, on).is_err() {
                    let _ = autostart_item.set_checked(startup::is_enabled(app));
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn native_machine_is_known_and_matches_a_native_build() {
        let native = super::native_machine();
        assert!(matches!(native, Some("x86_64" | "aarch64")), "{native:?}");
        // An arm64 build never runs emulated; an x64 one may, on an ARM PC.
        if cfg!(target_arch = "aarch64") {
            assert_eq!(native, Some("aarch64"));
        }
    }

    #[test]
    fn only_the_notch_reaches_every_command() {
        use super::command_allowed as ok;
        assert!(ok("notch", "vault_reveal") && ok("notch", "terminal_write"));
        assert!(ok("timer", "timer_window_close") && !ok("timer", "terminal_write") && !ok("timer", "open_path"));
        assert!(ok("mirror-1", "mirror_picture") && !ok("mirror-1", "vault_reveal"));
        assert!(!ok("plugin", "secret_set") && !ok("", "mirror_picture"));
    }

    #[test]
    fn windows_stay_on_crests_own_pages() {
        let ok = |u: &str| super::own_page(&u.parse().unwrap());
        assert!(ok("http://tauri.localhost/index.html") && ok("tauri://localhost/") && ok("about:blank"));
        // A plugin page or a website dropped as a link.
        assert!(!ok("http://crestplugin.localhost/hello/index.html"));
        assert!(!ok("https://example.com/") && !ok("file:///C:/Windows/") && !ok("http://tauri.localhost.example.com/"));
    }
}
