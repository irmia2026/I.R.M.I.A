// 无窗口替身（测试用）：只睡一段时间，绝不建窗口、绝不碰控制台。
//
// 为什么自己编译一个而不是拷系统 exe：
//   · 测试要用 **exe 全路径** 做判据（`Get-ProcsByExePath`），所以替身必须**真的是一个 exe**；
//     `.cmd` 垫片是被 `cmd.exe` 代跑的，进程的 ExecutablePath 是 cmd.exe——按路径永远匹配不到，
//     这类替身会**假装**成"没出现"（我第一次这么写就踩了，正好被这条判据抓住）。
//   · 用 `Stopwatch` 忙等而不是 `Sleep`：不建任何窗口、不吃 stdin、也不受消息循环影响。
using System;
using System.Diagnostics;

internal static class Sleeper
{
    private static int Main(string[] args)
    {
        int ms = 60000;
        if (args.Length > 0)
        {
            int parsed;
            if (int.TryParse(args[0], out parsed) && parsed >= 0) { ms = parsed; }
        }
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms) { }
        return 0;
    }
}
