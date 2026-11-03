"""
Python 插件的**安装期 AST 扫描**（宿主在安装/扫描包时调起它）

用法：``python -I ast_scan.py <入口文件> <已声明权限的逗号分隔列表>``

输出（stdout，一行 JSON）：``{"ok": true}`` 或
``{"ok": false, "violations": [{"line": 3, "module": "os", "permission": "files", "message": "..."}]}``

## 它是什么、不是什么（必须如实说）

这是**提高门槛**，不是沙箱：写得足够刁钻的代码（字符串拼出来的 `__import__`、C 扩展、
运行期下载的字节码）仍能绕过静态扫描。真正让 Python 插件安全的是"你确认过这个包"。
宿主侧另外两道门是运行期超时/kill 与 `irmia_plugin` shim 只暴露 ctx。

映射口径（与设计稿一致）：
  · 文件系统类模块 → 需要 ``files``
  · 网络类模块     → 需要 ``net``（P1a **不可授予** ⇒ 永远被拒）
  · 命令/原生调用类 → 需要 ``shell``（P1a **不可授予** ⇒ 永远被拒）
  · 动态导入 / exec / eval → 一律拒绝（不可审计）
"""

from __future__ import annotations

import ast
import json
import sys

FILE_MODULES = {
    "os", "os.path", "shutil", "pathlib", "glob", "tempfile", "io",
    "fcntl", "stat", "fileinput", "filecmp", "zipfile", "tarfile",
}
NET_MODULES = {
    "socket", "ssl", "http", "http.client", "urllib", "urllib.request", "urllib.error",
    "ftplib", "smtplib", "telnetlib", "xmlrpc", "requests", "aiohttp", "httpx",
    "websocket", "websockets", "asyncio", "selectors",
}
SHELL_MODULES = {
    "subprocess", "ctypes", "multiprocessing", "pty", "winreg", "msvcrt",
    "signal", "resource", "shlex", "platform",
}

PERMISSION_NAMES = {"files": "files", "net": "net", "shell": "shell"}


def _module_root(name: str) -> str:
    return name.split(".")[0]


def _classify(name: str) -> str | None:
    root = _module_root(name)
    for module in (root, name):
        if module in FILE_MODULES:
            return "files"
        if module in NET_MODULES:
            return "net"
        if module in SHELL_MODULES:
            return "shell"
    return None


def _resolve_imports(tree: ast.AST):
    """产出 (行号, 模块名) —— 覆盖 import / from-import / 相对导入。"""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name
        elif isinstance(node, ast.ImportFrom):
            if node.module is not None:
                yield node.lineno, node.module


def _dynamic_calls(tree: ast.AST):
    """动态导入 / 动态执行：静态审计看不见它们，直接拒。"""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        target = node.func
        name = None
        if isinstance(target, ast.Name):
            name = target.id
        elif isinstance(target, ast.Attribute):
            if isinstance(target.value, ast.Name):
                name = f"{target.value.id}.{target.attr}"
        if name in {"exec", "eval", "compile", "__import__", "importlib.import_module",
                    "importlib.__import__", "builtins.__import__", "builtins.eval", "builtins.exec"}:
            yield node.lineno, name


def scan(entry_path: str, permissions: set[str]) -> dict:
    try:
        with open(entry_path, "rb") as handle:
            source = handle.read()
        tree = ast.parse(source, filename=entry_path)
    except (OSError, SyntaxError) as error:
        return {"ok": False, "violations": [{
            "line": 0, "module": "", "permission": "",
            "message": f"入口文件读不出来或不是合法 Python：{error}",
        }]}

    violations = []
    for line, module in _resolve_imports(tree):
        permission = _classify(module)
        if permission is None:
            continue
        if permission == "files" and "files" in permissions:
            continue
        hint = {
            "files": "声明 files 权限（它会限制在插件数据目录，但 import os 后仍能碰整机——所以这条是门槛不是保证）",
            "net": "网络能力 P1a 不开放（net 留到 P1b，且只能经宿主代理）",
            "shell": "命令执行默认永不授予（要跑命令请走 MCP 工具）",
        }[permission]
        violations.append({
            "line": line, "module": module, "permission": permission,
            "message": f"import {module} 需要 {permission} 权限：{hint}",
        })
    for line, name in _dynamic_calls(tree):
        violations.append({
            "line": line, "module": name, "permission": "shell",
            "message": f"动态执行/动态导入 {name}() 不可静态审计，P1a 一律拒绝",
        })
    return {"ok": True} if not violations else {"ok": False, "violations": violations}


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: ast_scan.py <entry.py> [permission,permission...]\n")
        return 2
    permissions = set(filter(None, (sys.argv[2] if len(sys.argv) > 2 else "").split(",")))
    result = scan(sys.argv[1], permissions)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
