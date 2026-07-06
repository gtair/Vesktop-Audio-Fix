import { ChildProcessByStdio, spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from "fs";
import { createWriteStream } from "fs";
import https from "https";
import { join } from "path";
import { IpcMainInvokeEvent } from "electron";
import type { Readable } from "stream";

const APPDATA = process.env.APPDATA ?? "C:\\Users\\Default\\AppData\\Roaming";
const HELPER_DIR = join(APPDATA, "Vesktop Audio Fix");
const EXE_PATH = join(HELPER_DIR, "capture.exe");
const NATIVE_LOG_FILE = join(HELPER_DIR, "native.log");
const INDEX_LOG_FILE = join(HELPER_DIR, "index.log");

const EXE_DOWNLOAD_URL = "https://github.com/gtair/Vesktop-Audio-Fix/releases/latest/download/capture.exe";

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
    nativeLog("INFO", "Capture stopped:", reason, detail ?? "");
}

function ensureHelperExists(): Promise<boolean> {
    return new Promise(resolve => {
        nativeLog("INFO", "ensureHelperExists called, EXE_PATH=" + EXE_PATH);
        if (existsSync(EXE_PATH)) {
            nativeLog("INFO", "capture.exe already exists");
            return resolve(true);
        }

        nativeLog("INFO", "capture.exe does not exist, will attempt download");
        try {
            mkdirSync(HELPER_DIR, { recursive: true });
        } catch (e) {
            nativeLog("ERROR", "Failed to create helper dir:", e);
            return resolve(false);
        }

        nativeLog("INFO", "capture.exe missing, downloading from", EXE_DOWNLOAD_URL);
        const file = createWriteStream(EXE_PATH);
        let resolved = false;
        let bytesWritten = 0;

        const doResolve = (success: boolean) => {
            if (!resolved) {
                resolved = true;
                if (!success) {
                    try {
                        if (existsSync(EXE_PATH)) {
                            const stat = statSync(EXE_PATH);
                            nativeLog("WARN", "Cleaning up partial download:", stat.size, "bytes");
                        }
                    } catch {
                        /* ignored */
                    }
                }
                resolve(success);
            }
        };

        file.on("error", err => {
            nativeLog("ERROR", "File write error:", err);
            doResolve(false);
        });

        const request = https.get(EXE_DOWNLOAD_URL, response => {
            nativeLog("INFO", "Download response status:", response.statusCode);

            // Follow one redirect hop (GitHub release asset URLs 302 to S3).
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                nativeLog("INFO", "Following redirect to:", response.headers.location);
                https
                    .get(response.headers.location, redirected => {
                        nativeLog("INFO", "Redirect response status:", redirected.statusCode);
                        redirected.on("error", err => {
                            nativeLog("ERROR", "Redirect response error:", err);
                            file.destroy();
                            doResolve(false);
                        });
                        redirected.on("data", chunk => {
                            bytesWritten += chunk.length;
                        });
                        redirected.pipe(file);
                    })
                    .on("error", err => {
                        nativeLog("ERROR", "Redirect request error:", err);
                        file.destroy();
                        doResolve(false);
                    });
                return;
            }

            if (response.statusCode !== 200) {
                nativeLog("ERROR", "Download failed with status", response.statusCode);
                file.destroy();
                doResolve(false);
                return;
            }

            response.on("error", err => {
                nativeLog("ERROR", "Response stream error:", err);
                file.destroy();
                doResolve(false);
            });
            response.on("data", chunk => {
                bytesWritten += chunk.length;
            });
            response.pipe(file);
        });

        request.on("error", err => {
            nativeLog("ERROR", "Download request failed:", err);
            file.destroy();
            doResolve(false);
        });

        const timeoutId = setTimeout(() => {
            if (!resolved) {
                nativeLog("ERROR", "Download timeout (30s), bytes written:", bytesWritten);
                file.destroy();
                request.destroy();
                doResolve(false);
            }
        }, 30000);

        file.on("finish", () => {
            clearTimeout(timeoutId);
            file.close(() => {
                if (existsSync(EXE_PATH)) {
                    nativeLog("INFO", "Downloaded capture.exe successfully");
                    doResolve(true);
                } else {
                    nativeLog("ERROR", "Download completed but file missing");
                    doResolve(false);
                }
            });
        });
    });
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

    nativeLog("INFO", "Calling ensureHelperExists...");
    const ready = await ensureHelperExists();
    nativeLog("INFO", "ensureHelperExists returned:", ready);
    
    if (!ready) {
        const detail = "Could not download or locate capture.exe";
        nativeLog("ERROR", detail);
        return { ok: false, reason: "error", detail };
    }

    readyConfirmed = false;
    const flag = mode === "include" ? "--include" : "--exclude";
    
    if (!existsSync(EXE_PATH)) {
        const detail = `capture.exe not found at: ${EXE_PATH}`;
        nativeLog("ERROR", detail);
        return { ok: false, reason: "error", detail };
    }

    try {
        const stats = statSync(EXE_PATH);
        if (!stats.isFile() || stats.size === 0) {
            const detail = `capture.exe is invalid (not a file or empty)`;
            nativeLog("ERROR", detail);
            return { ok: false, reason: "error", detail };
        }
    } catch (err) {
        nativeLog("ERROR", "Failed to stat capture.exe:", err);
        return { ok: false, reason: "error", detail: String(err) };
    }

    nativeLog("INFO", "Spawning capture.exe", flag, pid);
    const child = spawn(EXE_PATH, [flag, String(pid)], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });

    activeChild = child;

    child.stdout.on("data", (chunk: Buffer) => {
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

    child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        nativeLog("WARN", "capture.exe:", text.trim());
    });

    child.once("error", err => {
        nativeLog("ERROR", "Failed to spawn capture.exe:", err);
        if (activeChild === child) activeChild = null;
    });

    child.once("exit", (code, signal) => {
        if (activeChild !== child) return;
        activeChild = null;
        if (signal || (code !== null && code !== 0)) {
            nativeLog("ERROR", "capture.exe exited unexpectedly (code", code, "signal", signal, ")");
        }
    });

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

    const ready = await ensureHelperExists();
    if (!ready) {
        nativeLog("ERROR", "resolveWindowPid: capture.exe unavailable");
        return null;
    }

    return new Promise(resolve => {
        const child = spawn(EXE_PATH, ["--resolve-hwnd", hwnd], { windowsHide: true });
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
                nativeLog("WARN", "resolveWindowPid: exe exited with code", code, "for hwnd", hwnd);
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