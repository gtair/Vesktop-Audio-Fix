// capture.exe
//
// Minimal WASAPI process-loopback capture helper.
//
// Usage:
//   capture.exe --include <pid>       Capture ONLY audio rendered by <pid>
//                                      and its child process tree. Used for
//                                      window shares.
//   capture.exe --exclude <pid>       Capture all system audio EXCEPT audio
//                                      rendered by <pid> and its child
//                                      process tree. Used for screen shares
//                                      (pid = our own host app's pid, so we
//                                      don't hear ourselves).
//   capture.exe --resolve-hwnd <hwnd> Print the owning process id of the
//                                      given window handle to stdout as a
//                                      decimal number, then exit immediately.
//                                      No audio work is done. Exit code 0 on
//                                      success, 4 if the handle is invalid or
//                                      has no owning process.
//
// Output: raw PCM (48kHz, 16-bit, stereo, interleaved) written to stdout as
// it becomes available. Diagnostics go to stderr.
//
// Exit codes:
//   0  - clean shutdown (stdout closed / killed)
//   1  - bad arguments
//   2  - unsupported OS (process-loopback APIs unavailable)
//   3  - WASAPI activation/init failure

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <fcntl.h>
#include <mmdeviceapi.h>
#include <objidl.h>
#include <propidl.h>
#include <stdio.h>
#include <stdlib.h>
#include <wrl/client.h>
#include <windows.h>
#include <io.h>
#include <winternl.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace
{
constexpr REFERENCE_TIME BUFFER_DURATION = 200000; // 20ms
constexpr WORD CHANNELS = 2;
constexpr DWORD SAMPLE_RATE = 48000;
constexpr WORD BITS_PER_SAMPLE = 16;

bool supports_process_loopback()
{
    const auto ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return false;

    using RtlGetVersionFn = LONG(WINAPI *)(PRTL_OSVERSIONINFOW);
    const auto rtl_get_version = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
    if (!rtl_get_version) return false;

    RTL_OSVERSIONINFOW version = {};
    version.dwOSVersionInfoSize = sizeof(version);
    if (rtl_get_version(&version) != 0) return false;

    return version.dwBuildNumber >= 20348;
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject
{
public:
    explicit ActivationHandler(HANDLE event) : event_(event) {}

    STDMETHODIMP QueryInterface(REFIID riid, void **ppvObject) override
    {
        if (ppvObject == nullptr) return E_POINTER;

        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
            riid == __uuidof(IAgileObject))
        {
            *ppvObject = static_cast<IAgileObject *>(this);
            AddRef();
            return S_OK;
        }

        *ppvObject = nullptr;
        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override { return ++ref_count_; }

    STDMETHODIMP_(ULONG) Release() override
    {
        const auto value = --ref_count_;
        if (value == 0) delete this;
        return value;
    }

    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *operation) override
    {
        HRESULT activate_result = E_FAIL;
        ComPtr<IUnknown> activated_interface;
        result_ = operation->GetActivateResult(&activate_result, &activated_interface);

        if (SUCCEEDED(result_) && SUCCEEDED(activate_result))
        {
            result_ = activated_interface.As(&audio_client_);
        }
        else if (SUCCEEDED(result_))
        {
            result_ = activate_result;
        }

        SetEvent(event_);
        return S_OK;
    }

    HRESULT result() const { return result_; }
    ComPtr<IAudioClient> audio_client() const { return audio_client_; }

private:
    std::atomic<ULONG> ref_count_ = 1;
    HANDLE event_;
    HRESULT result_ = E_PENDING;
    ComPtr<IAudioClient> audio_client_;
};

WAVEFORMATEX create_wave_format()
{
    WAVEFORMATEX format = {};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = CHANNELS;
    format.nSamplesPerSec = SAMPLE_RATE;
    format.wBitsPerSample = BITS_PER_SAMPLE;
    format.nBlockAlign = static_cast<WORD>((format.nChannels * format.wBitsPerSample) / 8);
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    return format;
}

bool write_all(const BYTE *data, size_t length)
{
    while (length > 0)
    {
        const auto written = fwrite(data, 1, length, stdout);
        if (written == 0) return false;
        data += written;
        length -= written;
    }
    fflush(stdout);
    return true;
}

struct Args
{
    PROCESS_LOOPBACK_MODE mode;
    DWORD pid;
};

bool parse_args(int argc, char **argv, Args &out)
{
    if (argc < 3) return false;

    const std::string mode_flag = argv[1];
    if (mode_flag == "--include")
    {
        out.mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    }
    else if (mode_flag == "--exclude")
    {
        out.mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    }
    else
    {
        return false;
    }

    char *end = nullptr;
    const auto pid = strtoul(argv[2], &end, 10);
    if (end == argv[2] || *end != '\0' || pid == 0) return false;

    out.pid = static_cast<DWORD>(pid);
    return true;
}

// Handles `--resolve-hwnd <hwnd>`. Returns true if this mode was requested
// (regardless of success/failure), so main() knows to exit immediately
// instead of falling through to the audio capture path.
bool try_handle_resolve_hwnd(int argc, char **argv, int &exit_code)
{
    if (argc < 3 || std::string(argv[1]) != "--resolve-hwnd") return false;

    char *end = nullptr;
    const auto raw = strtoull(argv[2], &end, 0);
    if (end == argv[2] || *end != '\0' || raw == 0)
    {
        std::cerr << "Invalid window handle" << std::endl;
        exit_code = 4;
        return true;
    }

    const auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(raw));
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);

    if (pid == 0)
    {
        std::cerr << "No owning process for handle" << std::endl;
        exit_code = 4;
        return true;
    }

    std::cout << pid << std::endl;
    exit_code = 0;
    return true;
}
} // namespace

int main(int argc, char **argv)
{
    // Set binary mode for stdout immediately
    _setmode(_fileno(stdout), _O_BINARY);

    int resolve_exit_code = 0;
    if (try_handle_resolve_hwnd(argc, argv, resolve_exit_code))
    {
        return resolve_exit_code;
    }

    Args args{};
    if (!parse_args(argc, argv, args))
    {
        std::cerr << "Usage: capture.exe --include|--exclude <pid>  OR  capture.exe --resolve-hwnd <hwnd>" << std::endl;
        return 1;
    }

    if (!supports_process_loopback())
    {
        std::cerr << "UNSUPPORTED: OS build does not support process-loopback capture" << std::endl;
        return 2;
    }

    const auto com_result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(com_result))
    {
        std::cerr << "CoInitializeEx failed: 0x" << std::hex << com_result << std::endl;
        return 3;
    }

    HANDLE ready_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!ready_event)
    {
        std::cerr << "CreateEvent failed" << std::endl;
        CoUninitialize();
        return 3;
    }

    AUDIOCLIENT_ACTIVATION_PARAMS activation_params = {};
    activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation_params.ProcessLoopbackParams.TargetProcessId = args.pid;
    activation_params.ProcessLoopbackParams.ProcessLoopbackMode = args.mode;

    PROPVARIANT activate_params = {};
    activate_params.vt = VT_BLOB;
    activate_params.blob.cbSize = sizeof(AUDIOCLIENT_ACTIVATION_PARAMS);
    activate_params.blob.pBlobData = reinterpret_cast<BYTE *>(&activation_params);

    auto *handler = new ActivationHandler(ready_event);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;

    const auto activate_hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activate_params,
        handler,
        &operation);

    if (FAILED(activate_hr))
    {
        std::cerr << "ActivateAudioInterfaceAsync failed: 0x" << std::hex << activate_hr << std::endl;
        handler->Release();
        CloseHandle(ready_event);
        CoUninitialize();
        return 3;
    }

    WaitForSingleObject(ready_event, INFINITE);
    CloseHandle(ready_event);

    const auto handler_result = handler->result();
    auto audio_client = handler->audio_client();
    handler->Release();

    if (FAILED(handler_result) || !audio_client)
    {
        std::cerr << "Activation failed: 0x" << std::hex << handler_result << std::endl;
        CoUninitialize();
        return 3;
    }

    auto format = create_wave_format();
    DWORD stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

    const auto init_hr = audio_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED, stream_flags, BUFFER_DURATION, BUFFER_DURATION, &format, nullptr);

    if (FAILED(init_hr))
    {
        std::cerr << "IAudioClient::Initialize failed: 0x" << std::hex << init_hr << std::endl;
        CoUninitialize();
        return 3;
    }

    HANDLE sample_ready_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!sample_ready_event)
    {
        std::cerr << "CreateEvent for capture failed" << std::endl;
        CoUninitialize();
        return 3;
    }

    if (FAILED(audio_client->SetEventHandle(sample_ready_event)))
    {
        std::cerr << "SetEventHandle failed" << std::endl;
        CloseHandle(sample_ready_event);
        CoUninitialize();
        return 3;
    }

    ComPtr<IAudioCaptureClient> capture_client;
    if (FAILED(audio_client->GetService(IID_PPV_ARGS(&capture_client))))
    {
        std::cerr << "GetService(IAudioCaptureClient) failed" << std::endl;
        CloseHandle(sample_ready_event);
        CoUninitialize();
        return 3;
    }

    if (FAILED(audio_client->Start()))
    {
        std::cerr << "IAudioClient::Start failed" << std::endl;
        CloseHandle(sample_ready_event);
        CoUninitialize();
        return 3;
    }

    std::cerr << "READY" << std::endl; // caller can use this line to confirm capture actually started

    std::vector<BYTE> silence;
    silence.reserve(8192);

    while (true)
    {
        if (WaitForSingleObject(sample_ready_event, INFINITE) != WAIT_OBJECT_0) break;

        UINT32 packet_length = 0;
        if (FAILED(capture_client->GetNextPacketSize(&packet_length))) break;

        while (packet_length > 0)
        {
            BYTE *data = nullptr;
            UINT32 frames_available = 0;
            DWORD flags = 0;
            UINT64 device_position = 0;
            UINT64 qpc_position = 0;

            const auto buffer_hr =
                capture_client->GetBuffer(&data, &frames_available, &flags, &device_position, &qpc_position);
            if (FAILED(buffer_hr))
            {
                packet_length = 0;
                break;
            }

            const size_t bytes_to_write = static_cast<size_t>(frames_available) * format.nBlockAlign;
            bool wrote = true;

            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
            {
                if (silence.size() < bytes_to_write) silence.assign(bytes_to_write, 0);
                wrote = write_all(silence.data(), bytes_to_write);
            }
            else
            {
                wrote = write_all(data, bytes_to_write);
            }

            capture_client->ReleaseBuffer(frames_available);

            if (!wrote)
            {
                // stdout closed (parent stopped reading) -- shut down quietly.
                audio_client->Stop();
                CloseHandle(sample_ready_event);
                CoUninitialize();
                return 0;
            }

            if (FAILED(capture_client->GetNextPacketSize(&packet_length)))
            {
                packet_length = 0;
                break;
            }
        }
    }

    audio_client->Stop();
    CloseHandle(sample_ready_event);
    CoUninitialize();
    return 0;
}
