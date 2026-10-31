// distill-capture — records system audio (what Teams/Zoom/etc. play) and the
// microphone to two separate 16 kHz mono WAV files until SIGINT/SIGTERM.
//
//   distill-capture <system.wav> <mic.wav>
//
// System audio uses a Core Audio process tap (macOS 14.2+): no virtual
// driver, no Screen Recording permission, only the "System Audio Recording"
// prompt. Two files rather than one mix so the app can mix them with ffmpeg
// and, later, tell the user's voice from everyone else's.
//
// stdout is line-delimited JSON events: ready, level (1/s), error, stopped.
// A denied permission does NOT fail — macOS delivers silence — so the
// level events are how the app detects it.

import Foundation
import AVFoundation
import CoreAudio

setvbuf(stdout, nil, _IOLBF, 0)
// The app reading our stdout may die first; that must not kill us before we finalise.
signal(SIGPIPE, SIG_IGN)

func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) { print(s) }
}

func fail(_ msg: String) -> Never {
    emit(["event": "error", "message": msg])
    exit(1)
}

/// Converts whatever format a source delivers to 16 kHz mono and appends it
/// to a WAV file. Tracks peak level since the last report.
final class Sink {
    private var file: AVAudioFile?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?
    private let lock = NSLock()
    private var peak: Float = 0

    init(path: String) throws {
        file = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ])
    }

    func append(_ buf: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        if converter == nil || converterInput != buf.format {
            converter = AVAudioConverter(from: buf.format, to: target)
            converterInput = buf.format
        }
        guard let conv = converter else { return }
        let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / buf.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        if err != nil || out.frameLength == 0 { return }
        if let p = out.floatChannelData?[0] {
            for i in 0..<Int(out.frameLength) { peak = max(peak, abs(p[i])) }
        }
        try? file?.write(from: out)
    }

    /// AVAudioFile finalises the WAV header only when it is released; exit() would skip that.
    func close() { lock.lock(); file = nil; lock.unlock() }

    func takePeak() -> Float { lock.lock(); defer { lock.unlock() }; let p = peak; peak = 0; return p }
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: distill-capture <system.wav> <mic.wav>") }

let systemSink: Sink, micSink: Sink
do {
    systemSink = try Sink(path: args[1])
    micSink = try Sink(path: args[2])
} catch { fail("cannot create output files: \(error.localizedDescription)") }

// MARK: system audio tap

guard #available(macOS 14.2, *) else { fail("System audio capture needs macOS 14.2 or later.") }

let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDesc.uuid = UUID()
tapDesc.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
var st = AudioHardwareCreateProcessTap(tapDesc, &tapID)
guard st == noErr else { fail("Could not create the system audio tap (OSStatus \(st)).") }

var fmtAddr = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var asbd = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
st = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &asbdSize, &asbd)
guard st == noErr, let tapFormat = AVAudioFormat(streamDescription: &asbd) else { fail("Could not read the tap format (OSStatus \(st)).") }

let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "distill-capture",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceTapListKey: [[
        kAudioSubTapUIDKey: tapDesc.uuid.uuidString,
        kAudioSubTapDriftCompensationKey: true,
    ]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
guard st == noErr else { fail("Could not create the capture device (OSStatus \(st)).") }

var procID: AudioDeviceIOProcID?
let ioQueue = DispatchQueue(label: "distill.capture.io", qos: .userInteractive)
st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, ioQueue) { _, inData, _, _, _ in
    guard let b = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: inData, deallocator: nil) else { return }
    systemSink.append(b)
}
guard st == noErr, let procID else { fail("Could not attach to the capture device (OSStatus \(st)).") }
st = AudioDeviceStart(aggID, procID)
guard st == noErr else { fail("Could not start system audio capture (OSStatus \(st)).") }

// MARK: microphone

let engine = AVAudioEngine()
let micFormat = engine.inputNode.outputFormat(forBus: 0)
var micOK = false
if micFormat.sampleRate > 0 {
    engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buf, _ in micSink.append(buf) }
    do { try engine.start(); micOK = true } catch { emit(["event": "warning", "message": "Microphone unavailable: \(error.localizedDescription)"]) }
} else {
    emit(["event": "warning", "message": "No microphone input available."])
}

emit(["event": "ready", "mic": micOK, "tapRate": tapFormat.sampleRate])

// MARK: run until told to stop

func shutdown() {
    if micOK { engine.inputNode.removeTap(onBus: 0); engine.stop() }
    AudioDeviceStop(aggID, procID)
    AudioDeviceDestroyIOProcID(aggID, procID)
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    systemSink.close()
    micSink.close()
    emit(["event": "stopped"])
    exit(0)
}

// If the app that launched us dies, stop (finalising the files) rather than
// record on, unattended, with nobody to stop us.
let launcher = getppid()

signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
let sigQueue = DispatchQueue(label: "distill.capture.sig")
let sources = [SIGINT, SIGTERM].map { sig -> DispatchSourceSignal in
    let s = DispatchSource.makeSignalSource(signal: sig, queue: sigQueue)
    s.setEventHandler { shutdown() }
    s.resume()
    return s
}
_ = sources

let timer = DispatchSource.makeTimerSource(queue: sigQueue)
timer.schedule(deadline: .now() + 1, repeating: 1)
timer.setEventHandler {
    if getppid() != launcher { shutdown() }
    emit(["event": "level", "system": systemSink.takePeak(), "mic": micSink.takePeak()])
}
timer.resume()

dispatchMain()
