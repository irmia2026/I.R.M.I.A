// Windows 上"起一个后台进程、但**一个窗口都不许出现**"的唯一可靠做法。
//
// 为什么不能用 `Process.start`：它给不了 `CREATE_NO_WINDOW`，而内置的 `node.exe` 是
// 控制台子系统程序 ⇒ 系统会给它分一个控制台 ⇒ 屏幕上多一个黑窗口。
//
// 为什么不能用 `conhost.exe --headless` 包一层（2026-10-26 试过、已撤回）：
// 2026-10-27 火绒把那个形态判成 `ADV:Ransom/Genalocker.A` 并**删掉了 node.exe**
// （"无窗口控制台宿主 + 大堆参数"正是勒索软件的常见形态）。宁可写这三十行 FFI。
//
// 也不用 `Start-Process -WindowStyle Hidden`：那是"先创建窗口再隐藏"，
// 在把 Windows Terminal 设为默认终端的机器上照样会闪一个标签页。
//
// 这里做的事情就是 CreateProcessW + `CREATE_NO_WINDOW`，等价于 C 里那句：
//   CreateProcessW(NULL, cmdline, NULL, NULL, FALSE, CREATE_NO_WINDOW, env, cwd, &si, &pi)
library;

import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// `dwCreationFlags`：进程是控制台程序，但**不要**给它的控制台分配窗口。
const int _createNoWindow = 0x08000000;

/// 不继承父进程的控制台（双保险：父进程本来就没有控制台）。
const int _detachedProcess = 0x00000008;

const int _startfUseShowWindow = 0x00000001;
const int _swHide = 0;

final class _StartupInfoW extends Struct {
  @Uint32()
  external int cb;

  external Pointer<Utf16> lpReserved;
  external Pointer<Utf16> lpDesktop;
  external Pointer<Utf16> lpTitle;

  @Uint32()
  external int dwX;
  @Uint32()
  external int dwY;
  @Uint32()
  external int dwXSize;
  @Uint32()
  external int dwYSize;
  @Uint32()
  external int dwXCountChars;
  @Uint32()
  external int dwYCountChars;
  @Uint32()
  external int dwFillAttribute;
  @Uint32()
  external int dwFlags;

  @Uint16()
  external int wShowWindow;
  @Uint16()
  external int cbReserved2;

  external Pointer<Uint8> lpReserved2;
  external Pointer<IntPtr> hStdInput;
  external Pointer<IntPtr> hStdOutput;
  external Pointer<IntPtr> hStdError;
}

final class _ProcessInformation extends Struct {
  external Pointer<IntPtr> hProcess;
  external Pointer<IntPtr> hThread;

  @Uint32()
  external int dwProcessId;
  @Uint32()
  external int dwThreadId;
}

typedef _CreateProcessWNative = Int32 Function(
  Pointer<Utf16> lpApplicationName,
  Pointer<Utf16> lpCommandLine,
  Pointer<Void> lpProcessAttributes,
  Pointer<Void> lpThreadAttributes,
  Int32 bInheritHandles,
  Uint32 dwCreationFlags,
  Pointer<Void> lpEnvironment,
  Pointer<Utf16> lpCurrentDirectory,
  Pointer<_StartupInfoW> lpStartupInfo,
  Pointer<_ProcessInformation> lpProcessInformation,
);

typedef _CreateProcessWDart = int Function(
  Pointer<Utf16>,
  Pointer<Utf16>,
  Pointer<Void>,
  Pointer<Void>,
  int,
  int,
  Pointer<Void>,
  Pointer<Utf16>,
  Pointer<_StartupInfoW>,
  Pointer<_ProcessInformation>,
);

typedef _CloseHandleNative = Int32 Function(Pointer<IntPtr>);
typedef _CloseHandleDart = int Function(Pointer<IntPtr>);

final class _Kernel32 {
  static final DynamicLibrary _lib = DynamicLibrary.open('kernel32.dll');

  static final _CreateProcessWDart createProcessW =
      _lib.lookupFunction<_CreateProcessWNative, _CreateProcessWDart>('CreateProcessW');

  static final _CloseHandleDart closeHandle =
      _lib.lookupFunction<_CloseHandleNative, _CloseHandleDart>('CloseHandle');
}

/// 起一个**没有窗口**的进程；成功返回它的 pid，失败返回 0。
///
/// [exe] 是可执行文件绝对路径；[args] 只放参数（可执行文件路径会由这里拼成命令行）；
/// [workingDirectory] 是子进程的工作目录（传空则用当前目录）。
int spawnDetachedNoWindow({
  required String exe,
  required List<String> args,
  required String workingDirectory,
}) {
  if (!Platform.isWindows) return 0;
  if (exe.trim().isEmpty) return 0;

  final createProcessW = _Kernel32.createProcessW;
  final closeHandle = _Kernel32.closeHandle;

  // CreateProcessW 要的是**一整条命令行**：可执行文件路径自己那一格用引号包住，
  // 后面按参数逐个加引号（参数里的引号按 Windows 的规矩转义成 \"）。
  final commandLine = <String>[_quote(exe), ...args.map(_quote)].join(' ');

  final exePtr = exe.toNativeUtf16();
  final cmdPtr = commandLine.toNativeUtf16();
  final cwdPtr = workingDirectory.trim().isEmpty ? nullptr.cast<Utf16>() : workingDirectory.toNativeUtf16();
  final si = calloc<_StartupInfoW>();
  final pi = calloc<_ProcessInformation>();
  try {
    si.ref.cb = sizeOf<_StartupInfoW>();
    si.ref.dwFlags = _startfUseShowWindow;
    si.ref.wShowWindow = _swHide;
    final ok = createProcessW(
      exePtr,
      cmdPtr,
      nullptr,
      nullptr,
      0, // 不继承句柄：子进程拿不到界面这边的 stdio
      _createNoWindow | _detachedProcess,
      nullptr,
      cwdPtr,
      si,
      pi,
    );
    if (ok == 0) return 0;
    closeHandle(pi.ref.hProcess);
    closeHandle(pi.ref.hThread);
    return pi.ref.dwProcessId;
  } finally {
    calloc.free(si);
    calloc.free(pi);
    calloc.free(exePtr);
    calloc.free(cmdPtr);
    if (cwdPtr != nullptr.cast<Utf16>()) calloc.free(cwdPtr);
  }
}

/// 按 Windows 命令行规则把一格参数包起来。
///
/// 只有含空白、引号或为空时才加引号（`--data-dir` 这类不需要，加了也不坏，只是更长）。
String _quote(String raw) {
  if (raw.isEmpty) return '""';
  if (!raw.contains(RegExp(r'[\s"]'))) return raw;
  final buffer = StringBuffer('"');
  var backslashes = 0;
  for (final rune in raw.runes) {
    final char = String.fromCharCode(rune);
    if (char == r'\') {
      backslashes++;
      continue;
    }
    if (char == '"') {
      buffer.write(r'\' * (backslashes * 2 + 1));
      buffer.write('"');
      backslashes = 0;
      continue;
    }
    buffer.write(r'\' * backslashes);
    backslashes = 0;
    buffer.write(char);
  }
  buffer.write(r'\' * (backslashes * 2));
  buffer.write('"');
  return buffer.toString();
}

