/// 设计令牌**唯一真值**。
///
/// 规矩只有一条：**数值写在这里，别写在页面里**。
///
/// 这份表的来历（2026-10-17）：界面里散落着 431 处 `fontSize:`（11.5 出现 105 次、
/// 12.5 出现 86 次、12 出现 73 次…），间距是 4/5/6/7/9/10/11/14/18 这样的手写数，
/// 圆角在卡片 12 / 控件 8 / 弹窗 28（M3 默认）之间来回。结果是"同一件事在两页里
/// 长得不一样"，而每改一次配色都要全仓搜十六进制。
///
/// 与 `theme.dart` 的分工：
///   · 这里给**数值**（间距、字号、色值、圆角、时长）——纯常量，不依赖 BuildContext；
///   · `theme.dart` 把数值**装配**成 ThemeData；页面只消费 ThemeData 与这里的语义名。
///
/// 一条不许破的底线：**这套令牌只许把颜色往对比度更高的方向调**。
/// 现状里 `inkFaint` 在浅底上只有 3.01:1（WCAG AA 要求正文 4.5:1），
/// 本轮把它换成了 4.74:1 的 `#6B7280`；见 [Palette.light] 的注释。
library;

import 'package:flutter/material.dart';

// ═══════════════════════════════════════════════════════════════════════════
// 一、间距：4/8 栅格
// ═══════════════════════════════════════════════════════════════════════════

/// 间距标尺：**只有这六档**（4·8·12·16·24·32）。
///
/// 为什么只留六档：现有代码里有 5/6/7/9/10/11/14/18/22 这些"看着差不多"的数，
/// 单看每一处都合理，摆在一起就是"每张卡的内边距都不一样"。六档足够表达层次
/// （4 紧凑、8 相邻、12 组内、16 组间、24 分区、32 大区块），再多的数都是噪音。
///
/// 迁移口径（现有值 → 令牌）：
///   2/3/5   → [x1] (4)      · 图标与文字的缝、pill 的内边距
///   6/7/9/10 → [x2] (8)     · 最常被写歪的一档（现有 6 出现 45 次、10 出现 32 次）
///   11/13/14 → [x3] (12)    · 卡片内分节
///   18/20   → [x4] (16)     · 卡片内边距、两列间距
///   22/26   → [x6] (24)     · 内容区水平留白（页面那条 26 的线）
///   28/30/36 → [x8] (32)    · 大区块留白
abstract final class Space {
  /// 4 —— 紧贴（图标与文字之间）
  static const double x1 = 4;

  /// 8 —— 相邻元素
  static const double x2 = 8;

  /// 12 —— 组内分节
  static const double x3 = 12;

  /// 16 —— 组间 / 卡片内边距
  static const double x4 = 16;

  /// 24 —— 分区之间 / 内容区左右留白
  static const double x6 = 24;

  /// 32 —— 大区块
  static const double x8 = 32;

  /// 全部合法值（按升序）。新写间距时只能从这六个里挑。
  static const List<double> scale = <double>[x1, x2, x3, x4, x6, x8];

  /// 把任意数值吸附到最近的档位（迁移旧代码时用它，别手算）。
  ///
  /// 距离相等时向**小**取（宁可紧一点也不要松——信息密度优先，见
  /// `docs/gui-design.md` 的"他要读长文本"）。超出 32 的原样返回：那是布局尺寸，
  /// 不是间距。
  static double snap(double value) {
    if (value <= x1) return x1;
    if (value >= x8) return value > x8 ? value : x8;
    var best = scale.first;
    var bestGap = double.infinity;
    for (final candidate in scale) {
      final gap = (candidate - value).abs();
      if (gap < bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
    return best;
  }

  /// 常用组合（省得每页自己拼 EdgeInsets）
  static const EdgeInsets padCard = EdgeInsets.all(x4);
  static const EdgeInsets padBlock = EdgeInsets.fromLTRB(x6, x3, x6, x3);
  static const EdgeInsets gapTop1 = EdgeInsets.only(top: x1);
  static const EdgeInsets gapTop2 = EdgeInsets.only(top: x2);
  static const EdgeInsets gapTop3 = EdgeInsets.only(top: x3);
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、字号 / 行高：三档
// ═══════════════════════════════════════════════════════════════════════════

/// 一档字：字号 + **行高（逻辑像素）**。
///
/// 为什么把行高写死成像素而不是倍数：倍数是 `TextStyle.height` 要求的形态，而
/// "正文 22" 这种话只有换算过才落得到代码里；11.5 配 1.6（=18.4）、13 配 1.5（=19.5）
/// 这些手写组合就是这么漂开的。这里只管一对数，倍数由 [ratio] 现算。
class TypeToken {
  const TypeToken({required this.size, required this.height});

  /// 字号（逻辑像素）
  final double size;

  /// 行高（逻辑像素）。**不是倍数**。
  final double height;

  /// 换算成 `TextStyle.height` 要的倍数
  double get ratio => height / size;

  /// 落成 TextStyle。字体栈由 ThemeData 给，这里只给字号与行高。
  TextStyle style({Color? color, FontWeight? weight, List<FontFeature>? features}) => TextStyle(
        fontSize: size,
        height: ratio,
        color: color,
        fontWeight: weight,
        fontFeatures: features,
      );
}

/// 三档字：**标题 20/28 · 正文 14/22 · 说明 12/18**。
///
/// 与 Material 3 默认值的差：bodyMedium 14/20 → 14/22（多 2px 行距，长文本更好读）、
/// bodySmall 12/16 → 12/18、titleLarge 22/28 → 20/28（同为 28 行高，字小一点不挤）。
/// 这三档由 `theme.dart` 灌进 TextTheme，所以**不带 style 的 `Text()` 自动就是它们**。
///
/// 现存的 11.5 / 12.5 / 13 / 13.5 是历史密度档，本轮**不强行抬到 14**：
/// 他要读长文本与日志，正文从 12.5 涨到 14 会让每行少 4~6 个字、一屏少 3~4 行，
/// 那是**信息密度变差**。迁移口径是"新写的用三档，旧的在被改到的页面里就近落档"：
///   20/22/26 → [title]     · 页头、区块标题
///   13/13.5 → [body]       · 卡片里的正文段（只在被改到的页面）
///   12/12.5 → 保留现状     · 密集列表的正文（**不改**，改了就是密度变差）
///   11.5    → [caption]    · 旁注、时间戳、次要说明（18 行高比现状 1.5 倍更松）
abstract final class Type {
  /// 标题 20 / 28
  static const TypeToken title = TypeToken(size: 20, height: 28);

  /// 正文 14 / 22
  static const TypeToken body = TypeToken(size: 14, height: 22);

  /// 说明 12 / 18
  static const TypeToken caption = TypeToken(size: 12, height: 18);

  /// 三档的合法值（新写文字样式时只能从这三个里挑）
  static const List<TypeToken> scale = <TypeToken>[title, body, caption];

  /// 等宽档（日志、ID、时间戳、工具入参）：**字号跟 [caption] 走**，只换字形。
  ///
  /// 等宽字体在 Windows 上落到 Consolas（`monospace` 的别称），与
  /// `Microsoft YaHei UI` 的 x-height 不同，所以配 12 而不是 11.5——
  /// 混排时那一行不会比旁边的字"矮一截"。
  static const TextStyle monoBase = TextStyle(
    fontFamily: 'monospace',
    fontSize: 12,
    height: 1.5,
    fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
  );

  /// 等宽 + 指定颜色
  static TextStyle mono(Color color, {double size = 12, FontWeight? weight}) =>
      monoBase.copyWith(color: color, fontSize: size, fontWeight: weight);
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、语义色
// ═══════════════════════════════════════════════════════════════════════════

/// 一整套语义色（明暗各一份）。**页面不许再写 `Color(0x…)`**，要什么语义取什么名。
///
/// 现有十六进制 → 语义名的完整映射（本轮盘点，全仓 33 处 `Color(0x…)`）：
///
/// | 现值 | 出现处 | 语义名 | 本轮处置 |
/// |---|---|---|---|
/// | `0xFF2563EB` | theme.dart 种子 | [primary]（浅） | 收进 tokens，值不变 |
/// | `0xFF3B82F6` | theme.dart ×2 | [primary]（深） | 收进 tokens，值不变 |
/// | `0xFFFFFFFF` | theme.dart 底色 | [bg] / [card]（浅） | 收进 tokens，值不变 |
/// | `0xFFF5F7FA` | theme.dart | [sunken]（浅） | 收进 tokens，值不变 |
/// | `0xFFE8EEF9` | theme.dart | [raised]（浅） | 收进 tokens，值不变 |
/// | `0xFFE8ECF0` | theme.dart | [border]（浅） | 收进 tokens，值不变 |
/// | `0xFF14161A` | theme.dart ×3 | [bg] / [card]（深） | 收进 tokens，值不变 |
/// | `0xFF1A1D22` | theme.dart | [sunken]（深） | 收进 tokens，值不变 |
/// | `0xFF232A3A` | theme.dart | [raised]（深） | 收进 tokens，值不变 |
/// | `0xFF2C3138` | theme.dart | [border]（深） | 收进 tokens，值不变 |
/// | `0xFF1F2329` | theme.dart | [ink]（浅） | 收进 tokens，值不变 |
/// | `0xFFE9ECEF` | theme.dart | [ink]（深） | 收进 tokens，值不变 |
/// | `0xFF8F959E` | theme.dart | [inkFaint]（浅） | **改**：3.01:1 → 4.74:1（见下） |
/// | `0xFF98A0AA` | theme.dart | [inkFaint]（深） | 值不变（6.85:1 已达标） |
/// | `0xFF2F9E44` | ui_kit / 页面 | [ok] | 收进 tokens，值不变 |
/// | `0xFFF08C00` | 同上 | [warn] | 收进 tokens，值不变 |
/// | `0xFFE03131` | 同上 | [danger] | 收进 tokens，值不变 |
/// | `0xFFADB5BD` | 状态点"沉睡" | [sleep] | 收进 tokens，值不变 |
/// | `0x0D101828` | hairline 影 | [shadows] 那条 | 收进 tokens，值不变 |
/// | `0x1FFFFFFF` | title_bar 深模悬停 | [hoverVeil]（深） | 收进 tokens，值不变 |
/// | `0x0F000000` | title_bar 浅模悬停 | [hoverVeil]（浅） | 收进 tokens，值不变 |
/// | `0xFFC42B1C` | title_bar 关闭键 | [closeFill] | 收进 tokens，值不变 |
/// | `0xFF8E75D5`/`0xFFA18AE5` | schedule 工作类 | [accentA]（暗/亮） | 收进 tokens，值不变 |
/// | `0xFFD779A8`/`0xFFE8A4C7` | schedule 陪伴类 | [accentB]（暗/亮） | 收进 tokens，值不变 |
/// | `0xFF5D9B8B`/`0xFF82C4AE` | schedule 生活类 | [accentC]（暗/亮） | 收进 tokens，值不变 |
/// | `0xFFC28C4E`/`0xFFEDC58E` | schedule 周期类 | [accentD]（暗/亮） | 收进 tokens，值不变 |
///
/// **对比度不许降**：四色状态（ok/warn/danger/sleep）在明暗两模下同一个值——
/// 语义不随主题漂移，这是用户的口径（见 `theme.dart` 的 `IrmiaTheme.ok` 一段）。
class Palette {
  const Palette({
    required this.bg,
    required this.card,
    required this.sunken,
    required this.raised,
    required this.border,
    required this.primary,
    required this.ink,
    required this.inkSecondary,
    required this.inkFaint,
    required this.ok,
    required this.warn,
    required this.danger,
    required this.sleep,
    required this.hoverVeil,
    required this.accentA,
    required this.accentB,
    required this.accentC,
    required this.accentD,
  });

  /// 品牌种子色 `#2563EB`（与 Web 端同一个种子）。明暗两模的 `primary` 都从它派生。
  static const Color seed = Color(0xFF2563EB);

  /// 语义四色的**常量值**（明暗两模同值：语义不随主题漂移，见 `IrmiaTheme.ok` 的说明）
  static const Color okFixed = Color(0xFF2F9E44);
  static const Color warnFixed = Color(0xFFF08C00);
  static const Color dangerFixed = Color(0xFFE03131);
  static const Color sleepFixed = Color(0xFFADB5BD);

  /// 页面背景（= `ColorScheme.surface`，也是 scaffold 底色）
  final Color bg;

  /// 卡片底（现在与 [bg] 同值：卡片靠描边立起来，不靠色差）
  final Color card;

  /// 沉降面（表头、条纹、不可选区域）
  final Color sunken;

  /// 抬升面（选中项、头像底、分段控件选中）
  final Color raised;

  /// 边框 / 分隔线
  final Color border;

  /// 主色
  final Color primary;

  /// 文字·主（正文）
  final Color ink;

  /// 文字·次（副标题、旁注）
  final Color inkSecondary;

  /// 文字·弱（时间戳、单位、极次要）
  final Color inkFaint;

  /// 成功
  final Color ok;

  /// 警示
  final Color warn;

  /// 出错
  final Color danger;

  /// 休眠（状态点的第四档）
  final Color sleep;

  /// 标题栏悬停蒙层（深模白、浅模黑）
  final Color hoverVeil;

  /// 日程四类的强调色（暗/亮各一组，与 `schedule_page.dart` 的 `_Category` 接上）
  final Color accentA;
  final Color accentB;
  final Color accentC;
  final Color accentD;

  /// 浅色主题。
  ///
  /// 唯一一处**改值**：[inkFaint] 原为 `#8F959E`，在 `#FFFFFF` 上实测 **3.01:1**，
  /// 低于 WCAG AA 对正文的 4.5:1（说明文字按 4.5 也才刚够）。换成 `#6B7280` 后
  /// **4.74:1**，色相不变（还是那支冷灰），只是压暗一档——这是"不许为了好看降对比度"
  /// 的反向操作：变深、更好读，不是变浅。
  static const Palette light = Palette(
    bg: Color(0xFFFFFFFF),
    card: Color(0xFFFFFFFF),
    sunken: Color(0xFFF5F7FA),
    raised: Color(0xFFE8EEF9),
    border: Color(0xFFE8ECF0),
    primary: seed,
    ink: Color(0xFF1F2329),
    inkSecondary: Color(0xFF4B5563),
    inkFaint: Color(0xFF6B7280),
    ok: okFixed,
    warn: warnFixed,
    danger: dangerFixed,
    sleep: sleepFixed,
    hoverVeil: Color(0x0F000000),
    accentA: Color(0xFF8E75D5),
    accentB: Color(0xFFD779A8),
    accentC: Color(0xFF5D9B8B),
    accentD: Color(0xFFC28C4E),
  );

  /// 深色主题。深模的 [inkFaint]（`#98A0AA` 压在 `#14161A` 上 = 6.85:1）本来就达标，
  /// 一个值都不动。
  static const Palette dark = Palette(
    bg: Color(0xFF14161A),
    card: Color(0xFF14161A),
    sunken: Color(0xFF1A1D22),
    raised: Color(0xFF232A3A),
    border: Color(0xFF2C3138),
    primary: Color(0xFF3B82F6),
    ink: Color(0xFFE9ECEF),
    inkSecondary: Color(0xFFC3C9D1),
    inkFaint: Color(0xFF98A0AA),
    ok: okFixed,
    warn: warnFixed,
    danger: dangerFixed,
    sleep: sleepFixed,
    hoverVeil: Color(0x1FFFFFFF),
    accentA: Color(0xFFA18AE5),
    accentB: Color(0xFFE8A4C7),
    accentC: Color(0xFF82C4AE),
    accentD: Color(0xFFEDC58E),
  );

  static Palette ofBrightness(Brightness brightness) =>
      brightness == Brightness.dark ? dark : light;

  /// 从上下文取（`Theme.of(context).brightness` 是唯一判据）
  static Palette of(BuildContext context) => ofBrightness(Theme.of(context).brightness);
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、形状
// ═══════════════════════════════════════════════════════════════════════════

/// 圆角与阴影：**一套规则，三档**（2026-10-25 收口）。
///
/// 用户这轮的原话：「输入框和发送按钮做得更好看一点。圆角不要那么大了。」
/// 紧接着又补一句「发送按钮改圆角矩形。」于是散落的"胶囊按钮"到此为止：
///   · [radiusCard] **12** —— 卡片、弹窗、Popover、大块面板（弹窗原来吃 M3 默认的 28，
///     早就由 `theme.dart` 的 `dialogTheme` 收到这里）；
///   · [radiusControl] **10** —— **按钮 / 输入框 / 分段按钮 / 小容器**，页面里的控件只用这一档。
///     从前那些胶囊按钮（`StadiumBorder`、`BorderRadius.circular(999)` 用在按钮上的）
///     一律换成它：胶囊把一个 28 高的按钮的圆角画成 14，比卡片还圆，摆在一起就是"两种语言"；
///   · [radiusPill] **999** —— **只给正圆**：头像、状态点、圆点。999 大于任何半高，
///     所以它等价于"按尺寸自己算圆"，正是正圆要的；**它不许再出现在按钮上**。
///
/// [radiusControlLarge] 12 是 [radiusControl] 的**派生档**（+2），只给聊天页那条 52 高的
/// 输入框与它右边 40×40 的发送键：它们比普通按钮大一号，10 在 52 高上会显得"方"。
/// 它不是一个新语义，改 [radiusControl] 时它跟着走。
///
/// **分隔线只在"卡片内分节"用**（[dividerInset] 左边从那道内边距起画）：
/// 卡片与卡片之间靠 24 的间距分开，不靠线；页面区块之间也不画线。
abstract final class Shape {
  /// 卡片 / 弹窗 / 面板圆角（16）
  static const double radiusCard = 12;

  /// 控件圆角（按钮 / 输入框 / 分段 / 小容器）（10）
  static const double radiusControl = 10;

  /// 大控件圆角（= [radiusControl] + 2 = 12）：聊天页的输入框与发送键
  static const double radiusControlLarge = radiusControl + 2;

  /// 正圆的圆角（**只给头像、圆点**，别用在按钮上）
  static const double radiusPill = 999;

  /// 卡片圆角
  static BorderRadius get card => BorderRadius.circular(radiusCard);

  /// 控件圆角
  static BorderRadius get control => BorderRadius.circular(radiusControl);

  /// 正圆（半径大于半高 ⇒ 谁用谁是圆的）
  static BorderRadius get pill => BorderRadius.circular(radiusPill);

  /// 描边宽度（1 逻辑像素）
  static const double hairline = 1;

  /// 聚焦态描边宽度（1.4：比 1 明显、比 2 不抢）
  static const double focusWidth = 1.4;

  /// 唯一的阴影：发丝影。**没第二套**——elevation 一律 0，靠描边与底色分层。
  static const List<BoxShadow> shadows = <BoxShadow>[
    BoxShadow(color: Color(0x0D101828), blurRadius: 2, offset: Offset(0, 1)),
  ];

  /// 卡片内分隔线的左缩进（与卡片内边距同宽：线不从卡片最左边起画）
  static const EdgeInsets dividerInset = EdgeInsets.only(
    left: Space.x4,
    right: Space.x4,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、动效
// ═══════════════════════════════════════════════════════════════════════════

/// 动效：三个时长 + 两条曲线。
///
/// **该有的**：
///   · 状态切换（主题、页面切换、选中项）——[fast] 120ms / [standard] 曲线，
///     足够让人看见"变了"，短到不觉得慢；
///   · 列表插入（聊天新消息、日志新行）——[base] 180ms，只做淡入 + 位移 8，
///     **不做缩放**（缩放会让人以为布局在跳）；
///   · 常驻呼吸（状态点）——[drift] 2400ms，只动 opacity。
///
/// **该删的**（这些是本轮明确要收掉的，见 `gui/lib/pages/*` 的 `TODO(motion)`）：
///   · 任何 `Duration(milliseconds: <100)` 的版式动画——太短等于闪；
///   · 任何"高度从 0 到实际值"的展开动画（聊天页/日志页的折叠行）——
///     它会让整屏内容上下滑，读长文本时最刺眼，改成瞬时换高 + 淡入；
///   · 任何 Infinite 的旋转/脉冲（转圈、`repeat()` 的缩放）——只留呼吸的 opacity；
///   · 任何 `Curves.elastic*` / `bounce*`——桌面端弹跳与"稳"的语气相反。
abstract final class Motion {
  /// 120ms —— 状态切换（颜色、选中、显隐）
  static const Duration fast = Duration(milliseconds: 120);

  /// 180ms —— 页面切换、列表插入
  static const Duration base = Duration(milliseconds: 180);

  /// 240ms —— 卡片展开、较大面积的变化
  static const Duration slow = Duration(milliseconds: 240);

  /// 1500ms —— 一次性高亮（"刚更新的那一行"）
  static const Duration highlight = Duration(milliseconds: 1500);

  /// 2400ms —— 常驻呼吸（状态点）
  static const Duration drift = Duration(milliseconds: 2400);

  /// 标准曲线：离开快、进来缓（桌面端最不易察觉的那种）
  static const Curve standard = Curves.easeOutCubic;

  /// 强调曲线：两个状态之间的对调（明暗、语言）
  static const Curve emphasized = Curves.easeInOutCubic;
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、文字三档（挂到 ThemeData 上的那一份）
// ═══════════════════════════════════════════════════════════════════════════

/// 文字三档：主 / 次 / 弱。
///
/// 为什么要有它而不是直接用 `ColorScheme.onSurface` / `onSurfaceVariant`：
/// `ColorScheme` 只有两格（onSurface、onSurfaceVariant），而界面里实际有三档语气——
/// 正文（该读的）、次要（标题下的解释）、弱（时间戳、单位、极小字）。挤在两格里，
/// 第三档就会被就地写死成某个十六进制，于是"每个页面的灰都不一样"。
///
/// 取值就是 [Palette] 的那三个（浅色 4.74:1 / 深色 6.85:1 / 主色两模都 > 12:1）。
/// 页面里取：`Theme.of(context).extension<IrmiaInk>()!.faint`，或 [IrmiaInk.of]。
@immutable
class IrmiaInk extends ThemeExtension<IrmiaInk> {
  const IrmiaInk({required this.ink, required this.secondary, required this.faint});

  /// 文字·主
  final Color ink;

  /// 文字·次
  final Color secondary;

  /// 文字·弱
  final Color faint;

  /// 从一套语义色板造一份
  factory IrmiaInk.fromPalette(Palette palette) => IrmiaInk(
        ink: palette.ink,
        secondary: palette.inkSecondary,
        faint: palette.inkFaint,
      );

  /// 取当前主题的那一份；主题没注册时按 brightness 现算（不会崩）
  static IrmiaInk of(BuildContext context) =>
      Theme.of(context).extension<IrmiaInk>() ?? IrmiaInk.fromPalette(Palette.of(context));

  @override
  IrmiaInk copyWith({Color? ink, Color? secondary, Color? faint}) => IrmiaInk(
        ink: ink ?? this.ink,
        secondary: secondary ?? this.secondary,
        faint: faint ?? this.faint,
      );

  @override
  IrmiaInk lerp(ThemeExtension<IrmiaInk>? other, double t) {
    if (other is! IrmiaInk) return this;
    return IrmiaInk(
      ink: Color.lerp(ink, other.ink, t)!,
      secondary: Color.lerp(secondary, other.secondary, t)!,
      faint: Color.lerp(faint, other.faint, t)!,
    );
  }
}

