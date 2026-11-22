using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class QualificationWindows
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rectangle
    {
        public int Left, Top, Right, Bottom;
        public override string ToString() { return String.Format("{0},{1},{2},{3}", Left, Top, Right, Bottom); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowInfo
    {
        public uint Size;
        public Rectangle Window, Client;
        public uint Style, ExtendedStyle, Status, BorderX, BorderY;
        public ushort Type, CreatorVersion;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputData
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public InputData Data; }

    private delegate bool WindowVisitor(IntPtr window, IntPtr data);
    private delegate bool MonitorVisitor(IntPtr monitor, IntPtr dc, ref Rectangle area, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int limit);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relationship);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll", ExactSpelling = true)] private static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern bool GetWindowInfo(IntPtr window, ref WindowInfo info);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorVisitor visitor, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);

    public static bool IsWine()
    {
        IntPtr ntdll = GetModuleHandle("ntdll.dll");
        return ntdll != IntPtr.Zero && GetProcAddress(ntdll, "wine_get_version") != IntPtr.Zero;
    }

    public static IntPtr Find(int process, string title)
    {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            StringBuilder text = new StringBuilder(128);
            GetWindowText(window, text, text.Capacity);
            if (text.ToString() != title) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr Foreground()
    {
        IntPtr window = GetForegroundWindow();
        return window == IntPtr.Zero ? window : GetAncestor(window, 2);
    }

    public static bool IsMirroredDpiUnaware(IntPtr window)
    {
        const int extendedStyle = -20;
        const long layoutRightToLeft = 0x00400000;
        return (GetWindowLongPtrW(window, extendedStyle).ToInt64() & layoutRightToLeft) != 0 &&
            AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), new IntPtr(-1));
    }

    public static bool IsTopmost(IntPtr window)
    {
        const int extendedStyle = -20;
        const long topmost = 0x8;
        return (GetWindowLongPtrW(window, extendedStyle).ToInt64() & topmost) != 0;
    }

    public static bool IsAbove(IntPtr upper, IntPtr lower)
    {
        const uint previousWindow = 3;
        for (int steps = 0; steps < 128 && lower != IntPtr.Zero; ++steps)
        {
            lower = GetWindow(lower, previousWindow);
            if (lower == upper) return true;
        }
        return false;
    }

    public static Rectangle Bounds(IntPtr window, bool client)
    {
        IntPtr previous = EnterPhysicalCoordinates();
        try
        {
            WindowInfo info = new WindowInfo { Size = (uint)Marshal.SizeOf(typeof(WindowInfo)) };
            if (!GetWindowInfo(window, ref info)) throw new InvalidOperationException("Could not read window bounds.");
            return client ? info.Client : info.Window;
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }

    public static void Move(IntPtr window)
    {
        Rectangle bounds = Bounds(window, false);
        bounds.Left += 32;
        bounds.Top += 24;
        bounds.Right += 16;
        bounds.Bottom += 12;
        MoveTo(window, bounds);
    }

    public static void MoveTo(IntPtr window, Rectangle bounds)
    {
        IntPtr previous = EnterPhysicalCoordinates();
        try
        {
            const uint noZOrderOrActivation = 0x4 | 0x10;
            if (!SetWindowPos(window, IntPtr.Zero, bounds.Left, bounds.Top,
                              bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, noZOrderOrActivation))
                throw new InvalidOperationException("Could not move and resize the controlled fixture window.");
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }

    public static Rectangle[] OtherDisplays(IntPtr window)
    {
        IntPtr previous = EnterPhysicalCoordinates();
        try
        {
            IntPtr current = MonitorFromWindow(window, 2);
            List<Rectangle> displays = new List<Rectangle>();
            if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
                    delegate(IntPtr monitor, IntPtr dc, ref Rectangle area, IntPtr data) {
                        if (monitor != current && area.Right > area.Left && area.Bottom > area.Top)
                            displays.Add(area);
                        return true;
                    }, IntPtr.Zero))
                throw new InvalidOperationException("Could not enumerate the qualification desktop's displays.");
            return displays.ToArray();
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }

    public static void SetMinimized(IntPtr window, bool minimized)
    {
        const int minimize = 6;
        const int restore = 9;
        if (!ShowWindowAsync(window, minimized ? minimize : restore))
            throw new InvalidOperationException("Could not change the controlled fixture window state.");
    }

    public static void Click(int x, int y, IntPtr target, IntPtr otherAllowed)
    {
        IntPtr previous = EnterPhysicalCoordinates();
        try
        {
            Point point = new Point { X = x, Y = y };
            IntPtr hit = GetAncestor(WindowFromPoint(point), 2);
            if (hit == IntPtr.Zero || (hit != target && hit != otherAllowed))
                throw new InvalidOperationException("A window outside the qualification owns the click point.");
            if (!SetCursorPos(x, y)) throw new InvalidOperationException("Could not move the cursor to the fixture.");
            Input[] events = new Input[2];
            events[0].Data.Mouse.Flags = 0x2;
            events[1].Data.Mouse.Flags = 0x4;
            Send(events);
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }

    public static void Press(IntPtr target, ushort[] keys)
    {
        if (Foreground() != target) throw new InvalidOperationException("A window outside the expected input mode has focus.");
        Input[] events = new Input[keys.Length * 2];
        for (int i = 0; i < keys.Length; i++)
        {
            events[i].Type = 1;
            events[i].Data.Keyboard.Key = keys[i];
            int release = events.Length - 1 - i;
            events[release].Type = 1;
            events[release].Data.Keyboard.Key = keys[i];
            events[release].Data.Keyboard.Flags = 2;
        }
        Send(events);
    }

    public static void Close(IntPtr window)
    {
        if (!PostMessage(window, 0x10, UIntPtr.Zero, IntPtr.Zero))
            throw new InvalidOperationException("Could not close the controlled fixture window.");
    }

    private static IntPtr EnterPhysicalCoordinates()
    {
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new InvalidOperationException("Could not switch to per-monitor DPI coordinates.");
        return previous;
    }

    private static void Send(Input[] events)
    {
        if (SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input))) != events.Length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The desktop did not accept qualification input.");
    }
}
