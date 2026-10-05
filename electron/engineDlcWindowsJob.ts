import fs from 'node:fs/promises'
import path from 'node:path'

/** Suspended creation closes the spawn/assignment race. No breakaway is permitted.
 * The job handle belongs to the launcher: normal exit, cancellation and launcher death
 * all close it and terminate remaining descendants, including detached workers.
 */
const LAUNCHER = String.raw`
param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class DlcJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
    public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr psa, IntPtr tsa, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  public static int Run(string command, string[] args, string directory) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ProcessInfo process = new ProcessInfo();
    try {
      Limits limits = new Limits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))));
      StringBuilder line = new StringBuilder(Quote(command));
      foreach (string arg in args) line.Append(" ").Append(Quote(arg));
      Startup startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup));
      startup.Flags = 0x100; startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      Check(CreateProcess(command, line, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref startup, out process));
      Check(AssignProcessToJobObject(job, process.Process));
      if (ResumeThread(process.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      Check(WaitForSingleObject(process.Process, 0xffffffff) == 0);
      uint code; Check(GetExitCodeProcess(process.Process, out code));
      return unchecked((int)code);
    } finally {
      CloseHandle(job);
      if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 1); CloseHandle(process.Process); }
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
    }
  }
}
'@
try {
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $code = [DlcJob]::Run([string]$config.command, [string[]]$config.argv, [string]$config.cwd)
  exit $code
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 125
}
`

/** 系统 PowerShell 的唯一允许形态（SystemRoot 固定布局）；spawn 边界以此做白名单。 */
export const SYSTEM_POWERSHELL = /^[A-Za-z]:[\\/]Windows[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i

export async function windowsJobCommand(workDir: string, command: string, argv: string[], cwd: string): Promise<{ command: string; argv: string[] }> {
  const launcher = path.join(workDir, 'job.ps1')
  const config = path.join(workDir, 'job.json')
  await fs.writeFile(launcher, LAUNCHER, 'utf8')
  await fs.writeFile(config, JSON.stringify({ command, argv, cwd }), 'utf8')
  return {
    command: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, config],
  }
}
