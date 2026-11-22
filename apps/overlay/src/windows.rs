use crate::{
    protocol::{self, Destination, Output, Panel, Session, Shortcut, WebCommand},
    visibility::{Foreground, PanelOpening, Visibility},
};
use serde::Serialize;
use std::{
    borrow::Cow,
    cell::{OnceCell, RefCell},
    env,
    error::Error,
    io::{self, BufReader},
    mem::size_of,
    num::NonZeroU32,
    path::PathBuf,
    ptr::null_mut,
    rc::Rc,
    time::{Duration, Instant},
};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    platform::{
        run_return::EventLoopExtRunReturn,
        windows::{EventLoopBuilderExtWindows, WindowBuilderExtWindows, WindowExtWindows},
    },
    window::{Window, WindowBuilder},
};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        GetAvailableCoreWebView2BrowserVersionString, ICoreWebView2,
    },
    ProcessFailedEventHandler, take_pwstr,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, FILETIME, HANDLE, HWND, LPARAM, LRESULT, RECT, WAIT_TIMEOUT, WPARAM,
    },
    System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        WaitForSingleObject,
    },
    UI::{
        Input::KeyboardAndMouse::{
            IsWindowEnabled, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, RegisterHotKey,
            UnregisterHotKey, VK_F9, VK_F10, VK_SPACE,
        },
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GA_ROOT, GW_HWNDPREV, GW_OWNER, GWL_EXSTYLE, GetAncestor, GetForegroundWindow,
            GetWindow, GetWindowInfo, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
            HWND_TOPMOST, IsIconic, IsWindowVisible, MSG, SWP_HIDEWINDOW, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
            SetForegroundWindow, SetWindowPos, WA_INACTIVE, WINDOWINFO, WM_ACTIVATE, WM_HOTKEY,
            WS_EX_TOPMOST,
        },
    },
};
use wry::{
    NewWindowResponse, PermissionResponse, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
    http::{Method, Request, Response, Uri},
};

const HOTKEY: i32 = 1;
const TRACK_INTERVAL: Duration = Duration::from_millis(32);
const IDLE_INTERVAL: Duration = Duration::from_millis(250);
const SCHEME: &str = "rezics-overlay";
const PAGE: &str = "rezics-overlay://localhost/index.html";
const ORIGIN_HOST: &str = "rezics-overlay.localhost";

enum Signal {
    Session(Option<Session>),
    LauncherDisconnected,
    Hotkey { foreground: usize },
    WindowDeactivated,
    WebView(WebCommand),
    WebViewProcessExited(&'static str),
}

thread_local! {
    static ACTIVATION_EVENTS: RefCell<Option<EventLoopProxy<Signal>>> = const { RefCell::new(None) };
}

unsafe extern "system" fn window_activation(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_ACTIVATE && wparam as u16 == WA_INACTIVE as u16 {
        let _ = ACTIVATION_EVENTS.try_with(|slot| {
            if let Some(events) = slot.borrow().as_ref() {
                let _ = events.send_event(Signal::WindowDeactivated);
            }
        });
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

struct ActivationSubscription(HWND);

impl ActivationSubscription {
    fn new(window: HWND, events: EventLoopProxy<Signal>) -> io::Result<Self> {
        // The window and its subclass belong to this event loop's thread.
        if unsafe { SetWindowSubclass(window, Some(window_activation), 0, 0) } == 0 {
            return Err(io::Error::other(
                "could not observe the overlay window's activation",
            ));
        }
        ACTIVATION_EVENTS.with(|slot| slot.replace(Some(events)));
        Ok(Self(window))
    }
}

impl Drop for ActivationSubscription {
    fn drop(&mut self) {
        ACTIVATION_EVENTS.with(|slot| slot.take());
        unsafe { RemoveWindowSubclass(self.0, Some(window_activation), 0) };
    }
}

fn webview_exit_description(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> Option<&'static str> {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
            Some("The WebView2 browser process exited unexpectedly.")
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
            Some("The WebView2 main renderer process exited unexpectedly.")
        }
        _ => None,
    }
}

fn webview_runtime_detected() -> bool {
    let mut version = Default::default();
    // Use the loader's configured search path and free its returned version string.
    unsafe { GetAvailableCoreWebView2BrowserVersionString(None, &mut version) }.is_ok()
        && !take_pwstr(version).is_empty()
}

struct WebViewProcessSubscription {
    core: ICoreWebView2,
    token: i64,
}

impl WebViewProcessSubscription {
    fn new(webview: &WebView, events: EventLoopProxy<Signal>) -> Result<Self, Box<dyn Error>> {
        // Register and remove the COM handler on the thread that owns the controller.
        let core = unsafe { webview.controller().CoreWebView2()? };
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                unsafe { args.ProcessFailedKind(&mut kind)? };
                if let Some(description) = webview_exit_description(kind) {
                    let _ = events.send_event(Signal::WebViewProcessExited(description));
                }
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe { core.add_ProcessFailed(&handler, &mut token)? };
        Ok(Self { core, token })
    }
}

impl Drop for WebViewProcessSubscription {
    fn drop(&mut self) {
        let _ = unsafe { self.core.remove_ProcessFailed(self.token) };
    }
}

struct Process {
    handle: HANDLE,
    pid: u32,
    created_at: u64,
}

impl Process {
    fn open(pid: u32) -> io::Result<Self> {
        // The handle pins the process object while a session is attached.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut process = Self {
            handle,
            pid,
            created_at: 0,
        };
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        process.created_at = (ticks / 10_000)
            .checked_sub(11_644_473_600_000)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid process timestamp")
            })?;
        Ok(process)
    }

    fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT }
    }

    fn owns(&self, hwnd: HWND) -> bool {
        if hwnd.is_null() {
            return false;
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid == self.pid && self.alive()
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewSession<'a> {
    session_id: &'a str,
    title: &'a str,
    started_at: u64,
    destinations: &'a [Destination],
    panels: &'a [Panel],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View<'a> {
    mode: Visibility,
    shortcut: Shortcut,
    session: Option<ViewSession<'a>>,
    interaction_id: Option<NonZeroU32>,
}

struct Host {
    webview: WebView,
    window: Window,
    fixture: bool,
    shortcut: Shortcut,
    ready: bool,
    mode: Visibility,
    opening: PanelOpening,
    session: Option<Session>,
    process: Option<Process>,
    game: HWND,
}

impl Host {
    fn attach(&mut self, session: Option<Session>) -> io::Result<()> {
        let same_process =
            self.session
                .as_ref()
                .zip(session.as_ref())
                .is_some_and(|(current, next)| {
                    current.session_id == next.session_id
                        && current.instance_id == next.instance_id
                        && current.pid == next.pid
                        && current.started_at == next.started_at
                        && self.process.as_ref().is_some_and(Process::alive)
                });
        if !same_process {
            self.hide(true);
            self.process = session.as_ref().and_then(|next| {
                Process::open(next.pid).ok().filter(|process| {
                    process.pid != std::process::id()
                        && process.created_at <= next.started_at
                        && process.alive()
                })
            });
        }
        let attached = self.process.is_some();
        let report_id = if !same_process && !self.fixture {
            session.as_ref().map(|next| next.session_id.clone())
        } else {
            None
        };
        self.session = session.filter(|_| attached);
        self.publish_view();
        if let Some(session_id) = &report_id {
            protocol::write_message(
                io::stdout().lock(),
                Output::SessionStatus {
                    v: 1,
                    session_id,
                    attached,
                },
            )?;
        }
        Ok(())
    }

    fn overlay_window(&self) -> HWND {
        self.window.hwnd() as HWND
    }

    fn game_is_live(&self) -> bool {
        self.process
            .as_ref()
            .is_some_and(|process| process.owns(self.game))
    }

    fn close_or_open(&mut self, pressed_foreground: usize) {
        let Some(foreground) = hotkey_foreground(pressed_foreground) else {
            return;
        };
        if self.mode == Visibility::Interactive {
            self.hide(true);
            return;
        }
        if !self.ready {
            return;
        }
        let Some(rect) = self
            .process
            .as_ref()
            .and_then(|process| hotkey_bounds(self.mode, self.game, foreground, process))
        else {
            return;
        };
        self.game = foreground;
        self.window.set_focusable(true);
        if self.window.set_ignore_cursor_events(false).is_err() {
            self.hide(false);
            return;
        }
        let overlay = self.overlay_window();
        if !place(overlay, self.game, rect) {
            self.hide(false);
            return;
        }
        self.mode = Visibility::Interactive;
        if !set_visible(overlay, true) {
            self.hide(false);
            return;
        }
        if unsafe { SetForegroundWindow(overlay) } == 0 && foreground_root() != overlay {
            self.hide(false);
            return;
        }
        self.opening.start();
        self.publish_view();
        if self.webview.focus().is_err() {
            self.hide(true);
        }
    }

    fn focus_lost(&mut self) {
        if self
            .mode
            .closes_on_focus_loss(foreground_root() == self.overlay_window())
        {
            self.hide(false);
        }
    }

    fn enter_hud(&mut self) {
        if !self.game_is_live() || foreground_root() != self.overlay_window() {
            self.hide(false);
            return;
        }
        if unsafe { SetForegroundWindow(self.game) } == 0 && foreground_root() != self.game {
            self.hide(true);
            return;
        }
        self.window.set_focusable(false);
        if self.window.set_ignore_cursor_events(true).is_err() {
            self.hide(false);
            return;
        }
        if !set_visible(self.overlay_window(), true) {
            self.hide(false);
            return;
        }
        self.mode = Visibility::Hud;
        self.publish_view();
    }

    fn hide(&mut self, restore_focus: bool) {
        if self.mode == Visibility::Hidden {
            self.game = null_mut();
            return;
        }
        let return_to_game = restore_focus
            && foreground_root() == self.overlay_window()
            && self.game_is_live()
            && client_bounds(self.game).is_some();
        if return_to_game {
            unsafe { SetForegroundWindow(self.game) };
        }
        set_visible(self.overlay_window(), false);
        self.game = null_mut();
        self.mode = Visibility::Hidden;
        self.publish_view();
    }

    fn track_window(&mut self) {
        if self.mode == Visibility::Hidden {
            return;
        }
        let overlay = self.overlay_window();
        let next = tracked_visibility(self.mode, overlay, self.game, self.game_is_live());
        if next == self.mode {
            return;
        }
        if next == Visibility::Hidden {
            self.hide(true);
        } else if set_visible(overlay, next.is_visible()) {
            self.mode = next;
            self.publish_view();
        } else {
            self.hide(false);
        }
    }

    fn tracking_interval(&self) -> Option<Duration> {
        if self.mode.is_visible() {
            Some(TRACK_INTERVAL)
        } else if self.mode == Visibility::SuspendedHud || self.fixture {
            Some(IDLE_INTERVAL)
        } else {
            None
        }
    }

    fn publish_view(&self) {
        if !self.ready {
            return;
        }
        let view = View {
            mode: self.mode,
            shortcut: self.shortcut,
            interaction_id: self.opening.current(self.mode),
            session: self.session.as_ref().map(|session| ViewSession {
                session_id: &session.session_id,
                title: &session.title,
                started_at: session.started_at,
                destinations: &session.destinations,
                panels: &session.panels,
            }),
        };
        if let Ok(payload) = serde_json::to_string(&view)
            && let Err(error) = self.webview.evaluate_script(&format!(
                "window.dispatchEvent(new CustomEvent('rezics-overlay-state', {{detail: {payload}}}));"
            ))
        {
            eprintln!("Could not update the overlay view: {error}");
        }
    }

    fn web_command(&mut self, command: WebCommand) -> io::Result<()> {
        if matches!(command, WebCommand::Ready) {
            if !self.ready && !self.fixture {
                protocol::write_message(
                    io::stdout().lock(),
                    Output::Ready {
                        v: 1,
                        session_frame_limit: protocol::SESSION_FRAME_LIMIT,
                        shortcut: self.shortcut,
                    },
                )?;
            }
            self.ready = true;
            self.publish_view();
            return Ok(());
        }
        let Some(session) = &self.session else {
            return Ok(());
        };
        let Some(panel) = command.panel() else {
            return Ok(());
        };
        if !panel.belongs_to(&session.session_id, self.opening.current(self.mode))
            || foreground_root() != self.overlay_window()
            || !self.game_is_live()
            || client_bounds(self.game).is_none()
        {
            return Ok(());
        }
        match command {
            WebCommand::Hide { .. } => self.hide(true),
            WebCommand::Hud { .. } => self.enter_hud(),
            WebCommand::OpenDestination { panel, destination }
                if session.allows_destination(&panel.session_id, destination) && !self.fixture =>
            {
                protocol::write_message(
                    io::stdout().lock(),
                    Output::OpenDestination {
                        v: 1,
                        session_id: &panel.session_id,
                        destination,
                    },
                )?;
                self.hide(true);
            }
            _ => {}
        }
        Ok(())
    }
}

fn hotkey_foreground(observed: usize) -> Option<HWND> {
    let foreground = foreground_root();
    (!foreground.is_null() && foreground as usize == observed).then_some(foreground)
}

fn hotkey_bounds(
    mode: Visibility,
    pinned: HWND,
    foreground: HWND,
    process: &Process,
) -> Option<RECT> {
    if !mode.can_open_interactive(foreground == pinned) || !process.owns(foreground) {
        return None;
    }
    client_bounds(foreground)
}

fn tracked_visibility(
    mode: Visibility,
    overlay: HWND,
    game: HWND,
    target_alive: bool,
) -> Visibility {
    let foreground = foreground_root();
    let context = if foreground == game {
        Foreground::Game
    } else if foreground == overlay {
        Foreground::Overlay
    } else {
        Foreground::Other
    };
    let positioned = target_alive
        && mode.accepts_foreground(context)
        && client_bounds(game).is_some_and(|rect| place(overlay, game, rect));
    mode.after_tracking(target_alive, positioned)
}

fn place(overlay: HWND, game: HWND, rect: RECT) -> bool {
    let mut current = RECT::default();
    let same_bounds = unsafe { GetWindowRect(overlay, &mut current) } != 0
        && (current.left, current.top, current.right, current.bottom)
            == (rect.left, rect.top, rect.right, rect.bottom);
    let topmost_game =
        unsafe { GetWindowLongPtrW(game, GWL_EXSTYLE) } & WS_EX_TOPMOST as isize != 0;
    let mut insert_after = HWND_TOPMOST;
    let mut flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    if topmost_game {
        // A game can raise itself within the topmost group without changing bounds.
        let above_game = unsafe { GetWindow(game, GW_HWNDPREV) };
        if !above_game.is_null() {
            insert_after = above_game;
        }
        if above_game == overlay {
            flags |= SWP_NOZORDER;
        }
    }
    if same_bounds {
        if !topmost_game || insert_after == overlay {
            return true;
        }
        flags |= SWP_NOMOVE | SWP_NOSIZE;
    }
    unsafe {
        SetWindowPos(
            overlay,
            insert_after,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            flags,
        ) != 0
    }
}

fn set_visible(window: HWND, visible: bool) -> bool {
    let show = if visible {
        SWP_SHOWWINDOW
    } else {
        SWP_HIDEWINDOW
    };
    // Showing the window and activating it are independent steps. A HUD never activates it.
    unsafe {
        SetWindowPos(
            window,
            null_mut(),
            0,
            0,
            0,
            0,
            show | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        ) != 0
    }
}

fn foreground_root() -> HWND {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return hwnd;
    }
    unsafe { GetAncestor(hwnd, GA_ROOT) }
}

fn client_bounds(window: HWND) -> Option<RECT> {
    if unsafe {
        window.is_null()
            || IsWindowVisible(window) == 0
            || IsIconic(window) != 0
            || IsWindowEnabled(window) == 0
    } {
        return None;
    }
    // Native modal dialogs disable their owner for the duration of the prompt.
    let owner = unsafe { GetWindow(window, GW_OWNER) };
    if !owner.is_null() && unsafe { IsWindowEnabled(owner) } == 0 {
        return None;
    }
    // A client origin can be at the right edge of a mirrored window, and client sizes
    // can use a different DPI context. Read the complete screen rectangle from Win32.
    let mut info = WINDOWINFO {
        cbSize: size_of::<WINDOWINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetWindowInfo(window, &mut info) } == 0 {
        return None;
    }
    let rect = info.rcClient;
    (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
}

fn is_view_page(uri: &Uri) -> bool {
    uri.scheme_str() == Some("https")
        && uri.host() == Some(ORIGIN_HOST)
        && uri.port().is_none()
        && uri.path() == "/index.html"
        && uri.query().is_none()
}

fn asset(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let (status, mime, contents): (_, _, &'static [u8]) =
        match (request.method(), request.uri().path()) {
            (&Method::GET, "/index.html") => (
                200,
                "text/html; charset=utf-8",
                include_bytes!("../.temp/ui/index.html"),
            ),
            (&Method::GET, "/overlay.js") => (
                200,
                "text/javascript; charset=utf-8",
                include_bytes!("../.temp/ui/overlay.js"),
            ),
            (&Method::GET, "/overlay.css") => (
                200,
                "text/css; charset=utf-8",
                include_bytes!("../.temp/ui/overlay.css"),
            ),
            (&Method::GET, "/favicon.ico") => (204, "image/x-icon", b""),
            _ => (404, "text/plain", b"Not found"),
        };
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; font-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        )
        .body(Cow::Borrowed(contents))
        .expect("static response headers are valid")
}

fn fixture_session(pid: u32) -> io::Result<Session> {
    let process = Process::open(pid)?;
    Ok(Session {
        session_id: format!("fixture-{pid}"),
        instance_id: "overlay-fixture".into(),
        pid,
        title: "Window fixture".into(),
        started_at: process.created_at,
        destinations: vec![],
        panels: vec![],
    })
}

fn listen_to_launcher(events: EventLoopProxy<Signal>) -> io::Result<()> {
    std::thread::Builder::new()
        .name("launcher-pipe".into())
        .spawn(move || {
            let reader = BufReader::new(io::stdin().lock());
            if let Err(error) = protocol::read_sessions(reader, |session| {
                events.send_event(Signal::Session(session)).is_ok()
            }) {
                eprintln!("Launcher connection closed: {error}");
            }
            let _ = events.send_event(Signal::LauncherDisconnected);
        })?;
    Ok(())
}

struct RegisteredHotkey(HWND);

impl RegisteredHotkey {
    fn new(hwnd: HWND, key: u16, label: &str) -> io::Result<Self> {
        let modifiers = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;
        if unsafe { RegisterHotKey(hwnd, HOTKEY, modifiers, u32::from(key)) } == 0 {
            return Err(io::Error::other(format!(
                "{label} could not be registered: {}",
                io::Error::last_os_error()
            )));
        }
        Ok(Self(hwnd))
    }
}

impl Drop for RegisteredHotkey {
    fn drop(&mut self) {
        unsafe { UnregisterHotKey(self.0, HOTKEY) };
    }
}

pub fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    let (pid, shortcut) = protocol::startup(&args)?;
    let fixture = pid.map(fixture_session).transpose()?;
    let (key, label) = match shortcut {
        Shortcut::CtrlShiftSpace => (VK_SPACE, "Ctrl+Shift+Space"),
        Shortcut::CtrlShiftF9 => (VK_F9, "Ctrl+Shift+F9"),
        Shortcut::CtrlShiftF10 => (VK_F10, "Ctrl+Shift+F10"),
    };
    let target: Rc<OnceCell<EventLoopProxy<Signal>>> = Rc::new(OnceCell::new());
    let hotkey_target = Rc::clone(&target);
    let mut event_loop = EventLoopBuilder::<Signal>::with_user_event()
        .with_msg_hook(move |raw| {
            // Tao passes the current Win32 message for the duration of this callback.
            let message = unsafe { &*raw.cast::<MSG>() };
            if message.message == WM_HOTKEY && message.wParam == HOTKEY as usize {
                if let Some(proxy) = hotkey_target.get() {
                    let _ = proxy.send_event(Signal::Hotkey {
                        foreground: foreground_root() as usize,
                    });
                }
                return true;
            }
            false
        })
        .build();
    let events = event_loop.create_proxy();
    let _ = target.set(events.clone());
    let window = WindowBuilder::new()
        .with_title("REZICS Overlay")
        .with_visible(false)
        .with_focused(false)
        .with_resizable(false)
        .with_decorations(false)
        .with_undecorated_shadow(false)
        .with_always_on_top(true)
        .with_skip_taskbar(true)
        .with_transparent(true)
        .build(&event_loop)?;
    let hotkey = match RegisteredHotkey::new(window.hwnd() as HWND, key, label) {
        Ok(hotkey) => hotkey,
        Err(error) => {
            if fixture.is_none() {
                protocol::write_message(io::stdout().lock(), Output::HotkeyUnavailable { v: 1 })?;
            }
            return Err(error.into());
        }
    };
    let data = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("REZICS")
        .join("Overlay");
    let mut context = WebContext::new(Some(data));
    let web_events = events.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_transparent(true)
        .with_focused(false)
        .with_devtools(false)
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(false)
        .with_back_forward_navigation_gestures(false)
        .with_autoplay(false)
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_https_scheme(true)
        .with_custom_protocol(SCHEME.into(), |_, request| asset(request))
        .with_navigation_handler(|url| url.parse().is_ok_and(|uri| is_view_page(&uri)))
        .with_ipc_handler(move |request| {
            if is_view_page(request.uri())
                && let Some(command) = protocol::parse_web_command(request.body())
            {
                let _ = web_events.send_event(Signal::WebView(command));
            }
        })
        .with_url(PAGE)
        .build(&window);
    let webview = match webview {
        Ok(webview) => webview,
        Err(error) => {
            if fixture.is_none() && matches!(error, wry::Error::WebView2Error(_)) {
                protocol::write_message(
                    io::stdout().lock(),
                    Output::WebView2Unavailable {
                        v: 1,
                        runtime_detected: webview_runtime_detected().then_some(true),
                    },
                )?;
            }
            return Err(error.into());
        }
    };

    let mut host = Host {
        webview,
        window,
        fixture: fixture.is_some(),
        shortcut,
        ready: false,
        mode: Visibility::Hidden,
        opening: PanelOpening::default(),
        session: None,
        process: None,
        game: null_mut(),
    };
    let _activation = ActivationSubscription::new(host.overlay_window(), events.clone())
        .map_err(|error| eprintln!("Overlay will check focus while tracking its window: {error}"))
        .ok();
    let _webview_process = WebViewProcessSubscription::new(&host.webview, events.clone())?;
    let _hotkey = hotkey;
    let mut next_check = Instant::now();
    if fixture.is_some() {
        host.attach(fixture)?;
        eprintln!("Focus the fixture window and press {label} to open the overlay.");
    } else {
        listen_to_launcher(events)?;
    }
    let mut webview_exit = None;
    event_loop.run_return(|event, _, flow| {
        let previous_mode = host.mode;
        match event {
            Event::UserEvent(signal) => {
                let result = match signal {
                    Signal::Session(session) => host.attach(session),
                    Signal::WebView(command) => host.web_command(command),
                    Signal::Hotkey { foreground } => {
                        host.close_or_open(foreground);
                        Ok(())
                    }
                    Signal::WindowDeactivated => {
                        host.focus_lost();
                        Ok(())
                    }
                    Signal::WebViewProcessExited(description) => {
                        host.ready = false;
                        host.hide(true);
                        webview_exit = Some(description);
                        *flow = ControlFlow::Exit;
                        return;
                    }
                    Signal::LauncherDisconnected => {
                        host.hide(true);
                        *flow = ControlFlow::Exit;
                        return;
                    }
                };
                if let Err(error) = result {
                    eprintln!("Launcher connection closed: {error}");
                    host.hide(true);
                    *flow = ControlFlow::Exit;
                    return;
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => host.hide(true),
            Event::MainEventsCleared if Instant::now() >= next_check => {
                host.track_window();
                if host.fixture && !host.process.as_ref().is_some_and(Process::alive) {
                    *flow = ControlFlow::Exit;
                    return;
                }
                if let Some(interval) = host.tracking_interval() {
                    next_check = Instant::now() + interval;
                }
            }
            _ => {}
        }
        *flow = match host.tracking_interval() {
            Some(interval) => {
                if previous_mode != host.mode {
                    next_check = Instant::now() + interval;
                }
                ControlFlow::WaitUntil(next_check)
            }
            None => ControlFlow::Wait,
        };
    });
    if let Some(description) = webview_exit {
        return Err(io::Error::other(description).into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
    };

    #[test]
    fn ends_the_host_only_for_browser_or_main_renderer_exit() {
        assert!(
            webview_exit_description(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED)
                .is_some()
        );
        assert!(
            webview_exit_description(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED)
                .is_some()
        );
        for kind in [
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
        ] {
            assert!(webview_exit_description(kind).is_none());
        }
    }
}
