# Keep the Python process and all descendants in one Job Object. The process is
# assigned while suspended, before plugin code can create an untracked child.
param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
try {
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  $exe = (Get-Command -Name ([string]$spec.file) -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class IrmiaPluginJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedPtr, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
    ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  // Windows argv escaping, without a shell. Quoting every argument also handles
  // empty arguments and executable/entry paths containing spaces or Unicode.
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(c); slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }

  public static int Run(string executable, string[] arguments) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ProcessInfo process = new ProcessInfo();
    bool assigned = false;
    try {
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
      var startup = new StartupInfo(); startup.Size = Marshal.SizeOf(startup);
      startup.Flags = 0x100; // STARTF_USESTDHANDLES
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      foreach (IntPtr handle in new[] { startup.Input, startup.Output, startup.Error }) {
        if (!SetHandleInformation(handle, 1, 1)) throw new Win32Exception();
      }
      var command = new StringBuilder(Quote(executable));
      foreach (string argument in arguments) command.Append(" ").Append(Quote(argument));
      // CREATE_SUSPENDED | CREATE_NO_WINDOW; inherits only this wrapper's
      // already-filtered environment and protocol pipes.
      if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004,
        IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception();
      if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception();
      assigned = true;
      if (ResumeThread(process.Thread) == 0xffffffff) throw new Win32Exception();
      if (WaitForSingleObject(process.Process, 0xffffffff) != 0) throw new Win32Exception();
      uint code;
      if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
      return unchecked((int)code);
    } finally {
      // Also handles a parent that exited normally before its descendants.
      if (assigned) TerminateJobObject(job, 0);
      else if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      CloseHandle(job);
    }
  }
}
'@
  exit [IrmiaPluginJob]::Run($exe, [string[]]$spec.args)
} catch {
  [Console]::Error.WriteLine('Python process job failed: ' + $_.Exception.Message)
  exit 1
}
