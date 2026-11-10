import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const MAX_PHYSICAL_ENTRIES = 10_000;
const MAX_PHYSICAL_FILES = 5_000;
const TIMEOUT_MS = 9_000;

/**
 * An optional, bounded, metadata-only NTFS size diagnostic. Do not use this
 * as write admission: it is a non-atomic snapshot, not a filesystem hard cap.
 * PowerShell compiles this fixed code in its own process (never user input).
 */
const PHYSICAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LnwjingProfileAllocation {
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low; public uint High; }
 [StructLayout(LayoutKind.Sequential)] struct HandleInfo {
  public uint Attributes; public FileTime Creation; public FileTime Access; public FileTime Write;
  public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
  public uint FileIndexHigh; public uint FileIndexLow;
 }
 [StructLayout(LayoutKind.Sequential)] struct StandardInfo {
  public long AllocationSize; public long EndOfFile; public uint NumberOfLinks;
  public byte DeletePending; public byte Directory;
 }
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,
   out StandardInfo info,uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string filename,uint access,uint share,IntPtr security,
   uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern bool GetFileInformationByHandle(SafeFileHandle handle,out HandleInfo info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern uint GetCompressedFileSizeW(string filename,out uint high);
 static bool IsLinked(FileAttributes value) { return (value & FileAttributes.ReparsePoint)!=0; }
 public static string Scan(string root,int entryLimit,int fileLimit,int durationMs) {
  if(!Path.IsPathRooted(root))return "INVALID";
  var directory = new DirectoryInfo(Path.GetFullPath(root));
  if(!directory.Exists || IsLinked(directory.Attributes))return "INVALID";
  var deadline = DateTime.UtcNow.AddMilliseconds(durationMs);
  var pending = new Stack<DirectoryInfo>(); pending.Push(directory);
  var counted = new Dictionary<string,int>();
  var links = new Dictionary<string,int>();
  var physical = new Dictionary<string,ulong>();
  ulong logicalBytes=0; int entries=0,files=0;
  try {
   while(pending.Count>0) {
    if(DateTime.UtcNow>deadline)return "INCOMPLETE";
    var current=pending.Pop();
    if(IsLinked(current.Attributes))return "INCOMPLETE";
    foreach(FileSystemInfo entry in current.EnumerateFileSystemInfos()) {
     if(++entries>entryLimit || DateTime.UtcNow>deadline)return "INCOMPLETE";
     if(IsLinked(entry.Attributes))return "INCOMPLETE";
     var folder=entry as DirectoryInfo;
     if(folder!=null) {pending.Push(folder);continue;}
     var file=entry as FileInfo;
     if(file==null)return "INCOMPLETE";
     if(++files>fileLimit)return "INCOMPLETE";
     using(var handle=CreateFileW(file.FullName,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
      if(handle.IsInvalid)return "INCOMPLETE";
      HandleInfo info;
      if(!GetFileInformationByHandle(handle,out info) || (info.Attributes&0x400)!=0)return "INCOMPLETE";
      StandardInfo standard;
      if(!GetFileInformationByHandleEx(handle,1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo)))
        || standard.AllocationSize<0 || standard.EndOfFile<0 || standard.Directory!=0
        || standard.NumberOfLinks!=info.Links)return "INCOMPLETE";
      var id=info.Volume.ToString("X8")+"-"+info.FileIndexHigh.ToString("X8")+"-"+info.FileIndexLow.ToString("X8");
      counted[id]=counted.ContainsKey(id)?counted[id]+1:1;
      links[id]=(int)info.Links;
      logicalBytes=checked(logicalBytes+(ulong)file.Length);
      if(!physical.ContainsKey(id)) {
       uint high;uint low=GetCompressedFileSizeW(file.FullName,out high);
       if(low==0xFFFFFFFF && Marshal.GetLastWin32Error()!=0)return "INCOMPLETE";
       var compressed=((ulong)high<<32)|low;
       // Keep a conservative bound when cluster allocation exceeds the
       // logical or compressed size (for example very small files).
       var fileAllocation=(ulong)standard.AllocationSize;
       physical[id]=fileAllocation>=compressed?fileAllocation:compressed;
       // Detect any path switch between opening the file and asking its storage size.
       HandleInfo after;
       if(!GetFileInformationByHandle(handle,out after)
         || after.Volume!=info.Volume || after.FileIndexHigh!=info.FileIndexHigh
         || after.FileIndexLow!=info.FileIndexLow)return "INCOMPLETE";
      }
     }
    }
   }
   ulong allocated=0;
   foreach(var pair in physical) {
    // If one hardlink lies outside the profile, attribution is ambiguous:
    // refuse to report a definitive application-owned physical total.
    if(links[pair.Key]!=counted[pair.Key])return "SHARED";
    allocated=checked(allocated+pair.Value);
   }
   return "OK|"+allocated.ToString()+"|"+logicalBytes.ToString()+"|"+files.ToString();
  } catch {return "INCOMPLETE";}
 }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null
[LnwjingProfileAllocation]::Scan(
  $env:LNWJING_PHYSICAL_SCAN_ROOT,
  [int]$env:LNWJING_PHYSICAL_SCAN_ENTRIES,
  [int]$env:LNWJING_PHYSICAL_SCAN_FILES,
  [int]$env:LNWJING_PHYSICAL_SCAN_DURATION)
`;

/**
 * Returns null whenever physical attribution cannot be completed *and*
 * independently reconciled against the normal logical inventory.
 */
export async function inspectWindowsProfileAllocatedBytes(
  profileRoot: string,
  expected: { readonly files: number; readonly logicalBytes: number; readonly visitedEntries: number },
): Promise<number | null> {
  if (process.platform !== 'win32' || !path.isAbsolute(profileRoot)
    || !Number.isSafeInteger(expected.files) || expected.files < 0
    || !Number.isSafeInteger(expected.logicalBytes) || expected.logicalBytes < 0
    || !Number.isSafeInteger(expected.visitedEntries) || expected.visitedEntries < expected.files
    || expected.files > MAX_PHYSICAL_FILES || expected.visitedEntries > MAX_PHYSICAL_ENTRIES) return null;

  // Never ask native code to scan an externally redirected profile path.
  try {
    const canonical = realpathSync.native(profileRoot);
    if (canonical.toLowerCase() !== path.resolve(profileRoot).toLowerCase()) return null;
  } catch { return null; }

  try {
    const encoded = Buffer.from(PHYSICAL_SCRIPT, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 4096, encoding: 'utf8',
        env: {
          ...process.env,
          LNWJING_PHYSICAL_SCAN_ROOT: path.resolve(profileRoot),
          LNWJING_PHYSICAL_SCAN_ENTRIES: String(MAX_PHYSICAL_ENTRIES),
          LNWJING_PHYSICAL_SCAN_FILES: String(MAX_PHYSICAL_FILES),
          LNWJING_PHYSICAL_SCAN_DURATION: String(TIMEOUT_MS - 1800),
        },
      });
    const output = stdout.trim();
    const match = /^OK\|(\d+)\|(\d+)\|(\d+)$/.exec(output);
    if (!match) return null;
    const allocated = Number(match[1]);
    const logical = Number(match[2]);
    const files = Number(match[3]);
    if (!Number.isSafeInteger(allocated) || !Number.isSafeInteger(logical)
      || !Number.isSafeInteger(files) || allocated < 0
      || logical !== expected.logicalBytes || files !== expected.files) return null;
    return allocated;
  } catch {
    // Diagnostic-only: disabled native bridge, inaccessible path, or timeout
    // must never break the regular logical inventory or application startup.
    return null;
  }
}
