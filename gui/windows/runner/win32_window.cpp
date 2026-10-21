#include "win32_window.h"

#include <dwmapi.h>
#include <flutter_windows.h>

#include "resource.h"

namespace {

/// Window attribute that enables dark mode window decorations.
///
/// Redefined in case the developer's machine has a Windows SDK older than
/// version 10.0.22000.0.
/// See: https://docs.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

constexpr const wchar_t kWindowClassName[] = L"FLUTTER_RUNNER_WIN32_WINDOW";

/// Registry key for app theme preference.
///
/// A value of 0 indicates apps should use dark mode. A non-zero or missing
/// value indicates apps should use light mode.
constexpr const wchar_t kGetPreferredBrightnessRegKey[] =
  L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
constexpr const wchar_t kGetPreferredBrightnessRegValue[] = L"AppsUseLightTheme";

// The number of Win32Window objects that currently exist.
static int g_active_window_count = 0;

using EnableNonClientDpiScaling = BOOL __stdcall(HWND hwnd);

// Scale helper to convert logical scaler values to physical using passed in
// scale factor
int Scale(int source, double scale_factor) {
  return static_cast<int>(source * scale_factor);
}

// Dynamically loads the |EnableNonClientDpiScaling| from the User32 module.
// This API is only needed for PerMonitor V1 awareness mode.
void EnableFullDpiSupportIfAvailable(HWND hwnd) {
  HMODULE user32_module = LoadLibraryA("User32.dll");
  if (!user32_module) {
    return;
  }
  auto enable_non_client_dpi_scaling =
      reinterpret_cast<EnableNonClientDpiScaling*>(
          GetProcAddress(user32_module, "EnableNonClientDpiScaling"));
  if (enable_non_client_dpi_scaling != nullptr) {
    enable_non_client_dpi_scaling(hwnd);
  }
  FreeLibrary(user32_module);
}

// 去掉 WS_CAPTION 之后窗口在系统眼里不再有边框，阴影与圆角会一起消失。
// 把 1px 的 DWM frame 伸进客户区就能把它们要回来（客户区之上盖着 Flutter 子窗口，
// 这 1px 看不见）。圆角属性 Windows 11 才有，老系统上调用失败即可，无副作用。
void EnableBorderlessFrameEffects(HWND window) {
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif
  const int corner_preference = 2;  // DWMWCP_ROUND
  DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE,
                        &corner_preference, sizeof(corner_preference));

  MARGINS margins{1, 1, 1, 1};
  DwmExtendFrameIntoClientArea(window, &margins);
}

}  // namespace

// Manages the Win32Window's window class registration.
class WindowClassRegistrar {
 public:
  ~WindowClassRegistrar() = default;

  // Returns the singleton registrar instance.
  static WindowClassRegistrar* GetInstance() {
    if (!instance_) {
      instance_ = new WindowClassRegistrar();
    }
    return instance_;
  }

  // Returns the name of the window class, registering the class if it hasn't
  // previously been registered.
  const wchar_t* GetWindowClass();

  // Unregisters the window class. Should only be called if there are no
  // instances of the window.
  void UnregisterWindowClass();

 private:
  WindowClassRegistrar() = default;

  static WindowClassRegistrar* instance_;

  bool class_registered_ = false;
};

WindowClassRegistrar* WindowClassRegistrar::instance_ = nullptr;

const wchar_t* WindowClassRegistrar::GetWindowClass() {
  if (!class_registered_) {
    WNDCLASS window_class{};
    window_class.hCursor = LoadCursor(nullptr, IDC_ARROW);
    window_class.lpszClassName = kWindowClassName;
    window_class.style = CS_HREDRAW | CS_VREDRAW;
    window_class.cbClsExtra = 0;
    window_class.cbWndExtra = 0;
    window_class.hInstance = GetModuleHandle(nullptr);
    window_class.hIcon =
        LoadIcon(window_class.hInstance, MAKEINTRESOURCE(IDI_APP_ICON));
    window_class.hbrBackground = 0;
    window_class.lpszMenuName = nullptr;
    window_class.lpfnWndProc = Win32Window::WndProc;
    RegisterClass(&window_class);
    class_registered_ = true;
  }
  return kWindowClassName;
}

void WindowClassRegistrar::UnregisterWindowClass() {
  UnregisterClass(kWindowClassName, nullptr);
  class_registered_ = false;
}

Win32Window::Win32Window() {
  ++g_active_window_count;
}

Win32Window::~Win32Window() {
  --g_active_window_count;
  Destroy();
}

bool Win32Window::Create(const std::wstring& title,
                         const Point& origin,
                         const Size& size) {
  Destroy();

  const wchar_t* window_class =
      WindowClassRegistrar::GetInstance()->GetWindowClass();

  // 传进来的 |origin|/|size| 是**逻辑**尺寸（1350×900），这里按系统 DPI 换算成物理像素。
  // 反过来把 1350×900 当物理像素用（150% 缩放下只有 900×600 逻辑）会让界面按 900×600 布局：
  // 侧边栏七项加底部「更多」组溢出，日志与设置永远看不见——所以这里必须是逻辑值。
  const UINT dpi = GetDpiForSystem();
  const double scale_factor = dpi == 0 ? 1.0 : dpi / 96.0;
  const int want_w = Scale(static_cast<int>(size.width), scale_factor);
  const int want_h = Scale(static_cast<int>(size.height), scale_factor);

  // 固定尺寸窗口（docs/gui-design.md §2）：去掉 WS_THICKFRAME（拖边缩放）与
  // WS_MAXIMIZEBOX（最大化），保留系统菜单与最小化。
  // 再去掉 WS_CAPTION：系统的标题栏与边框整个消失，客户区吃满窗口，
  // 标题与右上角按钮改由 Flutter 自绘——系统的标题栏没法把标题摆到中间，
  // 也去不掉左边那个图标（docs/gui-revision.md ①）。
  // WS_SYSMENU 必须留着：Alt+Space 系统菜单、Alt+F4、任务栏右键都走它。
  const DWORD fixed_style = WS_OVERLAPPED | WS_SYSMENU | WS_MINIMIZEBOX;

  RECT work_area{0, 0, 0, 0};
  SystemParametersInfo(SPI_GETWORKAREA, 0, &work_area, 0);
  const int max_w = (work_area.right - work_area.left) - 20;
  const int max_h = (work_area.bottom - work_area.top) - 40;
  int final_w = want_w;
  int final_h = want_h;
  if (final_w > max_w && max_w > 0) final_w = max_w;
  if (final_h > max_h && max_h > 0) final_h = max_h;

  HWND window = CreateWindow(
      window_class, title.c_str(), fixed_style,
      0, 0, final_w, final_h,
      nullptr, nullptr, GetModuleHandle(nullptr), this);

  if (!window) {
    return false;
  }

  // 创建后按最终尺寸居中偏上落位并锁定（配合 flutter_window.cpp 的 WM_GETMINMAXINFO）
  if (work_area.right > work_area.left) {
    const int x = work_area.left + ((work_area.right - work_area.left) - final_w) / 2;
    const int y = work_area.top + ((work_area.bottom - work_area.top) - final_h) / 3;
    SetWindowPos(window, nullptr, x < work_area.left ? work_area.left : x,
                 y < work_area.top ? work_area.top : y,
                 final_w, final_h,
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }

  UpdateTheme(window);
  EnableBorderlessFrameEffects(window);

  // 样式必须再钉一遍：CreateWindow 会把 WS_CAPTION 加回来（带 WS_SYSMENU 却没有标题栏的
  // 窗口，系统按"有边框"处理，实测创建后 style=0x04CA0000）。钉回之后还要 SWP_FRAMECHANGED
  // 让系统重算一次非客户区，WM_NCCALCSIZE 那一次询问才作数，客户区才真的吃满整个窗口
  // （实测：钉之前 1335x862，钉之后 1350x900）。
  SetWindowLongPtr(window, GWL_STYLE, fixed_style);
  SetWindowPos(window, nullptr, 0, 0, 0, 0,
               SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER |
                   SWP_NOACTIVATE);

  return OnCreate();
}

bool Win32Window::Show() {
  return ShowWindow(window_handle_, SW_SHOWNORMAL);
}

// static
LRESULT CALLBACK Win32Window::WndProc(HWND const window,
                                      UINT const message,
                                      WPARAM const wparam,
                                      LPARAM const lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto window_struct = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(window, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(window_struct->lpCreateParams));

    auto that = static_cast<Win32Window*>(window_struct->lpCreateParams);
    EnableFullDpiSupportIfAvailable(window);
    that->window_handle_ = window;
  } else if (Win32Window* that = GetThisFromHandle(window)) {
    return that->MessageHandler(window, message, wparam, lparam);
  }

  return DefWindowProc(window, message, wparam, lparam);
}

LRESULT
Win32Window::MessageHandler(HWND hwnd,
                            UINT const message,
                            WPARAM const wparam,
                            LPARAM const lparam) noexcept {
  switch (message) {
    // 自绘标题栏（docs/gui-revision.md ①）：非客户区算成零，客户区 = 整个窗口。
    // wparam == FALSE 是"只算不画"的询问，按默认走。
    // 注意：FlutterWindow::MessageHandler 会先一步拦下 wparam == TRUE 的那种
    // （插件链抢在 WndProc 之前处理 WM_NCCALCSIZE，见那里的注释），这里是兜底。
    case WM_NCCALCSIZE:
      if (wparam == TRUE) {
        return 0;
      }
      break;

    // 已经没有非客户区可画了，吞掉这个默认处理：否则每次窗口获得/失去焦点，
    // 系统都会按"标题栏还活着"重画一遍高光，在客户区顶上闪一下。
    case WM_NCACTIVATE:
      return 1;

    case WM_DESTROY:
      window_handle_ = nullptr;
      Destroy();
      if (quit_on_close_) {
        PostQuitMessage(0);
      }
      return 0;

    case WM_DPICHANGED: {
      auto newRectSize = reinterpret_cast<RECT*>(lparam);
      LONG newWidth = newRectSize->right - newRectSize->left;
      LONG newHeight = newRectSize->bottom - newRectSize->top;

      SetWindowPos(hwnd, nullptr, newRectSize->left, newRectSize->top, newWidth,
                   newHeight, SWP_NOZORDER | SWP_NOACTIVATE);

      return 0;
    }
    case WM_SIZE: {
      RECT rect = GetClientArea();
      if (child_content_ != nullptr) {
        // Size and position the child window.
        MoveWindow(child_content_, rect.left, rect.top, rect.right - rect.left,
                   rect.bottom - rect.top, TRUE);
      }
      return 0;
    }

    case WM_ACTIVATE:
      if (child_content_ != nullptr) {
        SetFocus(child_content_);
      }
      return 0;

    case WM_DWMCOLORIZATIONCOLORCHANGED:
      UpdateTheme(hwnd);
      return 0;
  }

  return DefWindowProc(window_handle_, message, wparam, lparam);
}

void Win32Window::Destroy() {
  OnDestroy();

  if (window_handle_) {
    DestroyWindow(window_handle_);
    window_handle_ = nullptr;
  }
  if (g_active_window_count == 0) {
    WindowClassRegistrar::GetInstance()->UnregisterWindowClass();
  }
}

Win32Window* Win32Window::GetThisFromHandle(HWND const window) noexcept {
  return reinterpret_cast<Win32Window*>(
      GetWindowLongPtr(window, GWLP_USERDATA));
}

void Win32Window::SetChildContent(HWND content) {
  child_content_ = content;
  SetParent(content, window_handle_);
  RECT frame = GetClientArea();

  MoveWindow(content, frame.left, frame.top, frame.right - frame.left,
             frame.bottom - frame.top, true);

  SetFocus(child_content_);
}

RECT Win32Window::GetClientArea() {
  RECT frame;
  GetClientRect(window_handle_, &frame);
  return frame;
}

HWND Win32Window::GetHandle() {
  return window_handle_;
}

void Win32Window::SetQuitOnClose(bool quit_on_close) {
  quit_on_close_ = quit_on_close;
}

bool Win32Window::OnCreate() {
  // No-op; provided for subclasses.
  return true;
}

void Win32Window::OnDestroy() {
  // No-op; provided for subclasses.
}

void Win32Window::UpdateTheme(HWND const window) {
  DWORD light_mode;
  DWORD light_mode_size = sizeof(light_mode);
  LSTATUS result = RegGetValue(HKEY_CURRENT_USER, kGetPreferredBrightnessRegKey,
                               kGetPreferredBrightnessRegValue,
                               RRF_RT_REG_DWORD, nullptr, &light_mode,
                               &light_mode_size);

  if (result == ERROR_SUCCESS) {
    BOOL enable_dark_mode = light_mode == 0;
    DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE,
                          &enable_dark_mode, sizeof(enable_dark_mode));
  }
}
