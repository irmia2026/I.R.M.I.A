/// 「配置引导」这颗按钮 → 首次引导卡（`onboarding.dart`）的**手动打开**通道。
///
/// 为什么是全局 notifier 而不是给 `AppState` 加一格：引导卡是**顶层**的东西
/// （`OnboardingHost` 包住整个壳，`app.dart` 里那一层），而按钮在**页里**
/// （运行情况页）。走一个通道比让每一层都拿到宿主 State 干净，也让用例能直接触发：
/// `requestOnboarding()` → 卡片出现。
///
/// ⚠ 手动打开**不碰**首次判据（[kOnboardingDoneFlag] 不读也不写，见
/// `onboarding.dart` 的 `_OnboardingHostState._openManually`）：人来只是"再看看这张卡"，
/// 不该因此把"第一次启动该弹"这件事消费掉，也不该替他把"已经引导过"写死。
library;

import 'package:flutter/foundation.dart';

/// 手动打开请求的计数器（每 +1 = 一次请求）。
///
/// 用计数而不是 bool：bool 在"刚弹过又点一次"时不会变化，宿主就收不到第二次请求；
/// 计数天然是"每次都是一件新事"。宿主自己再挡一次连点（卡片已经开着就不再叠第二张）。
final ValueNotifier<int> onboardingOpenRequest = ValueNotifier<int>(0);

/// 请求打开引导卡（首页「配置引导」按钮调它）
void requestOnboarding() => onboardingOpenRequest.value = onboardingOpenRequest.value + 1;
