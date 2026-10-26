/// 全局的**「还在等」状态条**：任何一条请求等久了，页面顶上就多一行小字。
///
/// ## 它修的是哪一种故障（2026-10-23「GUI 用久了会卡死」）
///
/// 现场的判据是"进程健康、界面不动"：99 个线程全 Wait、CPU 空闲、`Responding=True`，
/// 而屏幕上那一页永远在转圈。形状是**某个 await 永远不返回**——而界面这一侧当时既没有
/// 时限、也没有一句话解释自己在等什么，于是"卡死"和"坏了"在人眼里是同一件事。
///
/// 这一层补的就是那两件事（对应修复清单的 A 尾与 B）：
///   ① **看得见**：等超过 [kSlowRequestHint] 就把"在等哪一条、已经等了多久"写在页面上
///      （数据直接来自 [IrmiaApi.pendingRequests]，不是猜的）；
///   ② **有出路**：同一行右边就是「重试」——它把当前页整页重挂一次（`AppState.reloadCurrentPage`），
///      页面于是重新 `initState`、重新取数。**不许无限转圈**这条要求的落点就在这里：
///      时限（[kApiRequestTimeout]）负责让请求自己结束，这一颗按钮负责让人不必等它。
///
/// ## 三条分寸
///
///   · **正常时不占位**：没有在飞的请求、或者都还很快 ⇒ 返回 `SizedBox.shrink()`，
///     一个像素都不占，版面与没有这一层时逐像素相同；
///   · **只画一行**：不管在飞几条，只说最久的那一条（人在意的是"卡在哪"，不是计数）；
///   · **秒表只在有请求在飞时才走**（随最后一个在飞请求结束就停）：挂机一整晚也不会
///     多出一拍常驻定时器。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'api.dart';
import 'app.dart';
import 'i18n/strings_scope.dart';

/// 状态条：`[转圈] 正在等 GET /api/stats/dashboard（已 8 秒）        [重试]`
///
/// 版式照壳里那条「有新版本」的提醒（`update_check.dart` 的 `UpdateBanner`）：占满内容区、
/// 不压侧栏、一条细边——它是**系统层的读数**，不是某一页的内容。
class WaitBanner extends StatefulWidget {
  const WaitBanner({super.key, required this.state});

  final AppState state;

  @override
  State<WaitBanner> createState() => _WaitBannerState();
}

class _WaitBannerState extends State<WaitBanner> {
  /// 秒表：只在"有请求在飞"期间存在
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    widget.state.api.inFlight.addListener(_onInFlightChanged);
    // 首帧不 setState（正在 initState 里）：只把秒表按当前状态摆好，随后那一次 build 就在路上
    _applyTicker();
  }

  @override
  void didUpdateWidget(WaitBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.state.api, widget.state.api)) {
      oldWidget.state.api.inFlight.removeListener(_onInFlightChanged);
      widget.state.api.inFlight.addListener(_onInFlightChanged);
      _applyTicker();
    }
  }

  @override
  void dispose() {
    widget.state.api.inFlight.removeListener(_onInFlightChanged);
    _ticker?.cancel();
    _ticker = null;
    super.dispose();
  }

  /// 在飞数变了：该起秒表就起、该停就停，再重画一次（多半是从"不显示"变成"显示"）。
  ///
  /// 用 `ValueNotifier<int> inFlight` 而不是 `AppState` 的通知：在飞数的变化远比
  /// "仪表盘状态变了"频繁（思考期每 250ms 一拍），走 AppState 会让整棵 MaterialApp 跟着重建。
  ///
  /// ⚠ **不许在 build 期间 setState**：`beginRequest` 是同步的，而页面第一次取数就发生在
  /// 它自己的 `initState` 里（那一刻父级正在 build）——直接 setState 会撞上
  /// "setState() or markNeedsBuild() called during build"（真机上表现为一屏红字/一帧异常）。
  /// 所以撞上 build 就排到本帧之后：这一层只是"把等待说出来"，晚一帧没有任何损失。
  void _onInFlightChanged() {
    if (!mounted) return;
    _applyTicker();
    final phase = SchedulerBinding.instance.schedulerPhase;
    if (phase == SchedulerPhase.persistentCallbacks || phase == SchedulerPhase.midFrameMicrotasks) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() {});
      });
      return;
    }
    setState(() {});
  }

  /// 秒表的开合只认一件事：**此刻有没有请求在飞**。
  void _applyTicker() {
    final busy = widget.state.api.inFlightCount > 0;
    if (busy) {
      _ticker ??= Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else {
      _ticker?.cancel();
      _ticker = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final oldest = widget.state.api.oldestPending;
    // 门槛之内一律不占位：几毫秒就回来的请求不该让版面跳一下
    if (oldest == null || oldest.elapsed < kSlowRequestHint) {
      return const SizedBox.shrink();
    }
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    return Container(
      // 定位件：用例按 key 找这一条（页面上同名的「重试」不止一处）
      key: const ValueKey('wait-banner'),
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(26, 8, 16, 8),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer.withValues(alpha: 0.35),
        border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.6, color: scheme.primary),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              // 事实由传输层给（哪一条、多久），语序归文案表
              s.requestWaiting(oldest.label, oldest.elapsed.inSeconds),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
            ),
          ),
          const SizedBox(width: 8),
          TextButton(
            // 不等了：把这一页整页重挂（重新 initState ⇒ 重新取数）。
            // 旧的请求回来时页面已经不在，各页 `mounted` 那道闸会把它丢掉。
            key: const ValueKey('wait-banner-retry'),
            onPressed: widget.state.reloadCurrentPage,
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 10),
            ),
            child: Text(s.retry, style: const TextStyle(fontSize: 11.5)),
          ),
        ],
      ),
    );
  }
}
