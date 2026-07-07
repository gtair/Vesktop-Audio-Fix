import { ChildProcessByStdio, spawn } from "child_process";
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { IpcMainInvokeEvent } from "electron";
import type { Readable } from "stream";

const APPDATA = process.env.APPDATA ?? "C:\\Users\\Default\\AppData\\Roaming";
const HELPER_DIR = join(APPDATA, "Vesktop Audio Fix");
const PS1_PATH = join(HELPER_DIR, "capture.ps1");
const NATIVE_LOG_FILE = join(HELPER_DIR, "native.log");
const INDEX_LOG_FILE = join(HELPER_DIR, "index.log");

// Embedded PowerShell/C# capture script — written to HELPER_DIR at runtime.
// Must run under Windows PowerShell 5.1 (powershell.exe), not pwsh.exe.
const PS1_SOURCE = `<#
.SYNOPSIS
    PowerShell/C# port of capture.exe (WASAPI process-loopback capture helper).

.DESCRIPTION
    Runs entirely as an inline-compiled C# type via Add-Type, so no separate
    .exe binary is shipped. Behaves like the original capture.exe:

      capture.ps1 --include <pid>        Capture ONLY audio from <pid> and its
                                           child process tree.
      capture.ps1 --exclude <pid>        Capture all system audio EXCEPT audio
                                           from <pid> and its child process tree.
      capture.ps1 --resolve-hwnd <hwnd>  Print the owning pid of a window handle
                                           to stdout, then exit. No audio work.

    Output: raw PCM (48kHz, 16-bit, stereo, interleaved) written to stdout.
    Diagnostics go to stderr (via [Console]::Error).

    Exit codes match the original:
      0  clean shutdown / handled --resolve-hwnd success
      1  bad arguments
      2  unsupported OS (process-loopback APIs unavailable)
      3  WASAPI activation/init failure
      4  --resolve-hwnd: invalid handle or no owning process

    IMPORTANT: Run with Windows PowerShell 5.1 (powershell.exe), not PowerShell 7
    (pwsh.exe). Classic .NET Framework COM interop (which Add-Type uses under
    5.1) automatically builds a COM-callable wrapper for a managed class that
    implements a [ComImport] interface. .NET (Core) 5+ does not do this
    automatically -- it requires an explicit ComWrappers setup instead.
#>

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CaptureArgs
)

$ErrorActionPreference = 'Stop'

$csharpSource = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO;

namespace ProcessLoopbackCapture
{
    // ---- Native structs -------------------------------------------------

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
    {
        public uint TargetProcessId;
        public int ProcessLoopbackMode; // PROCESS_LOOPBACK_MODE
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public int ActivationType; // AUDIOCLIENT_ACTIVATION_TYPE
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    // PROPVARIANT, VT_BLOB variant only. sizeof(PROPVARIANT) == 24 on x64:
    // 8-byte header (vt + 3x reserved WORD) then the union. For the BLOB
    // member {ULONG cbSize; BYTE *pBlobData;} the pointer needs 8-byte
    // alignment, so cbSize sits at offset 8 and pBlobData at offset 16.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public uint blobSize;
        [FieldOffset(16)] public IntPtr blobData;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct OSVERSIONINFOEX
    {
        public int dwOSVersionInfoSize;
        public int dwMajorVersion;
        public int dwMinorVersion;
        public int dwBuildNumber;
        public int dwPlatformId;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szCSDVersion;
        public ushort wServicePackMajor;
        public ushort wServicePackMinor;
        public ushort wSuiteMask;
        public byte wProductType;
        public byte wReserved;
    }

    // ---- COM interfaces ---------------------------------------------------
    // Vtable order must match the native definitions exactly -- interop
    // dispatches by slot index, not by name, so every method has to be
    // declared even if this program never calls it.

    [ComImport, Guid("72a22d78-cde4-431d-b8cc-843a71199b6d"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult,
            [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41d949ab-9862-444a-80f6-c261334da5eb"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig]
        int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    // Marker interface: tells COM the object has no apartment affinity and
    // can be called from any thread directly. ActivateAudioInterfaceAsync
    // requires the completion handler to implement this even in MTA.
    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject {}

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long hnsBufferDuration,
            long hnsPeriodicity, ref WAVEFORMATEX format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint numBufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, ref WAVEFORMATEX format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr dataBuffer, out uint numFramesToRead,
            out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    // Handler passed to ActivateAudioInterfaceAsync. Because COM is
    // initialized MTA on the calling thread (see Program.Run), the
    // ActivateCompleted callback -- which Windows invokes from an MTA
    // worker thread -- lands directly on this object with no cross-
    // apartment marshaling required, so no IAgileObject is needed.
    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Ready = new ManualResetEvent(false);
        public int Result = unchecked((int)0x80004005); // E_FAIL until set
        public IAudioClient AudioClient;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            int activateResult;
            object activatedInterface;
            int hr = activateOperation.GetActivateResult(out activateResult, out activatedInterface);

            if (hr >= 0 && activateResult >= 0 && activatedInterface != null)
            {
                AudioClient = (IAudioClient)activatedInterface;
                Result = 0;
            }
            else
            {
                Result = hr < 0 ? hr : activateResult;
            }

            Ready.Set();
            return 0; // S_OK
        }
    }

    public static class Program
    {
        // ---- P/Invoke ----

        [DllImport("ntdll.dll")]
        static extern int RtlGetVersion(ref OSVERSIONINFOEX versionInfo);

        [DllImport("Mmdevapi.dll", PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            ref Guid riid,
            ref PROPVARIANT activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("ole32.dll")]
        static extern int CoInitializeEx(IntPtr reserved, uint coInit);

        [DllImport("ole32.dll")]
        static extern void CoUninitialize();

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateEventW(IntPtr lpEventAttributes, bool bManualReset,
            bool bInitialState, string lpName);

        [DllImport("kernel32.dll")]
        static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr hObject);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        const uint COINIT_MULTITHREADED = 0x0;
        const uint WAIT_OBJECT_0 = 0;
        const uint INFINITE = 0xFFFFFFFF;
        const ushort VT_BLOB = 0x41;

        const int AUDCLNT_SHAREMODE_SHARED = 0;
        const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const int AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = unchecked((int)0x08000000);
        const int AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = unchecked((int)0x80000000);
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

        const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
        const int PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
        const int PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;

        const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = @"VAD\\Process_Loopback";
        static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");

        const long BUFFER_DURATION = 200000; // 20ms, 100ns units
        const int CHANNELS = 2;
        const int SAMPLE_RATE = 48000;
        const int BITS_PER_SAMPLE = 16;

        static bool SupportsProcessLoopback()
        {
            var version = new OSVERSIONINFOEX();
            version.dwOSVersionInfoSize = Marshal.SizeOf(version);
            if (RtlGetVersion(ref version) != 0) return false;
            return version.dwBuildNumber >= 20348;
        }

        static WAVEFORMATEX CreateWaveFormat()
        {
            var format = new WAVEFORMATEX();
            format.wFormatTag = 1; // WAVE_FORMAT_PCM
            format.nChannels = CHANNELS;
            format.nSamplesPerSec = SAMPLE_RATE;
            format.wBitsPerSample = BITS_PER_SAMPLE;
            format.nBlockAlign = (ushort)((format.nChannels * format.wBitsPerSample) / 8);
            format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
            return format;
        }

        static int TryHandleResolveHwnd(string[] args)
        {
            if (args.Length < 2 || args[0] != "--resolve-hwnd") return -1; // not this mode

            string raw = args[1];
            ulong value;

            // Match strtoull base-0 auto-detect: 0x/0X prefix = hex, else decimal
            if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                if (!ulong.TryParse(raw.Substring(2),
                        System.Globalization.NumberStyles.HexNumber, null, out value))
                {
                    Console.Error.WriteLine("Invalid window handle");
                    return 4;
                }
            }
            else
            {
                if (!ulong.TryParse(raw, out value))
                {
                    Console.Error.WriteLine("Invalid window handle");
                    return 4;
                }
            }

            if (value == 0)
            {
                Console.Error.WriteLine("Invalid window handle");
                return 4;
            }

            var hwnd = new IntPtr(unchecked((long)value));
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);

            if (pid == 0)
            {
                Console.Error.WriteLine("No owning process for handle");
                return 4;
            }

            Console.WriteLine(pid);
            return 0;
        }

        struct Args
        {
            public int Mode;
            public uint Pid;
        }

        static bool ParseArgs(string[] args, out Args result)
        {
            result = new Args();
            if (args.Length < 2) return false;

            if (args[0] == "--include")
                result.Mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
            else if (args[0] == "--exclude")
                result.Mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
            else
                return false;

            uint pid;
            if (!uint.TryParse(args[1], out pid) || pid == 0) return false;

            result.Pid = pid;
            return true;
        }

        static bool WriteAll(Stream stdout, byte[] data, int length)
        {
            try
            {
                stdout.Write(data, 0, length);
                stdout.Flush();
                return true;
            }
            catch (IOException)
            {
                return false; // stdout closed
            }
        }

        public static int Run(string[] args)
        {
            int resolveExit = TryHandleResolveHwnd(args);
            if (resolveExit >= 0) return resolveExit;

            Args parsed;
            if (!ParseArgs(args, out parsed))
            {
                Console.Error.WriteLine(
                    "Usage: capture.ps1 --include|--exclude <pid>  OR  capture.ps1 --resolve-hwnd <hwnd>");
                return 1;
            }

            if (!SupportsProcessLoopback())
            {
                Console.Error.WriteLine("UNSUPPORTED: OS build does not support process-loopback capture");
                return 2;
            }

            // PowerShell initializes COM as STA on its main thread. Calling
            // CoInitializeEx(COINIT_MULTITHREADED) on the same thread fails with
            // RPC_E_CHANGED_MODE (0x80010106). Run all COM work on a fresh thread
            // that we own so we can initialize it as MTA -- the same apartment
            // model the activation callback path expects.
            int exitCode = 3;
            var captureThread = new Thread(() => { exitCode = RunCom(parsed); });
            captureThread.IsBackground = true;
            captureThread.Start();
            captureThread.Join();
            return exitCode;
        }

        static int RunCom(Args parsed)
        {
            int coInitResult = CoInitializeEx(IntPtr.Zero, COINIT_MULTITHREADED);
            if (coInitResult < 0)
            {
                Console.Error.WriteLine("CoInitializeEx failed: 0x" + coInitResult.ToString("X"));
                return 3;
            }

            try
            {
                var activationParams = new AUDIOCLIENT_ACTIVATION_PARAMS();
                activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
                activationParams.ProcessLoopbackParams.TargetProcessId = parsed.Pid;
                activationParams.ProcessLoopbackParams.ProcessLoopbackMode = parsed.Mode;

                IntPtr paramsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(activationParams));
                try
                {
                    Marshal.StructureToPtr(activationParams, paramsPtr, false);

                    var propvariant = new PROPVARIANT();
                    propvariant.vt = VT_BLOB;
                    propvariant.blobSize = (uint)Marshal.SizeOf(activationParams);
                    propvariant.blobData = paramsPtr;

                    var handler = new ActivationHandler();
                    IActivateAudioInterfaceAsyncOperation operation;
                    var iidAudioClient = IID_IAudioClient;

                    try
                    {
                        ActivateAudioInterfaceAsync(
                            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                            ref iidAudioClient,
                            ref propvariant,
                            handler,
                            out operation);
                    }
                    catch (COMException ex)
                    {
                        Console.Error.WriteLine("ActivateAudioInterfaceAsync failed: 0x" +
                            ex.HResult.ToString("X"));
                        return 3;
                    }

                    handler.Ready.WaitOne();

                    if (handler.Result != 0 || handler.AudioClient == null)
                    {
                        Console.Error.WriteLine("Activation failed: 0x" + handler.Result.ToString("X"));
                        return 3;
                    }

                    var audioClient = handler.AudioClient;
                    var format = CreateWaveFormat();
                    int streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

                    int initHr = audioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags,
                        BUFFER_DURATION, BUFFER_DURATION, ref format, IntPtr.Zero);
                    if (initHr < 0)
                    {
                        Console.Error.WriteLine("IAudioClient::Initialize failed: 0x" + initHr.ToString("X"));
                        return 3;
                    }

                    IntPtr sampleReadyEvent = CreateEventW(IntPtr.Zero, false, false, null);
                    if (sampleReadyEvent == IntPtr.Zero)
                    {
                        Console.Error.WriteLine("CreateEvent for capture failed");
                        return 3;
                    }

                    try
                    {
                        if (audioClient.SetEventHandle(sampleReadyEvent) < 0)
                        {
                            Console.Error.WriteLine("SetEventHandle failed");
                            return 3;
                        }

                        var iidCaptureClient = typeof(IAudioCaptureClient).GUID;
                        object captureClientObj;
                        if (audioClient.GetService(ref iidCaptureClient, out captureClientObj) < 0)
                        {
                            Console.Error.WriteLine("GetService(IAudioCaptureClient) failed");
                            return 3;
                        }
                        var captureClient = (IAudioCaptureClient)captureClientObj;

                        if (audioClient.Start() < 0)
                        {
                            Console.Error.WriteLine("IAudioClient::Start failed");
                            return 3;
                        }

                        Console.Error.WriteLine("READY"); // caller can use this to confirm capture started

                        using (var stdout = Console.OpenStandardOutput())
                        {
                            byte[] silence = new byte[8192];

                            while (true)
                            {
                                if (WaitForSingleObject(sampleReadyEvent, INFINITE) != WAIT_OBJECT_0) break;

                                uint packetLength;
                                if (captureClient.GetNextPacketSize(out packetLength) < 0) break;

                                bool shouldExit = false;

                                while (packetLength > 0)
                                {
                                    IntPtr data;
                                    uint framesAvailable;
                                    uint flags;
                                    ulong devicePosition, qpcPosition;

                                    int bufferHr = captureClient.GetBuffer(out data, out framesAvailable,
                                        out flags, out devicePosition, out qpcPosition);
                                    if (bufferHr < 0)
                                    {
                                        packetLength = 0;
                                        break;
                                    }

                                    int bytesToWrite = (int)framesAvailable * format.nBlockAlign;
                                    bool wrote;

                                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                                    {
                                        if (silence.Length < bytesToWrite) silence = new byte[bytesToWrite];
                                        wrote = WriteAll(stdout, silence, bytesToWrite);
                                    }
                                    else
                                    {
                                        byte[] managedBuffer = new byte[bytesToWrite];
                                        Marshal.Copy(data, managedBuffer, 0, bytesToWrite);
                                        wrote = WriteAll(stdout, managedBuffer, bytesToWrite);
                                    }

                                    captureClient.ReleaseBuffer(framesAvailable);

                                    if (!wrote)
                                    {
                                        // stdout closed (parent stopped reading) -- shut down quietly.
                                        audioClient.Stop();
                                        shouldExit = true;
                                        break;
                                    }

                                    if (captureClient.GetNextPacketSize(out packetLength) < 0)
                                    {
                                        packetLength = 0;
                                        break;
                                    }
                                }

                                if (shouldExit) return 0;
                            }
                        }

                        audioClient.Stop();
                        return 0;
                    }
                    finally
                    {
                        CloseHandle(sampleReadyEvent);
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(paramsPtr);
                }
            }
            finally
            {
                CoUninitialize();
            }
        }
    }
}
'@

Add-Type -TypeDefinition $csharpSource -Language CSharp

exit [ProcessLoopbackCapture.Program]::Run($CaptureArgs)
`;

type LogLevel = "INFO" | "WARN" | "ERROR";

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB per file before rotating

function formatArg(a: unknown): string {
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
    if (typeof a === "object" && a !== null) {
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }
    return String(a);
}

function rotateIfNeeded(file: string) {
    try {
        if (statSync(file).size > MAX_LOG_BYTES) {
            renameSync(file, `${file}.old`);
        }
    } catch {
        /* ignored */
    }
}

function writeLogLine(file: string, level: LogLevel, source: string, args: unknown[]) {
    const line = `[${new Date().toISOString()}] [${level}] [${source}] ${args.map(formatArg).join(" ")}\n`;
    try {
        mkdirSync(HELPER_DIR, { recursive: true });
        rotateIfNeeded(file);
        appendFileSync(file, line);
    } catch (e) {
        console.error("[AudioFix] Failed to write log file:", file, e);
    }
}

function nativeLog(level: LogLevel, ...args: unknown[]) {
    const consoleFn = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    consoleFn("[AudioFix]", ...args);
    writeLogLine(NATIVE_LOG_FILE, level, "native", args);
}



export type CaptureStopReason = "requested" | "crashed" | "exited" | "unsupported" | "error";

let activeChild: ChildProcessByStdio<null, Readable, Readable> | null = null;
let readyConfirmed = false;
let maxBufferSize = 16; // default, will be overridden on startCapture (screen shares need more buffering)
const pcmBuffer: Uint8Array[] = [];

function killActive(reason: CaptureStopReason, detail?: string) {
    if (activeChild) {
        try {
            activeChild.kill();
        } catch {
            /* ignored */
        }
    }
    activeChild = null;
    readyConfirmed = false;
    pcmBuffer.length = 0;
    nativeLog("INFO", "Capture stopped:", reason, detail ?? "");
}

// Writes the embedded PS1 script to HELPER_DIR. Called before every spawn so
// updates bundled in a new plugin version deploy automatically on next start.
function ensureHelperScript(): boolean {
    try {
        mkdirSync(HELPER_DIR, { recursive: true });
        writeFileSync(PS1_PATH, PS1_SOURCE, "utf8");
        return true;
    } catch (e) {
        nativeLog("ERROR", "Failed to write capture.ps1:", e);
        return false;
    }
}

export async function startCapture(
    event: IpcMainInvokeEvent,
    mode: "include" | "exclude",
    pid: number,
    bufferSize?: number
): Promise<{ ok: true } | { ok: false; reason: CaptureStopReason; detail?: string }> {
    nativeLog("INFO", "startCapture called: mode=" + mode + ", pid=" + pid + ", bufferSize=" + (bufferSize ?? "undefined") + ", platform=" + process.platform);
    
    if (bufferSize && bufferSize >= 2 && bufferSize <= 32) maxBufferSize = bufferSize;
    
    if (process.platform !== "win32") {
        nativeLog("WARN", "startCapture called on non-Windows platform, refusing");
        return { ok: false, reason: "unsupported", detail: "Not running on Windows" };
    }

    if (activeChild) killActive("requested");

    if (!ensureHelperScript()) {
        const detail = "Could not write capture.ps1";
        nativeLog("ERROR", detail);
        return { ok: false, reason: "error", detail };
    }

    readyConfirmed = false;
    const flag = mode === "include" ? "--include" : "--exclude";

    nativeLog("INFO", "Spawning capture.ps1", flag, pid);
    const child = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", PS1_PATH, flag, String(pid)], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });

    activeChild = child;

    child.stdout.on("data", (chunk: Buffer) => {
        if (activeChild !== child) return;
        if (!readyConfirmed) {
            readyConfirmed = true;
            nativeLog("INFO", "Capture started");
        }
        if (pcmBuffer.length < maxBufferSize) {
            pcmBuffer.push(new Uint8Array(chunk));
        } else {
            nativeLog("WARN", "PCM buffer full (" + pcmBuffer.length + "/" + maxBufferSize + "), dropping chunk");
        }
    });

    // Resolve this promise once the process signals READY on stderr, or reject
    // early on error/exit. startCapture blocks on this so the renderer only
    // receives { ok: true } after capture is actually flowing, preventing the
    // ~400ms silence gap (and resulting underrun pops) on stream restarts.
    let signalReady: ((ok: boolean) => void) | null = null;
    const readyPromise = new Promise<boolean>(resolve => {
        signalReady = resolve;
        setTimeout(() => { signalReady = null; resolve(false); }, 5000);
    });

    child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        nativeLog("WARN", "capture.ps1:", text.trim());
        if (signalReady && text.includes("READY")) {
            signalReady(true);
            signalReady = null;
        }
    });

    child.once("error", err => {
        nativeLog("ERROR", "Failed to spawn capture.ps1:", err);
        if (signalReady) { signalReady(false); signalReady = null; }
        if (activeChild === child) activeChild = null;
    });

    child.once("exit", (code, signal) => {
        if (signalReady) { signalReady(false); signalReady = null; }
        if (activeChild !== child) return;
        activeChild = null;
        if (signal || (code !== null && code !== 0)) {
            nativeLog("ERROR", "capture.ps1 exited unexpectedly (code", code, "signal", signal, ")");
        }
    });

    const ready = await readyPromise;
    if (!ready) {
        if (activeChild === child) killActive("error");
        return { ok: false, reason: "error", detail: "Capture process did not signal ready in time" };
    }

    return { ok: true };
}

export function stopCapture() {
    if (activeChild) {
        nativeLog("INFO", "stopCapture requested");
        killActive("requested");
    }
}

export function getPcmChunk(): Uint8Array | null {
    return pcmBuffer.shift() ?? null;
}

export async function resolveWindowPid(_event: IpcMainInvokeEvent, hwnd: string): Promise<number | null> {
    if (process.platform !== "win32") return null;

    if (!ensureHelperScript()) {
        nativeLog("ERROR", "resolveWindowPid: could not write capture.ps1");
        return null;
    }

    return new Promise(resolve => {
        const child = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", PS1_PATH, "--resolve-hwnd", hwnd], { windowsHide: true });
        let output = "";

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });

        child.on("error", err => {
            nativeLog("ERROR", "resolveWindowPid: spawn failed:", err);
            resolve(null);
        });

        child.on("exit", code => {
            if (code !== 0) {
                nativeLog("WARN", "resolveWindowPid: ps1 exited with code", code, "for hwnd", hwnd);
                return resolve(null);
            }
            const pid = parseInt(output.trim(), 10);
            if (!Number.isFinite(pid) || pid <= 0) {
                nativeLog("WARN", "resolveWindowPid: could not parse pid from output:", output.trim());
                return resolve(null);
            }
            nativeLog("INFO", "resolveWindowPid: hwnd", hwnd, "-> pid", pid);
            resolve(pid);
        });
    });
}

export function getMainProcessPid(): number {
    return process.pid;
}

export function logToFile(_event: IpcMainInvokeEvent, args: unknown[]): void {
    writeLogLine(INDEX_LOG_FILE, "INFO", "index", args);
}