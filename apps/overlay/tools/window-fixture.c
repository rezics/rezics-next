#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const wchar_t window_class[] = L"RezicsQualificationWindow";
static BOOL is_peer;
static HWND primary_window;
static HWND sibling_window;
static unsigned clicks;
static LONG_PTR windowed_style;
static RECT windowed_bounds;

static BOOL toggle_borderless(HWND window) {
    UINT flags = SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    if (windowed_style) {
        if (!SetWindowLongPtrW(window, GWL_STYLE, windowed_style) ||
            !SetWindowPos(window, HWND_NOTOPMOST, windowed_bounds.left, windowed_bounds.top,
                          windowed_bounds.right - windowed_bounds.left, windowed_bounds.bottom - windowed_bounds.top,
                          flags)) return FALSE;
        windowed_style = 0;
        return TRUE;
    }

    WINDOWINFO info = {0};
    info.cbSize = sizeof(info);
    if (!GetWindowRect(window, &windowed_bounds) || !GetWindowInfo(window, &info)) return FALSE;
    LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
    if (!style || !SetWindowLongPtrW(window, GWL_STYLE, (style & ~WS_OVERLAPPEDWINDOW) | WS_POPUP)) return FALSE;
    RECT client = info.rcClient;
    if (!SetWindowPos(window, HWND_TOPMOST, client.left, client.top, client.right - client.left,
                      client.bottom - client.top, flags)) return FALSE;
    windowed_style = style;
    return TRUE;
}

static LRESULT CALLBACK handle_message(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_KEYDOWN && wparam == VK_F7 && !is_peer && window == primary_window) {
        if (!toggle_borderless(window)) fputs("Could not toggle the fixture's borderless mode.\n", stderr);
        return 0;
    }
    if (message == WM_KEYDOWN && wparam == VK_F8 && !is_peer && window == primary_window) {
        MessageBoxW(window, L"Press Enter to return to the game fixture.",
                    L"REZICS qualification game prompt", MB_OK);
        return 0;
    }
    switch (message) {
        case WM_DPICHANGED: {
            const RECT *bounds = (const RECT *)lparam;
            SetWindowPos(window, NULL, bounds->left, bounds->top, bounds->right - bounds->left,
                         bounds->bottom - bounds->top, SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        case WM_LBUTTONDOWN:
            printf("fixture-pointer %u\n", ++clicks);
            fflush(stdout);
            if (!is_peer && (window == primary_window || window == sibling_window)) {
                const char *file = window == primary_window ? "qualification-pointer.txt" : "qualification-sibling-pointer.txt";
                FILE *positions = fopen(file, "ab");
                if (positions) {
                    fputs("click\n", positions);
                    fclose(positions);
                }
            }
            return 0;
        case WM_PAINT: {
            PAINTSTRUCT paint;
            HDC context = BeginPaint(window, &paint);
            RECT client;
            GetClientRect(window, &client);
            DrawTextW(context, L"REZICS Windows qualification window", -1, &client,
                      DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            EndPaint(window, &paint);
            return 0;
        }
        case WM_TIMER:
            DestroyWindow(window);
            return 0;
        case WM_DESTROY:
            if (window == primary_window) {
                printf("fixture-exit\n");
                fflush(stdout);
                PostQuitMessage(0);
            }
            return 0;
        default:
            return DefWindowProcW(window, message, wparam, lparam);
    }
}

static BOOL publish_start(HWND window) {
    FILETIME born, exited, kernel, user;
    if (!GetProcessTimes(GetCurrentProcess(), &born, &exited, &kernel, &user)) return FALSE;
    uint64_t ticks = ((uint64_t)born.dwHighDateTime << 32) | born.dwLowDateTime;
    unsigned long long started = ticks / 10000 - UINT64_C(11644473600000);
    unsigned long pid = GetCurrentProcessId();
    if (!is_peer) {
        if (!CreateDirectoryW(L"saves", NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
        FILE *save = fopen("saves/checkpoint.txt", "wb");
        if (!save) return FALSE;
        fputs("REZICS Windows fixture checkpoint\n", save);
        if (fclose(save)) return FALSE;

        FILE *marker = fopen("qualification-session.tmp", "wb");
        if (!marker) return FALSE;
        fprintf(marker, "{\"pid\":%lu,\"startedAt\":%llu}\n", pid, started);
        if (fclose(marker)) return FALSE;
        if (!MoveFileExW(L"qualification-session.tmp", L"qualification-session.json", MOVEFILE_REPLACE_EXISTING)) {
            return FALSE;
        }
    }
    printf("fixture-ready %lu %llu %llu\n", pid, started, (unsigned long long)(uintptr_t)window);
    fflush(stdout);
    return TRUE;
}

static int hold_default_hotkey(void) {
    const int id = 1;
    if (!RegisterHotKey(NULL, id, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_SPACE)) {
        fprintf(stderr, "Could not reserve Ctrl+Shift+Space: %lu\n", (unsigned long)GetLastError());
        return 7;
    }
    puts("hotkey-held");
    fflush(stdout);
    getchar();
    return UnregisterHotKey(NULL, id) ? 0 : 8;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--hold-default-hotkey") == 0) return hold_default_hotkey();
    is_peer = argc == 2 && strcmp(argv[1], "--peer") == 0;
    BOOL with_sibling = argc == 2 && strcmp(argv[1], "--with-sibling") == 0;
    if (argc > 2 || (argc == 2 && !is_peer && !with_sibling)) return 1;
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    HINSTANCE module = GetModuleHandleW(NULL);
    WNDCLASSW type = {0};
    type.hInstance = module;
    type.lpfnWndProc = handle_message;
    type.lpszClassName = window_class;
    type.hCursor = LoadCursorW(NULL, MAKEINTRESOURCEW(32512));
    type.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    if (!RegisterClassW(&type)) return 2;

    RECT screen;
    if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &screen, 0)) return 3;
    int width = screen.right - screen.left;
    int height = screen.bottom - screen.top;
    HWND window = CreateWindowExW(
        0, window_class, is_peer ? L"REZICS qualification peer" : L"REZICS qualification game",
        WS_OVERLAPPEDWINDOW, screen.left + (is_peer ? width * 72 / 100 : 28), screen.top + 48,
        width * (is_peer ? 24 : 63) / 100, height * 70 / 100, NULL, NULL, module, NULL);
    if (!window) return 4;
    primary_window = window;
    ShowWindow(window, SW_SHOW);
    if (with_sibling) {
        DPI_AWARENESS_CONTEXT previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_UNAWARE);
        if (!previous) return 4;
        sibling_window = CreateWindowExW(
            WS_EX_LAYOUTRTL, window_class, L"REZICS qualification sibling", WS_OVERLAPPEDWINDOW,
            0, 0, 400, 260, NULL, NULL, module, NULL);
        if (!SetThreadDpiAwarenessContext(previous) || !sibling_window ||
            !SetWindowPos(sibling_window, NULL, screen.left + width * 69 / 100, screen.top + height * 67 / 100,
                          width * 27 / 100, height * 29 / 100, SWP_NOZORDER | SWP_NOACTIVATE)) return 4;
        ShowWindow(sibling_window, SW_SHOWNOACTIVATE);
    }
    if (!publish_start(window) || !SetTimer(window, 1, 300000, NULL)) return 5;

    MSG message;
    int status;
    while ((status = GetMessageW(&message, NULL, 0, 0)) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return status < 0 ? 6 : 0;
}
