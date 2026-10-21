// **有窗口**的替身（测试用）：建一个真窗口、跑消息循环，用来验"出现且有窗口"那一态。
//
// 两条纪律（都是 `test\restart-gui-predicate.ps1` 文件头记下来的）：
//   · 必须编译成 **GUI 子系统**（`csc /target:winexe`）：控制台子系统的替身被 `Start-Process`
//     拉起时会**多出一个控制台窗口**，于是"出现但无窗口"会被误读成"出现且有窗口"。
//   · 长命替身要**活够**：观察窗 + 两次复看 + 收尾，所以默认活 120 秒（调用方会用
//     `Stop-Process` 收尾，收尾判据是 **exe 全路径在沙盒里**，绝不按名字杀）。
//
// 窗口位置放在屏幕外（-4000,-4000）：`IsWindowVisible` 只看 WS_VISIBLE 这一位，
// 所以窗口数/可见数照旧是真的，而**人看不到任何东西**（这是"一个真界面窗口都不弹"那条纪律）。
//
// 顺带干与 `cwd-nowin.cs` 同一件事：把自己的 cwd 写到 `<exe 全路径>.cwd.txt`。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class WindowedStand
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string exe = Assembly.GetExecutingAssembly().Location;
            File.WriteAllText(exe + ".cwd.txt",
                "cwd=" + Environment.CurrentDirectory + Environment.NewLine +
                "pid=" + Process.GetCurrentProcess().Id + Environment.NewLine);
        }
        catch { }
        var form = new Form();
        form.Text = "irmia-stand-in";
        form.StartPosition = FormStartPosition.Manual;
        form.Left = -4000;
        form.Top = -4000;
        form.Width = 320;
        form.Height = 200;
        form.ShowInTaskbar = false;
        form.Visible = true;
        Application.Run(form);
        return 0;
    }
}
