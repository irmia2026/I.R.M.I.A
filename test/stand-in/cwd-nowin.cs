// 无窗口替身 + **工作目录取证**（测试用）：忙等一段时间，绝不建窗口、绝不碰控制台。
//
// 与 `sleeper.cs` 的差别只有一处：它会把自己的 **当前工作目录** 与 pid 写到
// `<exe 全路径>.cwd.txt`。为什么要它：2026-10-10 给 `packaging\restart.ps1` 的界面支补
// `-WorkingDirectory <exe 所在目录>` 时，判据不能只是"留痕里写着这一条"（那是实现细节），
// 得**从被拉起的那个进程嘴里**读到"我站在哪儿"——Flutter 的产物要就地找 DLL 与 `data\`，
// 工作目录错了进程就起来即退，而"拉起"那一层照样报成功。
//
// 用 `Stopwatch` 忙等而不是 `Sleep`：`sleeper.cs` 一直是这么写的（不建窗口、不吃 stdin、
// 也不受消息循环影响），这里与它保持一致。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class CwdNoWin
{
    private static int Main(string[] args)
    {
        int ms = 60000;
        if (args.Length > 0)
        {
            int parsed;
            if (int.TryParse(args[0], out parsed) && parsed >= 0) { ms = parsed; }
        }
        try
        {
            string exe = Assembly.GetExecutingAssembly().Location;
            File.WriteAllText(exe + ".cwd.txt",
                "cwd=" + Environment.CurrentDirectory + Environment.NewLine +
                "pid=" + Process.GetCurrentProcess().Id + Environment.NewLine +
                "lifetime_ms=" + ms + Environment.NewLine);
        }
        catch { }
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms) { }
        return 0;
    }
}
