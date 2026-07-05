import { ChildProcessByStdio, spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "fs";
import { createWriteStream } from "fs";
import https from "https";
import { join } from "path";
import { IpcMainInvokeEvent } from "electron";
import type { Readable } from "stream";

// ─── Paths ──────────────────────────────────────────────────────────────────

const APPDATA = process.env.APPDATA ?? "C:\\Users\\Default\\AppData\\Roaming";
const HELPER_DIR = join(APPDATA, "VesktopAudioFix");
const EXE_PATH = join(HELPER_DIR, "capture.exe");
const NATIVE_LOG_FILE = join(HELPER_DIR, "native.log");
const INDEX_LOG_FILE = join(HELPER_DIR, "index.log");

const EXE_DOWNLOAD_URL = "https://github.com/gtair/vesktop_audio_fix/releases/latest/download/capture.exe";

// ─── Logging ────────────────────────────────────────────────────────────────

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
        /* file doesn't exist yet -- nothing to rotate */
    }
}

function writeLogLine(file: string, level: LogLevel, source: string, args: unknown[]) {
    const line = `[${new Date().toISOString()}] [${level}] [${source}] ${args.map(formatArg).join(" ")}\n`;
    try {
        mkdirSync(HELPER_DIR, { recursive: true });
        rotateIfNeeded(file);
        appendFileSync(file, line);
    } catch (e) {
        // Logging itself failing shouldn't take down capture -- just note it
        // on console since the file clearly isn't reachable right now.
        console.error("[AudioFix] Failed to write log file:", file, e);
    }
}

function nativeLog(level: LogLevel, ...args: unknown[]) {
    const consoleFn = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    consoleFn("[AudioFix]", ...args);
    writeLogLine(NATIVE_LOG_FILE, level, "native", args);
}

/**
 * Exposed to the renderer via VencordNative.pluginHelpers.WindowsAudioFix.
 * The renderer has no direct filesystem access, so it routes everything
 * through here to land in index.log instead.
 */
export function logFromRenderer(_event: IpcMainInvokeEvent, level: LogLevel, message: string) {
    const consoleFn = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    consoleFn("[AudioFix:renderer]", message);
    writeLogLine(INDEX_LOG_FILE, level, "renderer", [message]);
}

// ─── IPC channel names sent back to the renderer ───────────────────────────

const CHAN_DATA = "AUDIOFIX_PCM_DATA";
const CHAN_STATUS = "AUDIOFIX_CAPTURE_STATUS";

export type CaptureStopReason = "requested" | "crashed" | "exited" | "unsupported" | "error";

export type CaptureStatus =
    | { state: "started" }
    | { state: "stopped"; reason: CaptureStopReason; detail?: string };

// ─── State ──────────────────────────────────────────────────────────────────

let activeChild: ChildProcessByStdio<null, Readable, Readable> | null = null;
let activeSender: Electron.WebContents | null = null;
let readyConfirmed = false;
const pcmBuffer: Uint8Array[] = [];

function sendStatus(status: CaptureStatus) {
    if (activeSender && !activeSender.isDestroyed()) {
        activeSender.send(CHAN_STATUS, status);
    }
}

function killActive(reason: CaptureStopReason, detail?: string) {
    if (activeChild) {
        try {
            activeChild.kill();
        } catch {
            /* already dead */
        }
    }
    activeChild = null;
    readyConfirmed = false;
    nativeLog("INFO", "Capture stopped:", reason, detail ?? "");
    sendStatus({ state: "stopped", reason, detail });
    activeSender = null;
}

// ─── One-time exe provisioning ──────────────────────────────────────────────

function ensureHelperExists(): Promise<boolean> {
    return new Promise(resolve => {
        if (existsSync(EXE_PATH)) return resolve(true);

        try {
            mkdirSync(HELPER_DIR, { recursive: true });
        } catch (e) {
            nativeLog("ERROR", "Failed to create helper dir:", e);
            return resolve(false);
        }

        nativeLog("INFO", "capture.exe missing, downloading from", EXE_DOWNLOAD_URL);
        const file = createWriteStream(EXE_PATH);

        const request = https.get(EXE_DOWNLOAD_URL, response => {
            // Follow one redirect hop (GitHub release asset URLs 302 to S3).
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                https
                    .get(response.headers.location, redirected => {
                        redirected.pipe(file);
                        file.on("finish", () => file.close(() => resolve(true)));
                    })
                    .on("error", err => {
                        nativeLog("ERROR", "Download (redirect) failed:", err);
                        resolve(false);
                    });
                return;
            }

            if (response.statusCode !== 200) {
                nativeLog("ERROR", "Download failed with status", response.statusCode);
                resolve(false);
                return;
            }

            response.pipe(file);
            file.on("finish", () => file.close(() => resolve(true)));
        });

        request.on("error", err => {
            nativeLog("ERROR", "Download request failed:", err);
            resolve(false);
        });
    });
}

// ─── Public API (exposed via VencordNative.pluginHelpers.WindowsAudioFix) ──

export async function startCapture(
    event: IpcMainInvokeEvent,
    mode: "include" | "exclude",
    pid: number
): Promise<{ ok: true } | { ok: false; reason: CaptureStopReason; detail?: string }> {
    if (process.platform !== "win32") {
        nativeLog("WARN", "startCapture called on non-Windows platform, refusing");
        return { ok: false, reason: "unsupported", detail: "Not running on Windows" };
    }

    // Only one capture at a time.
    if (activeChild) killActive("requested");

    const ready = await ensureHelperExists();
    if (!ready) {
        const detail = "Could not download or locate capture.exe";
        nativeLog("ERROR", detail);
        sendStatus({ state: "stopped", reason: "error", detail });
        return { ok: false, reason: "error", detail };
    }

    activeSender = event.sender;
    readyConfirmed = false;

    const flag = mode === "include" ? "--include" : "--exclude";
    nativeLog("INFO", "Spawning capture.exe", flag, pid);
    const child = spawn(EXE_PATH, [flag, String(pid)], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });

    activeChild = child;

    child.stdout.on("data", (chunk: Buffer) => {
        if (!readyConfirmed) {
            readyConfirmed = true;
            nativeLog("INFO", "Capture started (first PCM data received)");
            sendStatus({ state: "started" });
        }
        pcmBuffer.push(new Uint8Array(chunk));
    });

    child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        nativeLog("WARN", "capture.exe:", text.trim());

        if (text.includes("READY") && !readyConfirmed) {
            readyConfirmed = true;
            sendStatus({ state: "started" });
        }

        if (text.startsWith("UNSUPPORTED")) {
            sendStatus({ state: "stopped", reason: "unsupported", detail: text.trim() });
        }
    });

    child.once("error", err => {
        nativeLog("ERROR", "Failed to spawn capture.exe:", err);
        if (activeChild === child) {
            activeChild = null;
            sendStatus({ state: "stopped", reason: "error", detail: String(err.message ?? err) });
        }
    });

    child.once("exit", (code, signal) => {
        if (activeChild !== child) return; // already superseded by a newer capture
        activeChild = null;

        // Exit code 0 with no signal generally means "we asked it to stop" or
        // stdout closed on its own -- anything else counts as a crash from
        // the renderer's point of view.
        if (signal || (code !== null && code !== 0)) {
            const detail = `exit code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}`;
            nativeLog("ERROR", "capture.exe crashed:", detail);
            sendStatus({ state: "stopped", reason: "crashed", detail });
        } else {
            nativeLog("INFO", "capture.exe exited cleanly");
            sendStatus({ state: "stopped", reason: "exited" });
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

/**
 * Resolves a window handle (as found in a "window:<hwnd>:..." desktopCapturer
 * sourceId) to its owning process id, via `capture.exe --resolve-hwnd`.
 * Returns null on any failure (invalid handle, exe missing, etc.) -- callers
 * should treat null as "fall back to plain Electron loopback".
 */
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

/**
 * Returns the main process PID so the renderer can use it for --exclude mode
 * during screen shares (to avoid capturing Vesktop's own audio output).
 */
export function getMainProcessPid(): number {
    return process.pid;
}