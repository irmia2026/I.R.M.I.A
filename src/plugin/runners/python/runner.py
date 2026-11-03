"""
IRMIA 插件运行器（Python）

起法（宿主拼的命令行）：python -I -u <runner.py> <入口文件>

- `-I` 隔离：不读用户 site-packages / PYTHONPATH；`-u` 无缓冲：一帧一写立刻出去。
- **stdout 只走协议**：插件里的 `print()` 被改道到 stderr（宿主会带插件前缀记日志），
  因为往 stdout 写一行人话就会毁掉行协议。
- 宿主→插件的请求是**串行**的（运行层保证），所以插件在处理一次回调时再调 ctx（插件→宿主）
  不会读串帧；为稳妥起见，等响应时若收到新的宿主请求也会就地处理。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import traceback
from typing import Any, Dict, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import irmia_plugin  # noqa: E402  （先把自己的目录放进 sys.path，再导入 shim）


def _configure_stdio() -> None:
    # Windows 的管道默认走控制台代码页（936）：显式改成 UTF-8，否则中文一进协议就坏。
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
        except Exception:  # pragma: no cover - 老 Python / 非文本流
            pass


_configure_stdio()
_real_stdout = sys.stdout
# 插件的 print 全部走 stderr：它们进宿主日志，不污染协议
sys.stdout = sys.stderr

_next_id = 1
_pending: Dict[int, Any] = {}
_module = None
_ctx: Optional[irmia_plugin.PluginContext] = None


def _write(payload: Dict[str, Any]) -> None:
    _real_stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _real_stdout.flush()


def _notify(method: str, params: Any = None) -> None:
    frame = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        frame["params"] = params
    _write(frame)


def _read_line() -> Optional[str]:
    line = sys.stdin.readline()
    if line == "":
        return None
    return line.rstrip("\n").rstrip("\r")


def _dispatch(frame: Dict[str, Any]) -> Any:
    method = frame.get("method")
    params = frame.get("params") or {}
    if method == "plugin.activate":
        config = params.get("config") or {}
        net_allow = params.get("netAllow") or []
        global _ctx
        _ctx = irmia_plugin.PluginContext(config, net_allow)
        irmia_plugin._install(_ctx)
        activate = getattr(_module, "activate", None)
        if callable(activate):
            activate(_ctx)
        return {"ok": True}
    if method == "plugin.ping":
        return {"ok": True}
    if method == "plugin.deactivate":
        deactivate = getattr(_module, "deactivate", None)
        if callable(deactivate):
            deactivate(_ctx)
        return {"ok": True}
    if method == "tool.invoke":
        name = params.get("name")
        handler = irmia_plugin.TOOL_HANDLERS.get(name)
        if handler is None:
            raise RuntimeError(f"插件没有注册工具 {name}")
        result = handler(params.get("args") or {})
        return _normalize(result)
    if method == "hook.invoke":
        subscription_id = params.get("subscriptionId")
        if isinstance(subscription_id, str):
            handler = (irmia_plugin.SUBSCRIPTION_HANDLERS.get(subscription_id)
                       or irmia_plugin.MESSAGE_HANDLERS.get(subscription_id))
            if handler is None:
                return {}
            result = handler(params.get("payload") or {})
            return {} if result is None else result
        handler = irmia_plugin.HOOK_HANDLERS.get(params.get("point"))
        if handler is None:
            return {}
        result = handler(params.get("payload") or {})
        return {} if result is None else result
    if method == "command.invoke":
        handler = irmia_plugin.COMMAND_HANDLERS.get(params.get("commandId"))
        if handler is None:
            raise RuntimeError(f"插件没有注册指令 {params.get('commandId')}")
        result = handler({"args": params.get("args") or {}, "message": params.get("message") or {}})
        return _normalize_command(result)
    if method == "timer.fire":
        handler = irmia_plugin.TIMER_HANDLERS.get(params.get("timerId"))
        if handler is None:
            return {}
        handler()
        return {"ok": True}
    raise RuntimeError(f"插件运行器不认识方法 {method}")


def _normalize(value: Any) -> Dict[str, Any]:
    if isinstance(value, str):
        return {"content": value}
    if isinstance(value, dict) and isinstance(value.get("content"), str):
        out = {"content": value["content"]}
        if value.get("isError") is True:
            out["isError"] = True
        if isinstance(value.get("additionalContext"), list):
            out["additionalContext"] = value["additionalContext"]
        return out
    return {"content": json.dumps(value, ensure_ascii=False, default=str)}


def _normalize_command(value: Any) -> Dict[str, Any]:
    """聊天指令的返回值：None = 不回；字符串 = 文本；对象只留 text/media/keepInContext。"""
    if value is None:
        return {}
    if isinstance(value, str):
        return {"text": value}
    if not isinstance(value, dict):
        return {}
    out: Dict[str, Any] = {}
    if isinstance(value.get("text"), str):
        out["text"] = value["text"]
    if value.get("media") is not None:
        out["media"] = value["media"]
    if value.get("keepInContext") is True:
        out["keepInContext"] = True
    return out


def _serve(frame: Dict[str, Any]) -> None:
    frame_id = frame.get("id")
    try:
        result = _dispatch(frame)
        if frame_id is not None:
            _write({"jsonrpc": "2.0", "id": frame_id, "result": result})
    except Exception as error:  # noqa: BLE001 - 任何异常都要回帧，不能让插件把宿主挂住
        sys.stderr.write(traceback.format_exc())
        if frame_id is not None:
            code = getattr(error, "code", -32603)
            _write({"jsonrpc": "2.0", "id": frame_id,
                    "error": {"code": code if isinstance(code, int) else -32603, "message": str(error)}})


def _rpc(method: str, params: Any = None) -> Any:
    """插件 → 宿主：写一帧请求，然后同步读响应（宿主保证同一时刻只有一条在飞）。"""
    global _next_id
    request_id = _next_id
    _next_id += 1
    frame = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        frame["params"] = params
    _write(frame)
    while True:
        line = _read_line()
        if line is None:
            raise RuntimeError("宿主关闭了 stdin（插件进程应当退出）")
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write("[irmia-plugin] 宿主发来一帧坏 JSON（已忽略）\n")
            continue
        if not isinstance(message, dict):
            continue
        if "method" in message:
            # 等响应时收到的宿主请求：就地处理，再继续等
            _serve(message)
            continue
        if message.get("id") != request_id:
            continue
        if "error" in message:
            error = RuntimeError(str(message["error"].get("message", "宿主调用失败")))
            error.code = message["error"].get("code")  # type: ignore[attr-defined]
            raise error
        return message.get("result")


irmia_plugin._set_transport(_rpc, _notify)


def _load_entry(entry_path: str) -> Any:
    entry_dir = os.path.dirname(os.path.abspath(entry_path))
    if entry_dir not in sys.path:
        sys.path.insert(0, entry_dir)
    spec = importlib.util.spec_from_file_location("irmia_plugin_entry", entry_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载插件入口：{entry_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["irmia_plugin_entry"] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    global _module
    if len(sys.argv) < 2:
        sys.stderr.write("[irmia-plugin] 缺少入口文件参数\n")
        return 2
    try:
        _module = _load_entry(sys.argv[1])
    except Exception:
        sys.stderr.write(traceback.format_exc())
        return 1
    _notify("plugin.ready", {"protocol": 1})
    while True:
        line = _read_line()
        if line is None:
            return 0
        if line.strip() == "":
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write("[irmia-plugin] 宿主发来一帧坏 JSON（已忽略）\n")
            continue
        if not isinstance(message, dict) or "method" not in message:
            continue
        if message.get("id") is None:
            try:
                _dispatch(message)
            except Exception:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
            continue
        _serve(message)
        if message.get("method") == "plugin.deactivate":
            return 0


if __name__ == "__main__":
    sys.exit(main())
