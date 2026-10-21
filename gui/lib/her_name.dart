// i18n: **本文件不迁**（2026-10-17 盘点）。里面有 8 处中文字面量，但那是
// **她的名字与她的自称**——属于"她是数据"而不是"界面是文案"，见 lib/i18n/app_strings.dart
// 顶部那三条"不许进这张表的东西"。换语言不会、也不该换她叫什么。
/// 她的名字：**读、写、以及"读不到时显示什么"——规则只有这一处**。
///
/// 为什么要有这么一个文件：在这之前，"她叫什么"从来没有被真正配置过，只以两种走样的形式存在——
///   · 界面里写死的 `'伊尔弥亚'`（`MaterialApp.title`、侧栏品牌区、托盘提示、"她问你"那张卡的标题）；
///   · 引导第 1 步只写 `channels.mentionKeywords`——那是**机器怎么判断在叫她**的词表，不是她的名字。
/// 于是换个人装这个框架，界面照样管他的 agent 叫伊尔弥亚。
///
/// **真相源**：`persona/IDENTITY.md` 里单独的一行 `名字：小七`。
/// 为什么不写进 config.json：人格资产是**她的**（人类可改、写前落版本快照、可回滚，走
/// `POST /api/commands/persona-edit`），config.json 是**机器的**（模型、通道、开关）。
/// 名字属于前者；`channels.mentionKeywords` 是从名字派生出来的**可选项**（唤醒判据），
/// 两者都写，但语义分开：一个是"她是谁"，一个是"群里喊什么算在叫她"。
///
/// 为什么规范形态是"单独一行"而不是"从正文里认一个"：正文是散文，认不准
/// （"我是一个住在服务器里的助手"里根本没有名字）。所以：
///   ① 有 `名字：` 那一行 → **一切以它为准**（写得不清楚就等于没写，不去正文里猜——
///      这样模板里的示例句永远不可能被当成她的名字）；
///   ② 没有这一行、且正文还是首启种子模板（`<!-- SEED`）→ 认不出（模板里的示例不是她）；
///   ③ 没有这一行、正文是人写过的 → 只认最直白的 `我叫…` / `我是…` 兜底。
/// 第 ③ 条存在的唯一理由：**兼容这一行出现之前就写好人格的老实例**（本机这份就是
/// `我是伊尔弥亚（Irmia）。`）——不这么做，用户这台机器上界面会突然不认得她的名字。
///
/// 读写都走 `GET /api/persona/file?path=IDENTITY.md` 与 `POST /api/commands/persona-edit`，
/// **没有新增服务端接口**：那条读端点本来就返回人格文件的权威字节，而写那一半（把名字行拼进
/// 正文再整份提交）只可能发生在界面侧——persona-edit 替换的是整份文件。再开一条
/// `/api/persona/name` 只会把同一套规则在另一种语言里再写一遍，那正是这次要修的毛病。
library;

/// 产品名（窗口标题与自绘标题栏那一串）。**它不是她的名字**，所以只在"名字读不到"时兜底：
/// 读不到就显示产品名（或按位置留空），绝不显示一个像名字的东西——那正是这次的 bug 本身。
const String kProductName = 'Irmia Agent Framework';

/// 侧栏品牌区的窄位版本：220px 侧栏放不下 21 个字符的产品全名（会折行/被省略号切）
const String kProductNameShort = 'Irmia Agent';

/// 人格资产文件名（名字写在它里面；与 persona_page.dart 的白名单同一串）
const String kIdentityFile = 'IDENTITY.md';

/// 名字那一行的标签。中文冒号也认（人打字两种都可能），写回去统一用全角。
const String kHerNameLabel = '名字';

/// 名字长度上限：与 `channels.mentionKeywords` 的单词上限同值（24，src/config/config.ts）。
/// 比它长的名字当不了唤醒词，也就没有意义在这里收下。
const int kHerNameMaxChars = 24;

/// 句子里指代她时用的词（名字读不到时："她想问你："）。
/// 为什么是"她"而不是产品名：这句话的主语是"谁在问"，产品名（一个框架）塞进去是错的。
const String kHerPronoun = '她';

/// 名字行：允许前置缩进与列表符号（人可能写成 `- 名字：小七`），标签后接全角或半角冒号。
///
/// `\uFEFF` 也放进前缀组：编辑器有时给文件加 BOM，而 BOM 会让 `^` 那一行匹配不上——
/// 于是我们会往文件里插**第二行**名字（第一行还留着），下次读到的又是旧值。
final RegExp _nameLine = RegExp(
  r'^([ \t\uFEFF]*(?:[-*+][ \t]*)?)' + kHerNameLabel + r'[ \t]*[:：][ \t]*(.*)$',
  multiLine: true,
);

/// 首启种子模板的标记（与 src/persona/loader.ts、src/web/server.ts 同一串字面量）
const String kSeedMarker = '<!-- SEED';

/// 散文兜底：只认「我叫…」「我是…」这两种最直白的写法
final RegExp _proseName = RegExp(
  r'我(?:叫|是)[ \t]*([^\s，。；、！？：:（）()\[\]【】《》「」…~—\-#*/\\|]{1,16})',
);

/// 名字不像名字的开头（量词/代词）："我是一个喜欢安静的人"里的"一个喜欢安静的人"不是名字
const List<String> _notNamePrefix = [
  '一个', '一名', '一位', '一只', '一种', '一台', '一群', '一份', '一件', '一本', '一场',
  '这台', '这个', '那个', '这里', '那里', '谁的',
  '个', '位', '名', '只', '种', '台', '你', '我', '他', '她', '它', '谁', '这', '那',
];

/// 括号开头的值 = 模板占位符或补充说明（种子模板里的 `名字：（改成她的名字）`），不是名字
const List<String> _bracketPrefix = ['（', '(', '[', '［', '{', '｛', '<', '《', '【', '<!--'];

/// 从 IDENTITY.md 的正文里认她的名字。返回 null = **认不出**（界面走保守回退）。
///
/// 判据见文件头那三条。任何一条不成立都返回 null，绝不"差不多猜一个"。
String? herNameFromIdentity(String? identity) {
  final text = identity ?? '';
  if (text.trim().isEmpty) return null;

  // ① 结构化那一行：有它就以它为准（哪怕它写得不清楚——那等于"没写"，不去正文里猜）
  final match = _nameLine.firstMatch(text);
  if (match != null) return _cleanNameValue(match.group(2) ?? '');

  // ② 正文还是首启种子模板：里面的示例句不是她（老实例升级上来时踩的正是这一条）
  if (text.contains(kSeedMarker)) return null;

  // ③ 人写过的正文：只认「我叫…」「我是…」，**第一个像名字的**算数
  //    （前一句可能是"我是一个助手"，那就往后找下一句——不因为第一句不像就整份放弃）
  for (final prose in _proseName.allMatches(text)) {
    final token = (prose.group(1) ?? '').trim();
    if (_looksLikeName(token)) return token;
  }
  return null;
}

/// 名字行在不在（引导第 1 步据此判断"要不要补这一行"）
bool hasHerNameLine(String? identity) => _nameLine.hasMatch(identity ?? '');

/// 把 `名字：X` 写进 IDENTITY.md 的正文并返回**新的整份正文**：
/// 已经有这一行就换掉它的值（连缩进/列表符号一起保留），没有就插在最前面。
///
/// 为什么是"整份正文"：写通道是 `POST /api/commands/persona-edit`，它替换的是整份文件
/// （服务端会先落一份旧版本快照，所以这一步可回滚）。调用方必须拿**服务端现正文**当底稿——
/// 拿一份空串当底稿就等于用一行字覆盖掉她整个人格。
String upsertHerNameLine(String identity, String name) {
  final clean = sanitizeHerNameInput(name);
  // 空名字 = 不改正文：把名字行删掉不是这一处的活（要删就去人格配置页删那一行）
  if (clean.isEmpty) return identity;

  final match = _nameLine.firstMatch(identity);
  if (match != null) {
    final prefix = match.group(1) ?? '';
    return identity.replaceRange(match.start, match.end, '$prefix$kHerNameLabel：$clean');
  }
  // 没有这一行：插在最前面（第一行就是她的名字，人打开文件一眼能看到）
  final head = '$kHerNameLabel：$clean\n';
  if (identity.startsWith('\uFEFF')) return '\uFEFF$head${identity.substring(1)}';
  return '$head$identity';
}

/// 输入框里的名字：去掉首尾空白、压掉换行与连续空白（名字是一行字，不该带进来一段文本）。
/// 上限之外的字符直接截断——调用方在写之前还会再报一次错（见 onboarding.dart 的第一步）。
String sanitizeHerNameInput(String raw) =>
    raw.replaceAll(RegExp(r'\s+'), ' ').trim();

/// 界面上显示她的名字（窗口标题、托盘提示这一族：位置宽，回退显示产品全名）
String herNameOrFallback(String? name) {
  final value = sanitizeHerNameInput(name ?? '');
  return value.isEmpty ? kProductName : value;
}

/// 侧栏品牌区那一个（位置窄：回退显示产品名的短写）
String herBrandName(String? name) {
  final value = sanitizeHerNameInput(name ?? '');
  return value.isEmpty ? kProductNameShort : value;
}

/// 句子里指代她（"小七想问你：" / "她想问你："）
String herNameInSentence(String? name) {
  final value = sanitizeHerNameInput(name ?? '');
  return value.isEmpty ? kHerPronoun : value;
}

/// 「她被怎么称呼」输入框的示例提示：有名字就照她的名字举例，没有就给格式示例。
/// 写死一个别人的名字（原来的 `'伊尔弥亚、弥亚小姐、Irmia'`）会误导——那正是这次的 bug。
String mentionKeywordsHint(String? name) {
  final value = sanitizeHerNameInput(name ?? '');
  return value.isEmpty ? '名字、昵称、缩写' : '$value、昵称';
}

/// 把一行名字清洗成"能用的名字"；不可用返回 null。
///
/// 去掉的部分：首尾空白、名字后面括号里的外文或注释（`名字：小七（Xiaoqi）` → `小七`）、
/// 行尾标点。拒绝的部分：括号/注释开头（占位符）、含控制字符、超长。
String? _cleanNameValue(String raw) {
  var value = sanitizeHerNameInput(raw);
  if (value.isEmpty) return null;
  for (final prefix in _bracketPrefix) {
    if (value.startsWith(prefix)) return null;
  }
  // 括号起的那一段是注解（外文名、身份说明），不是名字本身
  value = value.split(RegExp(r'[（(【\[《]')).first.trim();
  // 行尾标点是排版，不是名字的一部分
  value = value.replaceAll(RegExp(r'[。．.,，;；、:：!！?？~～]+$'), '');
  if (value.isEmpty) return null;
  if (RegExp(r'[\u0000-\u001F\u007F]').hasMatch(value)) return null;
  if (value.runes.length > kHerNameMaxChars) return null;
  return value;
}

/// "这一串像不像一个名字"：散文兜底的过滤器。
///
/// 宁可认不出来（界面回退成产品名），也不要把"一个喜欢安静的人"这样的句子片段当成她的名字。
bool _looksLikeName(String token) {
  if (token.isEmpty) return false;
  if (token.runes.length > kHerNameMaxChars) return false;
  // 名字里不会有"的"（"常驻的伙伴"这样的一律不是名字）
  if (token.contains('的')) return false;
  for (final prefix in _notNamePrefix) {
    if (token.startsWith(prefix)) return false;
  }
  // 至少要有"字"（汉字/字母/数字），纯标点不是名字
  if (RegExp(r'^[\s，。；、！？：:（）()\[\]【】《》「」…~—\-#*/\\|·.,;!?]+$').hasMatch(token)) return false;
  return true;
}
