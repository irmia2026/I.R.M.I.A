#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  // 窗口规格见 docs/gui-design.md §2：逻辑 1350×900（物理像素 = 本值 × 系统 DPI 缩放）。
  // 标题走 ASCII：MSVC 在 GBK 代码页下对源码里的中文字面量报 C4819（警告即错误），
  // 中文名在 Dart 侧（MaterialApp.title）与窗口内品牌区表达。
  Win32Window::Point origin(80, 60);
  Win32Window::Size size(kFixedWindowWidth, kFixedWindowHeight);
  // 窗口文字在自绘标题栏之后只剩 Alt+Tab 与任务栏悬停会显示，取值与画出来的标题一致。
  if (!window.Create(L"Irmia Agent Framework", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
