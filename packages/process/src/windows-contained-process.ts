export const windowsContainedProcessSource = String.raw`using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class ContainedProcess : IDisposable {
 const uint CreateSuspended=4, CreateNoWindow=0x08000000, KillOnJobClose=0x2000, StartUseStdHandles=0x100;
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinimumWorkingSet,MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime,KernelTime,PeriodUserTime,PeriodKernelTime; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPointer,Input,Output,Error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref ExtendedLimits info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int infoClass,out Accounting info,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryJobProcessIdList(IntPtr job,int infoClass,IntPtr buffer,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 IntPtr job,process;
 bool disposed;
 public uint ProcessId { get; private set; }
 private ContainedProcess() {}
 public static ContainedProcess Start(string executable,string[] arguments,string cwd) { return Start(executable,arguments,cwd,false); }
 public static ContainedProcess Start(string executable,string[] arguments,string cwd,bool verbatim) {
  if(!Path.IsPathRooted(executable)||!Path.IsPathRooted(cwd))throw new IOException("CONTAINMENT_ABSOLUTE_PATH_REQUIRED");
  var instance=new ContainedProcess();
  ProcessInfo child=new ProcessInfo();
  IntPtr input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;
  try {
   instance.job=CreateJobObject(IntPtr.Zero,null);
   if(instance.job==IntPtr.Zero)throw new IOException("CONTAINMENT_JOB_UNAVAILABLE");
   var limits=new ExtendedLimits(); limits.Basic.Flags=KillOnJobClose;
   if(!SetInformationJobObject(instance.job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))throw new IOException("CONTAINMENT_LIMITS_UNAVAILABLE");
   var command=new StringBuilder(Quote(executable));
   foreach(var argument in arguments) {
    if(argument.IndexOf('\0')>=0)throw new IOException("CONTAINMENT_INVALID_ARGUMENT");
    command.Append(" ").Append(verbatim?argument:Quote(argument));
   }
   input=InheritStandardHandle(-10);output=InheritStandardHandle(-11);error=InheritStandardHandle(-12);
   var startup=new Startup{Size=(uint)Marshal.SizeOf(typeof(Startup)),Flags=StartUseStdHandles,Input=input,Output=output,Error=error};
   if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,CreateSuspended|CreateNoWindow,IntPtr.Zero,cwd,ref startup,out child))throw new IOException("CONTAINMENT_CREATE_FAILED");
   instance.process=child.Process; instance.ProcessId=child.ProcessId;
   if(!AssignProcessToJobObject(instance.job,child.Process))throw new IOException("CONTAINMENT_ASSIGN_FAILED");
   if(ResumeThread(child.Thread)==UInt32.MaxValue)throw new IOException("CONTAINMENT_RESUME_FAILED");
   CloseHandle(child.Thread); child.Thread=IntPtr.Zero;
   return instance;
  } catch {
   if(child.Process!=IntPtr.Zero){TerminateProcess(child.Process,1);WaitForSingleObject(child.Process,10000);}
   if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);
   instance.Dispose();throw;
  } finally {
   if(input!=IntPtr.Zero)CloseHandle(input);
   if(output!=IntPtr.Zero)CloseHandle(output);
   if(error!=IntPtr.Zero)CloseHandle(error);
  }
 }
 static IntPtr InheritStandardHandle(int kind) {
  var original=GetStdHandle(kind);
  if(original==IntPtr.Zero||original==new IntPtr(-1))return IntPtr.Zero;
  IntPtr inherited;
  if(!DuplicateHandle(new IntPtr(-1),original,new IntPtr(-1),out inherited,0,true,2))throw new IOException("CONTAINMENT_STDIO_UNAVAILABLE");
  return inherited;
 }
 public uint ActiveProcesses {
  get {
   if(disposed)throw new ObjectDisposedException("ContainedProcess");
   Accounting info;
   if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new IOException("CONTAINMENT_UNVERIFIED");
   return info.ActiveProcesses;
  }
 }
 // Root completion alone is not a verified tree completion: Windows can keep
 // its headless console host in the job after the console client exits.
 public bool RootExited {
  get {
   if(disposed)throw new ObjectDisposedException("ContainedProcess");
   uint state=WaitForSingleObject(process,0);
   if(state==0)return true;
   if(state==258)return false;
   throw new IOException("CONTAINMENT_ROOT_WAIT_UNAVAILABLE");
  }
 }
 private uint[] ActiveProcessIds() {
  if(disposed)throw new ObjectDisposedException("ContainedProcess");
  for(int capacity=8;capacity<=128;capacity*=2) {
   int bytes=checked(8+capacity*IntPtr.Size);
   IntPtr buffer=Marshal.AllocHGlobal(bytes);
   try {
    if(QueryJobProcessIdList(job,3,buffer,(uint)bytes,IntPtr.Zero)) {
     int assigned=Marshal.ReadInt32(buffer,0),count=Marshal.ReadInt32(buffer,4);
     if(assigned>capacity)continue;
     if(assigned<0||count<0||count>assigned||count>capacity)throw new IOException("CONTAINMENT_PID_LIST_INVALID");
     var ids=new uint[count];
     for(int i=0;i<count;i++) {
      long pid=Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64();
      if(pid<=0||pid>UInt32.MaxValue)throw new IOException("CONTAINMENT_PID_LIST_INVALID");
      ids[i]=(uint)pid;
     }
     return ids;
    }
    if(Marshal.GetLastWin32Error()!=234)throw new IOException("CONTAINMENT_PID_LIST_UNAVAILABLE");
   } finally { Marshal.FreeHGlobal(buffer); }
  }
  throw new IOException("CONTAINMENT_PID_LIST_TOO_LARGE");
 }
 // After the root is already gone, only an OS-owned System32 conhost.exe can
 // be reaped. Never terminate an arbitrary job descendant or an unverified PID.
 // The caller waits several seconds to permit normal console shutdown first.
 public bool TryDrainOrphanedConsoleHosts() {
  if(!RootExited)return false;
  uint[] ids;
  try { ids=ActiveProcessIds(); }
  catch { return false; }
  if(ids.Length==0||ids.Length>8||ActiveProcesses!=(uint)ids.Length)return false;
  var handles=new IntPtr[ids.Length];
  try {
   string expected=Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"conhost.exe"));
   for(int i=0;i<ids.Length;i++) {
    handles[i]=OpenProcess(0x1001,false,ids[i]); // QUERY_LIMITED_INFORMATION | TERMINATE
    if(handles[i]==IntPtr.Zero)return false;
    var pathBuffer=new StringBuilder(32768);
    uint size=(uint)pathBuffer.Capacity;
    if(!QueryFullProcessImageName(handles[i],0,pathBuffer,ref size)||
       !string.Equals(Path.GetFullPath(pathBuffer.ToString()),expected,StringComparison.OrdinalIgnoreCase))return false;
   }
   // A job PID list is a snapshot. Require the same members and a terminated
   // root immediately before touching each validated process object handle.
   var current=ActiveProcessIds();
   if(current.Length!=ids.Length||!RootExited)return false;
   Array.Sort(ids);Array.Sort(current);
   for(int i=0;i<ids.Length;i++)if(ids[i]!=current[i])return false;
   for(int i=0;i<handles.Length;i++)if(!TerminateProcess(handles[i],0))return false;
   return true;
  } catch { return false; }
  finally { foreach(var handle in handles)if(handle!=IntPtr.Zero)CloseHandle(handle); }
 }
 public int WaitForExit(int timeoutMilliseconds) {
  var end=DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
  while(ActiveProcesses!=0) {
   if(DateTime.UtcNow>=end)throw new TimeoutException("CONTAINMENT_TIMEOUT");
   Thread.Sleep(10);
  }
  uint code;
  if(!GetExitCodeProcess(process,out code)||code==259)throw new IOException("CONTAINMENT_EXIT_UNVERIFIED");
  return unchecked((int)code);
 }
 public void Cancel() {
  if(disposed)throw new ObjectDisposedException("ContainedProcess");
  if(!TerminateJobObject(job,1))throw new IOException("CONTAINMENT_CANCEL_UNVERIFIED");
  WaitForExit(10000);
 }
 public void Dispose() {
  if(disposed)return;
  if(job!=IntPtr.Zero)CloseHandle(job);
  if(process!=IntPtr.Zero)CloseHandle(process);
  disposed=true;
 }
 static string Quote(string value) {
  if(value.IndexOf('\0')>=0)throw new IOException("CONTAINMENT_INVALID_ARGUMENT");
  var result=new StringBuilder("\""); int slashes=0;
  foreach(char c in value) {
   if(c=='\\'){slashes++;continue;}
   if(c=='"'){result.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}
   result.Append('\\',slashes).Append(c);slashes=0;
  }
  return result.Append('\\',slashes*2).Append('"').ToString();
 }
}
`;
