#!/usr/bin/env python3
"""AI Python 工具的隔离运行器（由 server/ai/python-runner.js 用子进程启动）。

输入（stdin，单个 JSON 对象）：
  { "code": "...", "timeout": 8, "max_result_chars": 20000 }

输出（真实 stdout 最后一行）：
  __STRU_RESULT__{ "ok": true/false, "result": ..., "ops": [...], "images": [...],
                   "logs": "...", "error": "..." }

脚本通过 emit(obj) 提交结果，可以多次调用；对象里可带：
  result  任意 JSON 值，回灌给模型（文字）
  ops     建模指令数组，由 Node 侧 dry-run 校验后合入本轮 ops
  images  [{ name, dataUrl }]，PNG/JPEG/WebP data URL，供 material.map 的 python:N 引用

安全边界（restricted 模式，非硬隔离）：
  - AST 静态检查：禁危险 import、禁 dunder 属性、禁 eval/exec/open/compile 等调用；
  - 运行期 import 钩子：只允许白名单根模块，库内部深层导入临时放行；
  - 危险 builtins 从脚本 globals 里剔除，socket / create_connection 替换为抛错；
  - RLIMIT_CPU / RLIMIT_AS / RLIMIT_FSIZE / RLIMIT_NOFILE 限额，cwd 为临时目录。
真正的硬隔离靠 Docker 容器模式（--network none、只读根、非 root、CPU/内存/进程数限额），
本脚本只是没有 Docker 时的降级路径，两者共用同一份脚本契约。
"""
import ast
import builtins
import io
import json
import os
import sys

RESULT_PREFIX = "__STRU_RESULT__"

ALLOWED_ROOTS = {
    "math", "cmath", "statistics", "random", "itertools", "functools",
    "collections", "numbers", "decimal", "fractions", "re", "string",
    "json", "base64", "io", "array", "struct", "copy", "typing",
    "dataclasses", "hashlib", "zlib", "enum", "operator", "heapq",
    "bisect", "unicodedata", "textwrap", "pprint", "uuid",
    "numpy", "scipy", "PIL", "OCP", "cadquery", "matplotlib",
}
BLOCKED_ROOTS = {
    "os", "sys", "subprocess", "socket", "ssl", "shutil", "pathlib",
    "importlib", "ctypes", "multiprocessing", "threading", "tempfile",
    "glob", "urllib", "http", "ftplib", "smtplib", "requests", "asyncio",
    "signal", "resource", "pickle", "shelve", "sqlite3", "builtins",
    "types", "inspect", "gc", "marshal", "code", "codeop", "pty", "fcntl",
    "posix", "nt", "winreg", "mmap", "webbrowser", "runpy", "site",
    "traceback", "linecache", "tokenize", "ast", "dis", "compileall",
}
BLOCKED_CALLS = {
    "eval", "exec", "compile", "open", "input", "breakpoint", "__import__",
    "exit", "quit", "help", "globals", "locals", "vars", "dir",
    "memoryview", "setattr", "delattr", "getattr", "classmethod",
}
BLOCKED_ATTRS = {
    "__class__", "__bases__", "__mro__", "__subclasses__", "__globals__",
    "__code__", "__closure__", "__dict__", "__builtins__", "__import__",
    "__getattribute__", "__setattr__", "__delattr__", "__reduce__",
    "__reduce_ex__", "__init_subclass__", "__loader__", "__spec__",
    "open", "system", "popen", "spawn", "connect",
}
DUNDER_PREFIX = "__"
# 这些只是模块里的元数据字符串，拿不到类 / 函数 / globals，不算逃逸通道
SAFE_DUNDERS = {"__version__", "__name__", "__doc__", "__all__"}


class Guard(ast.NodeVisitor):
    def __init__(self):
        self.errors = []

    def fail(self, text):
        if len(self.errors) < 6:
            self.errors.append(text)

    def visit_Import(self, node):
        for alias in node.names:
            root = alias.name.split(".")[0]
            if root not in ALLOWED_ROOTS:
                self.fail("不允许导入模块 %s（沙箱只允许数学 / 图像 / 几何库）" % alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        root = (node.module or "").split(".")[0]
        if root not in ALLOWED_ROOTS:
            self.fail("不允许从 %s 导入" % (node.module or ""))
        for alias in node.names:
            if alias.name.startswith(DUNDER_PREFIX):
                self.fail("不允许导入 %s" % alias.name)
        self.generic_visit(node)

    def visit_Call(self, node):
        name = None
        if isinstance(node.func, ast.Name):
            name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            name = node.func.attr
        if name in BLOCKED_CALLS:
            self.fail("不允许调用 %s()" % name)
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if node.attr in BLOCKED_ATTRS or (node.attr.startswith(DUNDER_PREFIX) and node.attr not in SAFE_DUNDERS):
            self.fail("不允许访问属性 %s" % node.attr)
        self.generic_visit(node)

    def visit_Name(self, node):
        if node.id.startswith(DUNDER_PREFIX) and node.id not in ("__name__",):
            self.fail("不允许访问 %s" % node.id)
        self.generic_visit(node)

    def visit_Global(self, node):
        self.fail("不允许 global 声明")
        self.generic_visit(node)

    def visit_Nonlocal(self, node):
        self.fail("不允许 nonlocal 声明")
        self.generic_visit(node)


def deny_network():
    import socket

    def blocked(*_args, **_kwargs):
        raise PermissionError("沙箱内禁止网络访问")

    socket.socket = blocked
    socket.create_connection = blocked
    socket.getaddrinfo = blocked


def apply_limits(timeout):
    # resource 是 POSIX 专有模块，Windows 上没有。拿不到就跳过进程内限额，
    # Node 侧仍有超时 + SIGKILL 兜底；容器模式下还有 cgroup 硬限额。
    try:
        import resource
    except ImportError:
        return
    # 比 Node 侧 timeout+1.5s 晚一点触发，让 Node 能用 SIGKILL 明确报「超时」；
    # 这里只是万一 Node 卡住时的第二道保险。
    cpu = max(3, int(timeout) + 4)
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
    except (ValueError, OSError):
        pass
    try:
        limit = 768 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    except (ValueError, OSError):
        pass


def main():
    real_stdout = sys.stdout
    real_stderr = sys.stderr
    payload = json.loads(sys.stdin.read())
    code = payload.get("code") or ""
    timeout = max(1, int(payload.get("timeout") or 8))
    max_result_chars = max(1000, int(payload.get("max_result_chars") or 20000))
    max_log_chars = 8000

    def finish(obj):
        real_stdout.write(RESULT_PREFIX + json.dumps(obj, ensure_ascii=False, default=str) + "\n")
        real_stdout.flush()

    apply_limits(timeout)
    deny_network()

    try:
        tree = ast.parse(code, filename="<ai-script>", mode="exec")
    except SyntaxError as error:
        finish({"ok": False, "error": "Python 语法错误：%s（第 %s 行）" % (error.msg, error.lineno)})
        return

    guard = Guard()
    guard.visit(tree)
    if guard.errors:
        finish({"ok": False, "error": "脚本被安全策略拒绝：" + "；".join(guard.errors)})
        return

    real_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        caller_file = str((globals or {}).get("__file__") or "")
        # 库内部的相对导入（name=''）/ 深层导入要放行：PIL、numpy、OCP 都会 import os、sys。
        # 用户脚本的 globals 里没有 __file__，所以这里区分得出「谁在 import」。
        from_library = "site-packages" in caller_file or "dist-packages" in caller_file
        if not from_library and not (level and not name):
            if root in BLOCKED_ROOTS or root not in ALLOWED_ROOTS:
                raise PermissionError("不允许导入模块 %s" % (name or "(相对导入)"))
        builtins.__import__ = real_import
        try:
            return real_import(name, globals, locals, fromlist, level)
        finally:
            builtins.__import__ = guarded_import

    safe_builtins = dict(vars(builtins))
    for name in ("open", "input", "breakpoint", "compile", "eval", "exec", "help", "exit", "quit"):
        safe_builtins.pop(name, None)
    safe_builtins["__import__"] = guarded_import
    builtins.__import__ = guarded_import

    emitted = []
    log_buffer = io.StringIO()

    def emit(value):
        if not isinstance(value, dict):
            raise TypeError("emit() 只接受一个对象，例如 emit({'result': ...})")
        emitted.append(value)

    scope = {"__builtins__": safe_builtins, "__name__": "__ai_sandbox__", "emit": emit}
    sys.stdout = log_buffer
    sys.stderr = log_buffer
    try:
        exec(compile(tree, "<ai-script>", "exec"), scope)
    except BaseException as error:  # 脚本里的任何异常都变成可回灌的文字，不打断整轮建模
        sys.stdout = real_stdout
        sys.stderr = real_stderr
        builtins.__import__ = real_import
        finish({
            "ok": False,
            "error": "%s: %s" % (type(error).__name__, str(error)[:400]),
            "logs": log_buffer.getvalue()[:max_log_chars],
        })
        return
    finally:
        sys.stdout = real_stdout
        sys.stderr = real_stderr
        builtins.__import__ = real_import

    result = None
    ops = []
    images = []
    for item in emitted:
        if "result" in item:
            result = item["result"]
        if isinstance(item.get("ops"), list):
            ops.extend(item["ops"])
        if isinstance(item.get("images"), list):
            images.extend(item["images"])

    encoded = json.dumps(result, ensure_ascii=False, default=str)
    if len(encoded) > max_result_chars:
        encoded = encoded[:max_result_chars] + "…（结果超过 %d 字符，请在脚本里精简 emit）" % max_result_chars
        result = {"_truncated": True, "text": encoded}
    else:
        result = json.loads(encoded)

    finish({
        "ok": True,
        "result": result,
        "ops": ops[:200],
        "images": images[:4],
        "logs": log_buffer.getvalue()[:max_log_chars],
    })


if __name__ == "__main__":
    main()
