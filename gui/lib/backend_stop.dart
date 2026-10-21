/// 托盘「退出全部（界面 + 后端）」里**真正把后端停掉**的那一步。
///
/// ## 为什么界面这一侧只能这么做（先把"不猜"这条讲清）
///
/// 后端**没有**停机端点（`src/web/server.ts` 的 `/api/commands/*` 里没有 shutdown/stop，
/// 2026-10-17 逐条核过），而 `docs/gui-guard.md` 明确不建议让界面去 `Process.run` 一条
/// node/脚本命令行——那会把"后端的 node 在哪、脚本在哪"变成界面要猜的东西。
/// 所以这里换一种**不猜路径**的判据：**谁在监听界面正在用的那个端口，谁就是后端**。
///
/// 这也是为什么用端口而不是 `data/lock.json`：那份锁是后端的权威记录，但界面不知道 dataDir
/// （唯一的来源 `/api/doctor` 本机实测要 **7 秒**——那是个体检端点，让它挡在退出路径上不合适）。
///
/// ## 为什么是 `taskkill /T`（连子进程一起）
///
/// 内置协议端 SnowLuma 是**后端的子进程**（本机实测：`node.exe … data\services\snowluma\index.mjs`，
/// 父进程正是 `dist\main.js` 那个 node）。只杀父进程会把它落成一个**孤儿进程**——
/// 界面上写着"退出全部"，QQ 那边却还挂着一个协议端，那比现在这个毛病更糟。
/// `taskkill /PID <pid> /T /F` 杀的是一整棵树，`/T` 就是这个意思。
///
/// ## 硬杀的代价（如实写在确认框里，见 `AppStrings.quitAllConfirmBody`）
///
/// Windows 上**没有**能从外部送达的优雅停机（`tools/stop-agent.ps1` 的文件头用过四种发法实测：
/// 控制台事件够不着、`Stop-Process` 就是 `TerminateProcess`）。硬杀会丢掉
/// `session/end`、投影缓存落盘、定时器 flush 与协议端的收尸——框架本身按"随时被杀"设计，
/// 下次启动 `recover` 会把未闭合的 turn 结算掉，但**协议端的登录态可能要人再登一次**。
library;

import 'dart:async';
import 'dart:io';

/// 外部命令的替身口：真机 = [Process.run]，用例 = 自己录一笔的假函数。
typedef ProcessRunner = Future<ProcessResult> Function(String exe, List<String> args);

/// TCP 探活口：真机 = 连一下那个端口，用例 = 直接给答案。
typedef PortProbe = Future<bool> Function(String host, int port);

/// `netstat -ano` 里**监听 [port]** 的那几行 ⇒ `(本地地址, pid)`。
///
/// 只认 `TCP` 行、状态以 `LISTEN` 开头、本地地址以 `:<port>` 结尾的行。
/// 纯函数（用例用真 netstat 的三行原文钉着），不碰系统：
///
/// ```
///   TCP    127.0.0.1:7788         0.0.0.0:0              LISTENING       2168
///   TCP    [::1]:7788             [::]:0                 LISTENING       2168
///   TCP    127.0.0.1:7788         127.0.0.1:51000        ESTABLISHED     2168
/// ```
/// 最后那行**不算**（不是监听），否则"谁在监听"会被"谁正连着"污染。
List<({String address, int pid})> listenersOnPort(String output, int port) {
  final suffix = ':$port';
  final found = <({String address, int pid})>[];
  for (final rawLine in output.split(RegExp(r'\r?\n'))) {
    final fields = rawLine.trim().split(RegExp(r'\s+'));
    if (fields.length < 5) continue;
    if (fields.first.toUpperCase() != 'TCP') continue;
    final address = fields[1];
    if (!address.endsWith(suffix)) continue;
    // 状态列：`netstat` 的状态词不随系统语言翻译（本机 zh-CN 上仍是 LISTENING）
    if (!fields[3].toUpperCase().startsWith('LISTEN')) continue;
    final pid = int.tryParse(fields.last);
    if (pid == null || pid <= 0) continue;
    found.add((address: address, pid: pid));
  }
  return found;
}

/// 本机上监听 [port] 的那个 pid；找不到返回 0。
///
/// **优先 `127.0.0.1:<port>`**：界面连的就是那一个（`baseUrl` 是回环地址），
/// 服务端也可能只绑 `0.0.0.0` / `::`，那时才退到别的本地地址。
Future<int> findListenerPid(
  int port, {
  ProcessRunner run = runProcess,
}) async {
  final result = await run('netstat', <String>['-ano', '-p', 'tcp']);
  final listeners = listenersOnPort(result.stdout.toString(), port);
  if (listeners.isEmpty) return 0;
  for (final line in listeners) {
    if (line.address == '127.0.0.1:$port') return line.pid;
  }
  return listeners.first.pid;
}

/// [`stopBackendOnPort`] 的结局。`detail` 是**给人看的一句话**（成功/失败都用它）。
class BackendStopResult {
  const BackendStopResult({required this.ok, required this.pid, required this.detail});

  /// 后端不再应答了（或者它本来就没在跑）
  final bool ok;

  /// 被停掉的后端 pid（0 = 没找到；`ok` 且 `pid == 0` 表示"本来就没在跑"）
  final int pid;

  /// 一句话现场（进日志 / 进确认失败后的 toast）
  final String detail;

  @override
  String toString() => '$detail（pid=$pid ok=$ok）';
}

/// 停掉监听 [port] 的后端**进程树**，并核实"端口真的不再应答"。
///
/// 判据一律是**可观察的事实**，不是命令的退出码：
///   · `taskkill` 返回 0 却端口还在应答 ⇒ 失败（如实说"还在应答"）；
///   · `taskkill` 返回非 0 但端口确实不应答了 ⇒ 成功（例如进程刚好自己退了）。
Future<BackendStopResult> stopBackendOnPort(
  int port, {
  String host = '127.0.0.1',
  ProcessRunner run = runProcess,
  PortProbe? probe,
  int? ownPid,
  Duration confirmWindow = const Duration(seconds: 8),
  Duration poll = const Duration(milliseconds: 250),
}) async {
  final alive = probe ?? tcpAlive;
  final self = ownPid ?? pid;

  // ① 端口上还有人吗？没有 ⇒ 本来就没在跑（这不是失败）
  if (!await alive(host, port)) {
    return BackendStopResult(ok: true, pid: 0, detail: '端口 $port 已经没人应答：后端本来就没在跑');
  }

  // ② 谁在监听（= 谁在服务这个界面的 API）
  final target = await findListenerPid(port, run: run);
  if (target <= 0) {
    return BackendStopResult(
      ok: false,
      pid: 0,
      detail: '端口 $port 有人在应答，但在 netstat 里找不到监听它的进程——没有动任何进程',
    );
  }
  if (target == self) {
    // 防御：绝不把这个界面进程当成后端（端口被界面自己占着的可能只有一种：配错了）
    return BackendStopResult(
      ok: false,
      pid: target,
      detail: '监听 $port 的是界面进程自己（pid $target），不碰它——没有结束任何进程',
    );
  }

  // ③ 杀进程树（后端 + 它拉起的协议端）。/T 是"连子进程一起"。
  ProcessResult killed;
  try {
    killed = await run('taskkill', <String>['/PID', '$target', '/T', '/F']);
  } catch (err) {
    return BackendStopResult(
      ok: false,
      pid: target,
      detail: '没能执行 taskkill（$err）——后端 pid $target 还在',
    );
  }
  final exit = killed.exitCode;
  final stderr = killed.stderr.toString().trim();

  // ④ 核实：端口不再应答才算停下来了（退出码不是判据，见函数头）
  final deadline = DateTime.now().add(confirmWindow);
  while (DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(poll);
    if (!await alive(host, port)) {
      return BackendStopResult(
        ok: true,
        pid: target,
        detail: '后端（pid $target）已停下：端口 $port 不再应答'
            '${exit == 0 ? '' : '（taskkill 返回 $exit）'}',
      );
    }
  }
  return BackendStopResult(
    ok: false,
    pid: target,
    detail: 'taskkill 返回 $exit${stderr.isEmpty ? '' : '（$stderr）'}，'
        '但端口 $port 仍在应答：后端 pid $target 还活着',
  );
}

/// 真机用的命令执行口（**单独抽出来是为了让用例不碰系统**）
Future<ProcessResult> runProcess(String exe, List<String> args) =>
    Process.run(exe, args, runInShell: false);

/// 真机用的探活口：能连上就是还在听（比 HTTP 更省，也不需要凭据）
Future<bool> tcpAlive(String host, int port) async {
  try {
    final socket = await Socket.connect(
      host,
      port,
      timeout: const Duration(milliseconds: 400),
    );
    socket.destroy();
    return true;
  } catch (_) {
    return false;
  }
}
