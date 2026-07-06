import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

async function log(...args: any[]) {
    console.log("[AudioFix]", ...args);
    try {
        await (VencordNative.pluginHelpers as any).WindowsAudioFix?.logToFile?.(args);
    } catch {
        /* logging failure is non-critical */
    }
}

const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

let activeAudioContext: AudioContext | null = null;
let activeProcessor: ScriptProcessorNode | null = null;
let activeStopFn: (() => void) | null = null;

function buildTrackFromPcmStream(onStopped: () => void): { track: MediaStreamTrack; stop: () => void } {
    const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const processor = audioContext.createScriptProcessor(2048, 0, CHANNELS);
    const destination = audioContext.createMediaStreamDestination();

    const pendingChunks: Float32Array[] = [];
    let currentChunk: Float32Array | undefined;
    let chunkOffset = 0;
    let keepFilling = true;

    const fillBuffer = async () => {
        const bufferSize = settings.store.bufferSize ?? 8;
        while (keepFilling) {
            if (pendingChunks.length < bufferSize) {
                const chunk = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.getPcmChunk?.().catch(() => null);
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
    (VencordNative.pluginHelpers as any).WindowsAudioFix?.stopCapture?.().catch(() => {});
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
    if (!sourceId) return null;

    const isScreenShare = settings.displaySurface === "monitor";
    const isWindowShare = !isScreenShare && (settings.displaySurface === "window" || sourceId.startsWith("window:"));

    if (isWindowShare) {
        const hwnd = getWindowHandleFromSourceId(sourceId);
        if (!hwnd) return null;

        const pid = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.resolveWindowPid?.(hwnd);
        return pid ? { mode: "include", pid } : null;
    }

    if (isScreenShare) {
        const mainPid = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.getMainProcessPid?.();
        return mainPid ? { mode: "exclude", pid: mainPid } : null;
    }

    return null;
}

async function patchedGetDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream> {
    const stream = await origGetDisplayMedia(constraints);

    if (process.platform !== "win32") return stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return stream;

    const target = await resolveCaptureTarget(videoTrack).catch(err => {
        log(`Could not determine capture target (${err?.message ?? err}).`);
        return null;
    });

    if (!target) {
        return stream;
    }

    const startResult = await (VencordNative.pluginHelpers as any).WindowsAudioFix?.startCapture?.(
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

    const { track } = buildTrackFromPcmStream(() => {
        log("PCM stream stopped");
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