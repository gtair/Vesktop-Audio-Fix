import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

async function log(...args: any[]) {
    console.log("[AudioFix]", ...args);
    try {
        await Native?.logToFile?.(args);
    } catch {
        /* logging failure is non-critical */
    }
}

const Native = (VencordNative.pluginHelpers as any)["Vesktop Audio Fix"];

const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

let activeStopFn: (() => void) | null = null;
let closingContextPromise: Promise<void> | null = null;
let captureGeneration = 0;

async function buildTrackFromPcmStream(onStopped: () => void): Promise<{ track: MediaStreamTrack; stop: () => void }> {
    // Wait for any previous AudioContext to fully release its resources before
    // creating a new one, otherwise the Web Audio scheduler on second+ streams
    // can stutter from residual state.
    if (closingContextPromise) {
        await closingContextPromise;
        closingContextPromise = null;
    }

    const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const processor = audioContext.createScriptProcessor(2048, 0, CHANNELS);
    const destination = audioContext.createMediaStreamDestination();

    const pendingChunks: Float32Array[] = [];
    let currentChunk: Float32Array | undefined;
    let chunkOffset = 0;
    let keepFilling = true;

    const stop = () => {
        keepFilling = false;
        try {
            processor.disconnect();
        } catch {
            /* already disconnected */
        }
        closingContextPromise = audioContext.close();
        onStopped();
    };

    activeStopFn = stop;

    const fillBuffer = async () => {
        const bufferSize = settings.store.bufferSize ?? 8;
        while (keepFilling) {
            if (pendingChunks.length < bufferSize) {
                const chunk = await Native?.getPcmChunk?.().catch(() => null);
                if (chunk) {
                    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    const input = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
                    const converted = new Float32Array(input.length);
                    for (let i = 0; i < input.length; i++) converted[i] = input[i] / 32768;
                    pendingChunks.push(converted);
                } else {
                    await new Promise(resolve => setTimeout(resolve, 2));
                }
            } else {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
    };

    fillBuffer();

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

    // Pre-fill the renderer buffer before starting playback so the first
    // onaudioprocess callback always has data and doesn't pop with silence.
    const prefill = Math.min(4, settings.store.bufferSize ?? 4);
    while (keepFilling && pendingChunks.length < prefill) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    if (keepFilling) void audioContext.resume();

    return { track: destination.stream.getAudioTracks()[0], stop };
}

function teardownActiveCapture() {
    captureGeneration++; // invalidate any pending ended handlers from old streams
    activeStopFn?.();
    activeStopFn = null;
    Native?.stopCapture?.().catch(() => {});
}

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

    log("resolveCaptureTarget: displaySurface=", settings.displaySurface, "sourceId=", sourceId);

    if (!sourceId) {
        log("resolveCaptureTarget: no sourceId, aborting");
        return null;
    }

    const isScreenShare = settings.displaySurface === "monitor" || sourceId.startsWith("screen:");
    const isWindowShare = !isScreenShare && (settings.displaySurface === "window" || sourceId.startsWith("window:"));

    if (isWindowShare) {
        const hwnd = getWindowHandleFromSourceId(sourceId);
        if (!hwnd) return null;

        const pid = await Native?.resolveWindowPid?.(hwnd);
        if (!pid) log("resolveCaptureTarget: resolveWindowPid returned null for hwnd=", hwnd);
        return pid ? { mode: "include", pid } : null;
    }

    if (isScreenShare) {
        const mainPid = await Native?.getMainProcessPid?.();
        if (!mainPid) log("resolveCaptureTarget: getMainProcessPid returned null");
        return mainPid ? { mode: "exclude", pid: mainPid } : null;
    }

    log("resolveCaptureTarget: unrecognized surface/sourceId, cannot determine target");
    return null;
}

async function patchedGetDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream> {
    log("getDisplayMedia intercepted, platform=", process.platform);
    const stream = await origGetDisplayMedia(constraints);

    if (process.platform !== "win32") return stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
        log("no video track in stream, skipping");
        return stream;
    }

    const target = await resolveCaptureTarget(videoTrack).catch(err => {
        log(`Could not determine capture target (${err?.message ?? err}).`);
        return null;
    });

    if (!target) {
        log("could not resolve capture target, passing stream through unchanged");
        return stream;
    }

    // Stop previous session's audio graph before starting a new one.
    // startCapture (below) handles killing the native process; we just need
    // the AudioContext closed so buildTrackFromPcmStream can await it.
    const thisGeneration = ++captureGeneration;
    const prevStop = activeStopFn;
    activeStopFn = null;
    prevStop?.();

    const startResult = await Native?.startCapture?.(
        target.mode,
        target.pid,
        settings.store.bufferSize
    ).catch((err: any) => {
        log(`Failed to launch native audio capture (${err?.message ?? err}).`);
        return null;
    });

    if (!startResult || startResult.ok === false) {
        if (startResult?.reason && startResult.reason !== "unsupported") {
            log(`Native audio capture unavailable (${startResult.detail ?? startResult.reason}).`);
        }
        return stream;
    }

    for (const t of stream.getAudioTracks()) {
        stream.removeTrack(t);
        t.stop();
    }

    const { track, stop } = await buildTrackFromPcmStream(() => {
        log("PCM stream stopped");
    });
    stream.addTrack(track);

    log(target.mode === "include" ? "Streaming only this window's audio." : "Excluding this app's audio from your stream.");

    videoTrack.addEventListener(
        "ended",
        () => {
            // Always clean up this session's audio graph.
            stop();
            // Only stop native capture if no newer session has taken over.
            if (captureGeneration === thisGeneration) {
                activeStopFn = null;
                Native?.stopCapture?.().catch(() => {});
            }
        },
        { once: true }
    );

    return stream;
}

const settings = definePluginSettings({
    bufferSize: {
        description: "Number of PCM chunks to buffer. Higher = less choppy but more latency. Lower = less latency but risk of popping. Screen shares need higher values.",
        type: OptionType.NUMBER,
        default: 16,
        min: 2,
        max: 32,
        markers: [2, 4, 8, 16, 24, 32],
    },
});

export default definePlugin({
    name: "Vesktop Audio Fix",
    description:
        "Routes only the streamed app's audio (or excludes your own client's audio) during screen share on Windows, via native WASAPI process-loopback capture.",
    authors: [{ name: "gtair", id: 1123259540176113724n }],
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
    }
});