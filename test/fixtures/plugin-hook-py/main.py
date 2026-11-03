"""Python 命名钩子夹具：验证 hook.subscribe 选项、订阅 id 与 command.before 改 args。"""


def activate(ctx):
    def turn(payload):
        ctx.state.plugin.set("turn", payload)

    def before(payload):
        ctx.state.plugin.set("before", payload)
        args = dict(payload.get("args") or {})
        args["value"] = str(args.get("value", "")) + "-py"
        return {"args": args}

    def after(payload):
        ctx.state.plugin.set("after", payload)

    def probe(handler_args):
        args = handler_args.get("args") or {}
        ctx.state.plugin.set("handlerArgs", args)
        return {"text": "py:" + str(args.get("value", "")), "keepInContext": True}

    ctx.hooks.on("turn.start", turn)
    ctx.hooks.on("command.before", before, options={"timeoutMs": 1000, "abort": True})
    ctx.hooks.on("command.after", after)
    ctx.commands.define(
        name="pytest",
        description="Python 钩子测试指令",
        permission="all",
        args={
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
        handler=probe,
    )
    ctx.state.plugin.set("activatedAt", "yes")
