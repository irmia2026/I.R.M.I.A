import 'dart:io';

import 'package:irmia_gui/win_spawn.dart';

/// 探针：用 [spawnDetachedNoWindow] 起一个短命 node，打印 pid。
///
/// 人工核对"起之前/起之后 conhost 数量是否变化"（不变 = 没有控制台窗口）。
///
/// 用法：`dart run tool/spawn_probe.dart <node.exe 绝对路径>`
/// **不给默认值**：这里曾经写死过开发机上的绝对路径（含用户名），而那串东西
/// 会被脱敏闸门当成"私有内容"拦下来（2026-10-29 实测）。工具脚本一律"参数进、不猜"。
void main(List<String> args) {
  if (args.isEmpty || args[0].trim().isEmpty) {
    stderr.writeln('用法：dart run tool/spawn_probe.dart <node.exe 绝对路径>');
    exitCode = 2;
    return;
  }
  final exe = args[0].trim();
  final pid = spawnDetachedNoWindow(
    exe: exe,
    args: ['-e', 'setTimeout(()=>{}, 12000)'],
    workingDirectory: File(exe).parent.parent.parent.path,
  );
  stdout.writeln('spawned pid=$pid');
}
