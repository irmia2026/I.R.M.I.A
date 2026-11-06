---
name: presence
description: 在群里待着听话的用法：read_channel 看过哪个群，就自动进那个群待着；之后用 wait_messages 等新消息（最多 120 秒）。工具由 linre-presence__presence 提供。
version: 0.2.0
authors:
  - pashippercode
---

# 在群里待着（presence）

群里的闲话默认只进信箱，`read_channel` 才看得见。想**待着**听——
别人说话自然飘进来、不用每条都去翻——用这一套。

## 最关键的一条

**`read_channel` 看完哪个群，就自动进哪个群待着了。不用另外调 `enter_channel`。**

```
read_channel { sid: "onebot:group:953245617" }   # 看一眼 → 人已经在这屋了
wait_messages { seconds: 60 }                    # 直接等
```

## 三个工具

| 工具 | 干什么 |
|---|---|
| `read_channel` | 读消息。**读完就自动进这个群待着**（换群就是再读一次） |
| `wait_messages` | 等新消息，最多 120 秒；有就立刻回，没有就到点回 |
| `leave_channel` | 主动退屋 |
| `enter_channel` | 一般不用。只有在**没读**某个群、也想直接进屋时才调 |

## 什么时候值得待着

- 群里正聊到你在意的那个话题，你想跟着听，而不是被 @ 才醒
- 你刚说完一句，想看看接下来别人怎么接
- 想等某个人的下文

**不必**待着的时候：只想知道刚才说了什么 —— 读完就该干嘛干嘛，别挂着。

## 铁律

1. **一次只在一间屋。** 读了别的群就自动换过去，回执会写明「已离开 X」。
2. **120 秒是硬顶。** 传更大也按 120 算。
3. **10 分钟没有任何工具调用，自动退出。** 下一次调用会告诉你已经退出了；再 `read_channel` 一眼就回去。
4. 别用 `wait_messages` 空转刷屏：等到了就处理，没等到就去干别的。

## 典型用法

```
read_channel { sid: "onebot:group:953245617" }          # 进屋兼看最近的
wait_messages { seconds: 90 }                           # 等
speak { text: "……" }                                    # 想说就说
wait_messages { seconds: 120 }                          # 接着听
read_channel { sid: "onebot:group:777879783" }          # 换屋（自动离开上一个）
leave_channel {}                                        # 不听了
```

## 和 read_channel 的分工

- `read_channel`：一次性回读，翻历史、看未读、列会话簿。**读完就进屋了。**
- `wait_messages`：进屋之后才有的"等"。它不读历史，只等**从现在起**的新消息。

所以：**先 read 再 wait**，不要指望 wait 能把进屋前的补给你。
