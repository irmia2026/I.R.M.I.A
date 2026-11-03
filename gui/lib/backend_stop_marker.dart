// 「用户主动停掉她」的持久标记 —— 给计划任务里的看护脚本读。
//
// 2026-10-28 现场：用户点「退出实例 / 退出登录」回到实例选择页（16:23:16），
// 一分钟内看护脚本按"后端不在"把它**又拉了起来**（16:24:02，隐藏窗口 spawn）。
// 那次拉起之后火绒当场对 node.exe 报毒。
//
// 看护的判据原来只有一条"后端不在就拉"，它分不出两种情况：
//   · 崩了（该拉）　　· 人主动停的（不该拉）
// 这份标记就是那条分界：界面在**主动停**之后写它，看护看到它就不动手；
// 人再用快捷方式/「启动并登录」把她叫起来时，启动链把标记删掉。
//
// 为什么不用内存状态：写它的（界面）与读它的（wscript 看护）是两个进程，
// 而且看护在没有界面的情况下也会跑，唯一能共享的就是盘上的一个文件。
//
// 为什么不用"过期时间"：主动停掉可以是长期的（人就是不想让她跑），
// 过期语义会把"人停的"在几小时后变成"自己复活"——那正是这次要消掉的行为。
library;

import 'dart:io';

/// 标记文件名。放在数据目录里（与 `lock.json` 同级）：
/// 它是这台实例的状态，不是界面的偏好。
const String kBackendStoppedMarkerName = 'backend-stopped.marker';

/// 这份数据目录对应的标记文件。
File backendStoppedMarkerFile(String dataDir) {
  final dir = dataDir.trim();
  if (dir.isEmpty) return File(kBackendStoppedMarkerName);
  final sep = dir.endsWith(r'\') || dir.endsWith('/') ? '' : Platform.pathSeparator;
  return File('$dir$sep$kBackendStoppedMarkerName');
}

/// 记下"这次是人停的"（[reason] 只进日志，用来分辨是哪条出口）。
void markBackendStoppedOnPurpose(String dataDir, String reason) {
  // dataDir 读不到就**什么都不做**：往当前目录扔一个标记文件既没人读，也污染仓库
  // （2026-10-28 现场：探针把 `gui/backend-stopped.marker` 写进了工作树）。
  if (dataDir.trim().isEmpty) return;
  try {
    final file = backendStoppedMarkerFile(dataDir);
    file.parent.createSync(recursive: true);
    file.writeAsStringSync(
      '{"ts":"${DateTime.now().toUtc().toIso8601String()}","pid":$pid,"reason":"$reason"}',
      flush: true,
    );
  } catch (_) {
    // 写不下去就算了：最坏退回老行为（看护会再拉一次），不能因此挡住退出流程。
  }
}

/// 人把她叫起来了：删掉标记，看护恢复"崩了就拉"。
void clearBackendStoppedMarker(String dataDir) {
  if (dataDir.trim().isEmpty) return;
  try {
    final file = backendStoppedMarkerFile(dataDir);
    if (file.existsSync()) file.deleteSync();
  } catch (_) {
    // 同上：删不掉只会让看护少拉一次，不影响启动本身。
  }
}
