/// 「消息适配器」里那几把密钥的**键名**（`POST /api/commands/set-key` 的 `name` 字段）。
///
/// 为什么单独拎一份：QQ 官方 Bot 的两把凭据在两处填——首次引导第 3 步与设置页的
/// 「消息适配器」页——而落盘走的是**同一条** set-key 通道、写的是**同一对键名**。
/// 键名两处各写一遍，下一次改名就会变成"引导页写进去、设置页读不到"：两个页面都显示
/// 未配置，盘上其实有值。所以键名只有这一份，两处都引它。
///
/// 服务端侧的对应关系（`src/web/server.ts` 的 set-key 白名单）：
///   · `qqAppId`        → QQ 开放平台管理端的机器人 ID
///   · `qqClientSecret` → 换 access_token 的 AppSecret
library;

/// QQ 官方 Bot 的 AppID（写入本机 `data/.keys.json`，界面此后只显示掩码）
const kQqAppIdKey = 'qqAppId';

/// QQ 官方 Bot 的 AppSecret（同上：只写不读）
const kQqAppSecretKey = 'qqClientSecret';
