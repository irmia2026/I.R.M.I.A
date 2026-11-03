"""P1a 的 Python e2e 夹具：只依赖标准库 + 宿主的 `irmia_plugin` shim。"""


def activate(ctx):
    def echo(args):
        return {"content": "py:" + str(args.get("text", ""))}

    ctx.tools.define(
        name="echo",
        description="原样回显 text（Python 入口 e2e）",
        schema={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        handler=echo,
    )
    ctx.state.plugin.set("activatedAt", "yes")
    ctx.log.info("demo-py activated")
