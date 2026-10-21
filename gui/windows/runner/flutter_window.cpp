#include "flutter_window.h"

#include <optional>

#include "flutter/generated_plugin_registrant.h"

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  // 自绘标题栏的窗口动作（docs/gui-revision.md ①）。窗口去掉系统标题栏之后，
  // 拖动/最小化/关闭这三件事系统不再代劳，只能由 Flutter 那边发起、这里执行。
  window_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), "irmia/window",
          &flutter::StandardMethodCodec::GetInstance());
  window_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        const std::string& method = call.method_name();
        if (method == "startDragging") {
          // 交给系统的移动循环：先松开鼠标捕获（否则窗口不动），
          // 再把自己当成"标题栏被按下"。这条消息在鼠标按键仍按着时才进得去循环，
          // 所以 Dart 侧用的是按下即触发（onPanDown），不是等拖拽阈值。
          ReleaseCapture();
          SendMessage(GetHandle(), WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
          result->Success();
        } else if (method == "minimize") {
          ShowWindow(GetHandle(), SW_MINIMIZE);
          result->Success();
        } else if (method == "close") {
          // 走 WM_CLOSE 而不是直接 DestroyWindow：WM_DESTROY → PostQuitMessage
          // 这条既有的退出链路照常走下去（与点系统标题栏的叉一致）。
          PostMessage(GetHandle(), WM_CLOSE, 0, 0);
          result->Success();
        } else {
          result->NotImplemented();
        }
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // 自绘标题栏要求「客户区 = 整个窗口」（win32_window.cpp 的 WM_NCCALCSIZE 分支）。
  // 这条约定必须在**插件之前**认领：插件是通过下面那句 HandleTopLevelWindowProc
  // 拿到消息的，排在它后面就等于把客户区尺寸的决定权让给了插件。
  //
  // 2026-10-04 踩过（窗口右侧与底部一条 L 形黑边）：window_manager 0.5.2 的
  // Windows 侧注册了 top-level 窗口过程委托，只要 Dart 那边调用过
  // setTitleBarStyle(TitleBarStyle.hidden)（title_bar_style_ == "hidden"），它就会在
  // WM_NCCALCSIZE 里把客户区四边各削掉 8 物理像素（window_manager_plugin.cpp 的
  // adjustNCCALCSIZE/那三行 `-= 8`，硬编码、不随 DPI 缩放），然后 return 0 把消息吃掉。
  // 于是 Flutter 子窗口比窗口小一圈，那圈没有任何东西去绘制 —— 露出底色（黑）。
  //
  // 本窗口是固定尺寸、不可拖边缩放的（Create 里没有 WS_THICKFRAME，WM_GETMINMAXINFO
  // 又把上下限钳成同一个值），插件那圈「留给鼠标拖拽」的边距在这里只有坏处，
  // 所以直接不给它这个机会：见下面 wparam == TRUE 的提前返回。
  if (message == WM_NCCALCSIZE && wparam == TRUE) {
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    // 固定尺寸窗口（docs/gui-design.md §2）：把可调整范围的上下限钳成同一值——
    // 拖边/双击标题栏/系统菜单最大化都改不动尺寸。逻辑尺寸见 win32_window.h 的两个常量，
    // 这里按当前窗口 DPI 换算成物理像素；屏幕装不下时退让（与 Create 的口径一致）。
    case WM_GETMINMAXINFO: {
      const UINT dpi = GetDpiForWindow(hwnd);
      const double scale_factor = dpi == 0 ? 1.0 : dpi / 96.0;
      int w = static_cast<int>(kFixedWindowWidth * scale_factor);
      int h = static_cast<int>(kFixedWindowHeight * scale_factor);

      RECT work_area{0, 0, 0, 0};
      SystemParametersInfo(SPI_GETWORKAREA, 0, &work_area, 0);
      if (work_area.right > work_area.left) {
        const int max_w = (work_area.right - work_area.left) - 20;
        const int max_h = (work_area.bottom - work_area.top) - 40;
        if (w > max_w && max_w > 0) w = max_w;
        if (h > max_h && max_h > 0) h = max_h;
      }

      auto* info = reinterpret_cast<MINMAXINFO*>(lparam);
      info->ptMinTrackSize.x = w;
      info->ptMinTrackSize.y = h;
      info->ptMaxTrackSize.x = w;
      info->ptMaxTrackSize.y = h;
      return 0;
    }
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
