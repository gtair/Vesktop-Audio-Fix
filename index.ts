import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";

// ─── Config ─────────────────────────────────────────────────────────────────

// Must match the channel names used in native.ts.
const CHAN_STATUS = "AUDIOFIX_CAPTURE_STATUS";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// ─── Logging helpers ────────────────────────────────────────────────────────

function log(...args: any[]) {
    console.log("[AudioFix]", ...args);
}

function logWarn(...args: any[]) {
    console.warn("[AudioFix]", ...args);
}

function logError(...args: any[]) {
    console.error("[AudioFix]", ...args);
}

// ─── State ──────────────────────────────────────────────────────────────────

const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

let activeAudioContext: AudioContext | null = null;
let activeProcessor: ScriptProcessorNode | null = null;
let activeStopFn: (() => void) | null = null;

// ─── PCM -> MediaStreamTrack plumbing ───────────────────────────────────────
// Same shape as Vesktop's own screenShareFixes.ts: buffer incoming Int16 PCM
// chunks, convert to Float32, and pull them out through a ScriptProcessorNode
// feeding a MediaStreamDestination.

function buildTrackFromPcmStream(onStopped: () => void): { track: MediaStreamTrack; stop: () => void } {
    const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const processor = audioContext.createScriptProcessor(2048, 0, CHANNELS);
    const destination = audioContext.createMediaStreamDestination();

    const pendingChunks: Float32Array[] = [];
    let currentChunk: Float32Array | undefined;
    let chunkOffset = 0;
    let keepFilling = true;

    // Background loop to aggressively pre-fetch chunks (buffer size from settings)
    const fillBuffer = async () => {
        const bufferSize = settings.store.bufferSize ?? 8;
        while (keepFilling) {
            if (pendingChunks.length < bufferSize) {
                try {
                    const chunk = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.getPcmChunk?.();
                    if (chunk) {
                        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                        const input = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
                        const converted = new Float32Array(input.length);
                        for (let i = 0; i < input.length; i++) converted[i] = input[i] / 32768;
                        pendingChunks.push(converted);
                    }
                } catch {
                    // Silently ignore errors during fetch
                }
            } else {
                // Buffer full, sleep briefly
                await new Promise(resolve => setTimeout(resolve, 0.5));
            }
        }
    };

    fillBuffer();

    // Synchronous callback - never blocks
    processor.onaudioprocess = event => {
        const outputs = Array.from({ length: CHANNELS }, (_, index) => event.outputBuffer.getChannelData(index));

        for (let sample = 0; sample < outputs[0].length; sample++) {
            if (!currentChunk || chunkOffset >= currentChunk.length) {
                currentChunk = pendingChunks.shift();
                chunkOffset = 0;
            }
            for (let channel = 0; channel < CHANNELS; channel++) {
                outputs[channel][sample] = currentChunk ? currentChunk[chunkOffset + channel] ?? 0 : 0;
            }
            if (currentChunk) chunkOffset += CHANNELS;
        }
    };

    processor.connect(destination);
    void audioContext.resume();

    const stop = () => {
        keepFilling = false;
        try {
            processor.disconnect();
        } catch {
            /* already disconnected */
        }
        void audioContext.close();
        onStopped();
    };

    activeAudioContext = audioContext;
    activeProcessor = processor;
    activeStopFn = stop;

    return { track: destination.stream.getAudioTracks()[0], stop };
}

function teardownActiveCapture() {
    activeStopFn?.();
    activeAudioContext = null;
    activeProcessor = null;
    activeStopFn = null;
    try {
        (VencordNative.pluginHelpers as any).WindowsAudioFix?.stopCapture?.();
    } catch {
        /* plugin helper not available / already stopped */
    }
}

// ─── Determine share mode + target pid ─────────────────────────────────────

function getWindowHandleFromSourceId(sourceId: string): string | null {
    const [kind, handle] = sourceId.split(":");
    if (kind !== "window" || !handle) return null;
    return handle;
}

async function resolveCaptureTarget(
    videoTrack: MediaStreamTrack
): Promise<{ mode: "include" | "exclude"; pid: number } | null> {
    const settings = videoTrack.getSettings() as MediaTrackSettings & { displaySurface?: string };
    const sourceId = (settings as any).deviceId as string | undefined;
    if (!sourceId) return null;

    const isScreenShare = settings.displaySurface === "monitor";
    const isWindowShare = !isScreenShare && (settings.displaySurface === "window" || sourceId.startsWith("window:"));

    if (isWindowShare) {
        const hwnd = getWindowHandleFromSourceId(sourceId);
        if (!hwnd) return null;

        const pid: number | null = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.resolveWindowPid?.(
            hwnd
        );
        if (!pid) return null;

        return { mode: "include", pid };
    }

    if (isScreenShare) {
        // Screen share: exclude our own process tree instead to avoid capturing our own audio.
        // Get the main process PID from the native side (renderer process.pid is just the child renderer, not the app).
        const mainPid: number | null = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.getMainProcessPid?.();
        if (!mainPid) return null;

        return { mode: "exclude", pid: mainPid };
    }

    return null;
}

// ─── Patched getDisplayMedia ────────────────────────────────────────────────

async function patchedGetDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream> {
    const stream = await origGetDisplayMedia(constraints);

    if (process.platform !== "win32") return stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return stream;

    const target = await resolveCaptureTarget(videoTrack).catch(err => {
        logWarn(`Could not determine capture target (${err?.message ?? err}).`);
        return null;
    });

    if (!target) {
        // No warning here for the "not applicable" case (e.g. non-Windows,
        // no sourceId) -- only warn when something that should have worked
        // didn't. resolveCaptureTarget already warns on real errors above.
        return stream;
    }

    // Status is now handled through the native handler's return value and callbacks
    const statusPromise = Promise.resolve(true);

    const startResult = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.startCapture?.(
        target.mode,
        target.pid
    ).catch((err: any) => {
        logWarn(`Failed to launch native audio capture (${err?.message ?? err}).`);
        return null;
    });

    if (!startResult || startResult.ok === false) {
        if (startResult?.reason && startResult.reason !== "unsupported") {
            logWarn(`Native audio capture unavailable (${startResult.detail ?? startResult.reason}).`);
        }
        return stream; // Electron's default loopback audio track stays on the stream untouched.
    }

    const started = await statusPromise;
    if (!started) {
        return stream;
    }

    // Swap in our process-scoped track in place of whatever Electron gave us.
    for (const t of stream.getAudioTracks()) {
        stream.removeTrack(t);
        t.stop();
    }

    const { track } = buildTrackFromPcmStream(() => {
        logError("PCM stream stopped");
    });
    stream.addTrack(track);

    log(target.mode === "include" ? "Streaming only this window's audio." : "Excluding this app's audio from your stream.");

    videoTrack.addEventListener(
        "ended",
        () => {
            teardownActiveCapture();
        },
        { once: true }
    );

    return stream;
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    bufferSize: {
        description: "Number of PCM chunks to buffer. Higher = less choppy but more latency. Lower = less latency but risk of popping.",
        type: OptionType.NUMBER,
        default: 8,
        min: 2,
        max: 16,
        markers: [2, 4, 8, 12, 16],
    },
});

export default definePlugin({
    name: "Vesktop Audio Fix",
    description:
        "Routes only the streamed app's audio (or excludes your own client's audio) during screen share on Windows, via native WASAPI process-loopback capture.",
    authors: [{ name: "Gtair", id: 1123259540176113724n }],
    settings,

    start() {
        if (process.platform !== "win32") {
            log("Not Windows — inactive");
            return;
        }
        navigator.mediaDevices.getDisplayMedia = patchedGetDisplayMedia;
        log("Started");
    },

    stop() {
        navigator.mediaDevices.getDisplayMedia = origGetDisplayMedia;
        teardownActiveCapture();
        log("Stopped");
    }
});