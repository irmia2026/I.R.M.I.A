"""
IRMIA 插件 ctx 的 Python 侧门面（只依赖标准库）

插件写法::

    import irmia_plugin

    def activate(ctx):
        ctx.tools.define(name="echo", description="原样返回", schema={"type": "object", "properties": {}},
                         handler=lambda args: str(args.get("text", "")))
        ctx.hooks.on("turn.start", lambda payload: None)

**边界是门槛，不是沙箱**（必须如实记住）：Python 没有权限模型；这个模块只是"不给你
os/socket 句柄"，挡不住 `import os`。真正的三道门在宿主那边：安装期 AST 扫描、
运行期超时/kill、以及"插件来自你确认过的包"这条人工审阅。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

_rpc: Optional[Callable[[str, Any], Any]] = None
_notify: Optional[Callable[[str, Any], None]] = None

TOOL_HANDLERS: Dict[str, Callable[[Any], Any]] = {}
HOOK_HANDLERS: Dict[str, Callable[[Any], Any]] = {}
# 所有点都按订阅回调：宿主的 subscriptionId -> handler（同点多次订阅互不覆盖）
SUBSCRIPTION_HANDLERS: Dict[str, Callable[[Any], Any]] = {}
# 兼容旧路径：message.received 的订阅 id -> handler
MESSAGE_HANDLERS: Dict[str, Callable[[Any], Any]] = {}
# 聊天指令：宿主的 commandId -> handler
COMMAND_HANDLERS: Dict[str, Callable[[Any], Any]] = {}
TIMER_HANDLERS: Dict[str, Callable[[], Any]] = {}


def _set_transport(rpc: Callable[[str, Any], Any], notify: Callable[[str, Any], None]) -> None:
    """由 runner.py 在加载插件之前注入。插件不该调用它。"""
    global _rpc, _notify
    _rpc = rpc
    _notify = notify


def _call(method: str, params: Any) -> Any:
    if _rpc is None:
        raise RuntimeError("irmia_plugin 还没有接到宿主（只能由 runner.py 注入）")
    return _rpc(method, params)


def _log(level: str, message: Any, extra: Any = None) -> None:
    if _notify is None:
        return
    payload = {"level": level, "message": str(message)}
    if extra is not None:
        payload["extra"] = extra
    _notify("log.write", payload)


class _Tools:
    def define(self, name: str = "", description: str = "", schema: Any = None,
               handler: Optional[Callable[[Any], Any]] = None, **kwargs: Any) -> None:
        """注册一件工具。`handler(args)` 返回字符串或 `{"content": ...}`。"""
        definition = kwargs.get("definition")
        missing = object()
        side_effect = kwargs.get("sideEffect", missing)
        if isinstance(name, dict) and definition is None:
            definition = name
            name = ""
        if definition is not None:
            name = str(definition.get("name", ""))
            description = str(definition.get("description", ""))
            schema = definition.get("schema", definition.get("parameters"))
            handler = definition.get("handler", handler)
            side_effect = definition.get("sideEffect", side_effect)
        if not name:
            raise ValueError("ctx.tools.define 缺少 name")
        if handler is None or not callable(handler):
            raise ValueError("ctx.tools.define 缺少 handler")
        _call("tool.register", {
            "name": name,
            "description": description,
            "parameters": schema if schema is not None else {"type": "object", "properties": {}},
            **({} if side_effect is missing else {"sideEffect": side_effect}),
        })
        TOOL_HANDLERS[name] = handler


class _Hooks:
    def on(self, point: str, handler: Callable[[Any], Any], filter: Any = None,
           options: Any = None, **kwargs: Any) -> None:
        """注册钩子。

        `message.received` 的第三参数仍是**过滤条件对象**，选项走
        `options={...}` / 关键字（mode / order / timeoutMs / errorPolicy / abort）。
        其余点的第三参数可直接给选项对象；所有值由宿主在订阅那一刻校验。
        """
        if not point or not callable(handler):
            raise ValueError("ctx.hooks.on(point, handler, filter?) 参数不对")
        is_message = point == "message.received"
        opts: Dict[str, Any] = {}
        payload: Dict[str, Any] = {"point": point}
        if is_message:
            if not isinstance(filter, dict):
                raise ValueError('ctx.hooks.on("message.received", handler, filter) 必须给过滤条件对象')
            payload["filter"] = filter
        elif filter is not None:
            # 非 message 点的第三参数按"选项对象"解释（旧版只允许 None，这里向后兼容更宽）
            if not isinstance(filter, dict):
                raise ValueError("非 message.received 点的第三参数必须是选项对象")
            opts.update(filter)
        if options is not None:
            if not isinstance(options, dict):
                raise ValueError("ctx.hooks.on 的 options 必须是对象")
            opts.update(options)
        if kwargs:
            opts.update(kwargs)
        payload.update(opts)
        result = _call("hook.subscribe", payload)
        subscription_id = result.get("subscriptionId") if isinstance(result, dict) else None
        if not isinstance(subscription_id, str):
            raise RuntimeError("宿主没有返回订阅 id")
        SUBSCRIPTION_HANDLERS[subscription_id] = handler
        if is_message:
            MESSAGE_HANDLERS[subscription_id] = handler
        else:
            HOOK_HANDLERS[point] = handler


class _Commands:
    def define(self, name: str = "", description: str = "", permission: str = "",
               handler: Optional[Callable[[Dict[str, Any]], Any]] = None,
               aliases: Any = None, args: Any = None, **kwargs: Any) -> Any:
        """注册一条聊天指令。handler 收 `{args, message}`，返回 `{text?, media?}` 或 None。"""
        definition = kwargs.get("definition")
        if isinstance(name, dict) and definition is None:
            definition = name
            name = ""
        if definition is not None:
            name = str(definition.get("name", ""))
            description = str(definition.get("description", ""))
            permission = str(definition.get("permission", ""))
            handler = definition.get("handler", handler)
            aliases = definition.get("aliases", aliases)
            args = definition.get("args", args)
        if handler is None or not callable(handler):
            raise ValueError("ctx.commands.define 缺少 handler")
        payload = {
            "name": name,
            "description": description,
            "permission": permission,
        }
        if aliases is not None:
            payload["aliases"] = aliases
        if args is not None:
            payload["args"] = args
        result = _call("command.define", payload)
        command_id = result.get("commandId") if isinstance(result, dict) else None
        if not isinstance(command_id, str):
            raise RuntimeError("宿主没有返回指令 id")
        COMMAND_HANDLERS[command_id] = handler
        return result


class _Net:
    """宿主网络代理。Python 侧没有任何 socket 句柄；所有请求都经 `net.fetch` 出去。"""

    def __init__(self) -> None:
        self.allow: Any = []

    def fetch(self, url: str, init: Any = None) -> Any:
        if not isinstance(url, str) or url == "":
            raise ValueError("ctx.net.fetch(url, init?) 需要一个 URL 字符串")
        if init is not None and not isinstance(init, dict):
            raise ValueError("ctx.net.fetch 的第二个参数必须是对象")
        payload: Dict[str, Any] = {"url": url}
        if init is not None:
            payload["init"] = init
        return _call("net.fetch", payload)


class _Chat:
    def send(self, message: Dict[str, Any]) -> Any:
        return _call("chat.send", message)

    def history(self, limit: int = 20) -> Any:
        return _call("chat.read", {"limit": limit})["messages"]


class _Model:
    def complete(self, request: Dict[str, Any]) -> Any:
        return _call("model.complete", request)


class _Timers:
    def every(self, interval: Any, handler: Callable[[], Any]) -> str:
        timer_id = f"every-{id(handler)}-{len(TIMER_HANDLERS)}"
        TIMER_HANDLERS[timer_id] = handler
        _call("timer.every", {"timerId": timer_id, "intervalMs": interval})
        return timer_id

    def cron(self, expression: str, handler: Callable[[], Any]) -> str:
        timer_id = f"cron-{id(handler)}-{len(TIMER_HANDLERS)}"
        TIMER_HANDLERS[timer_id] = handler
        _call("timer.cron", {"timerId": timer_id, "expression": expression})
        return timer_id

    def cancel(self, timer_id: str) -> Any:
        TIMER_HANDLERS.pop(timer_id, None)
        return _call("timer.cancel", {"timerId": timer_id})


class _StateScope:
    def __init__(self, scope: str) -> None:
        self._scope = scope

    def get(self, key: str) -> Any:
        return _call("state.get", {"scope": self._scope, "key": key})["value"]

    def set(self, key: str, value: Any) -> None:
        _call("state.set", {"scope": self._scope, "key": key, "value": value})


class _State:
    def __init__(self) -> None:
        self.session = _StateScope("session")
        self.plugin = _StateScope("plugin")


class _Files:
    def read(self, path: str, encoding: str = "utf8") -> str:
        return _call("files.read", {"path": path, "encoding": encoding})["data"]

    def write(self, path: str, data: str, encoding: str = "utf8") -> int:
        return _call("files.write", {"path": path, "data": data, "encoding": encoding})["bytes"]

    def list(self, directory: str = "") -> Any:
        return _call("files.list", {} if directory == "" else {"dir": directory})["entries"]


class _Log:
    def info(self, message: Any, extra: Any = None) -> None:
        _log("info", message, extra)

    def warn(self, message: Any, extra: Any = None) -> None:
        _log("warn", message, extra)

    def error(self, message: Any, extra: Any = None) -> None:
        _log("error", message, extra)


class PluginContext:
    """宿主能力的受控门面。插件**只能**通过它做事。"""

    def __init__(self, config: Optional[Dict[str, Any]] = None,
                 net_allow: Optional[Any] = None) -> None:
        self.config: Dict[str, Any] = dict(config or {})
        self.tools = _Tools()
        self.hooks = _Hooks()
        self.commands = _Commands()
        self.chat = _Chat()
        self.model = _Model()
        self.net = _Net()
        self.net.allow = list(net_allow or [])
        self.timers = _Timers()
        self.state = _State()
        self.files = _Files()
        self.log = _Log()


_current: Optional[PluginContext] = None


def get_ctx() -> PluginContext:
    """给少数"模块级也要用 ctx"的插件：`from irmia_plugin import get_ctx`。"""
    if _current is None:
        raise RuntimeError("ctx 还没有注入：请在 activate(ctx) 之后调用")
    return _current


def _install(ctx: PluginContext) -> None:
    global _current
    _current = ctx
