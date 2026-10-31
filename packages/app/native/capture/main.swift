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
// Both tracks share one clock (t0, below). If a source stalls or restarts —
// the default microphone changes when headphones connect, say — the missing
// time is written as silence, so the two files stay aligned and the app can
// interleave who said what. The microphone follows the system default input
// device live. It is captured through Core Audio directly rather than
// AVAudioEngine, which also drives the output and stops for good when any
// audio device changes.
//
// stdout is line-delimited JSON events: ready, level (1/s), warning, mic
// (device in use, on every (re)start), error, stopped.
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
/// One clock for both tracks: where "now" falls on the recording's timeline.
let t0 = DispatchTime.now().uptimeNanoseconds
let gapThresholdSeconds = 0.35

final class Sink {
    private var file: AVAudioFile?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?
    private let lock = NSLock()
    private var peak: Float = 0
    private var written: Int64 = 0  // frames at 16 kHz

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
        // Anything we should already have written but haven't is a stall:
        // fill it with silence so this track stays on the shared timeline.
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e9
        let deficit = elapsed - Double(written + Int64(out.frameLength)) / 16000
        if deficit > gapThresholdSeconds,
           let pad = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(deficit * 16000)) {
            pad.frameLength = pad.frameCapacity  // zero-filled
            try? file?.write(from: pad)
            written += Int64(pad.frameLength)
        }
        try? file?.write(from: out)
        written += Int64(out.frameLength)
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

func hal<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ value: inout T) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &value) == noErr
}

/// Records the system's default input device, and moves with it.
final class MicCapture {
    private let queue = DispatchQueue(label: "distill.capture.mic", qos: .userInteractive)
    private let ioQueue = DispatchQueue(label: "distill.capture.mic.io", qos: .userInteractive)
    private var device = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var retry: DispatchSourceTimer?
    private var pending: DispatchWorkItem?
    private var listening: [(AudioObjectID, AudioObjectPropertySelector)] = []
    private var stopped = false

    private func listener(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) {
        var a = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        AudioObjectAddPropertyListenerBlock(obj, &a, queue) { [weak self] _, _ in self?.scheduleRestart() }
        listening.append((obj, sel))
    }

    /// Returns whether a microphone is recording right now.
    @discardableResult func start() -> Bool {
        queue.sync {
            // Re-run on any change to which device is default, and on the
            // chosen device's own rate/liveness (a headset switching profile).
            listener(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice)
            return open()
        }
    }

    private func close() {
        if let procID, device != kAudioObjectUnknown {
            AudioDeviceStop(device, procID)
            AudioDeviceDestroyIOProcID(device, procID)
        }
        procID = nil
        device = AudioObjectID(kAudioObjectUnknown)
    }

    private func open() -> Bool {
        close()
        var dev = AudioObjectID(kAudioObjectUnknown)
        guard hal(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, &dev), dev != kAudioObjectUnknown else {
            armRetry(); return false
        }
        var asbd = AudioStreamBasicDescription()
        guard hal(dev, kAudioDevicePropertyStreamFormat, scope: kAudioObjectPropertyScopeInput, &asbd),
              asbd.mSampleRate > 0, let format = AVAudioFormat(streamDescription: &asbd) else {
            armRetry(); return false
        }
        var pid: AudioDeviceIOProcID?
        let st = AudioDeviceCreateIOProcIDWithBlock(&pid, dev, ioQueue) { _, inData, _, _, _ in
            guard let b = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: inData, deallocator: nil) else { return }
            micSink.append(b)
        }
        guard st == noErr, let pid, AudioDeviceStart(dev, pid) == noErr else { armRetry(); return false }
        device = dev; procID = pid
        listener(dev, kAudioDevicePropertyNominalSampleRate)
        listener(dev, kAudioDevicePropertyDeviceIsAlive)
        retry?.cancel(); retry = nil
        var name: Unmanaged<CFString>?
        _ = hal(dev, kAudioObjectPropertyName, &name)
        emit(["event": "mic", "device": (name?.takeRetainedValue() as String?) ?? "?", "rate": asbd.mSampleRate, "channels": Int(asbd.mChannelsPerFrame)])
        return true
    }

    /// Several notifications fire for one change; act once, after things settle.
    private func scheduleRestart() {
        guard !stopped else { return }
        pending?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.stopped else { return }
            if !self.open() { emit(["event": "warning", "message": "Microphone changed and could not be reopened yet; retrying."]) }
        }
        pending = item
        queue.asyncAfter(deadline: .now() + 0.5, execute: item)
    }

    /// No usable input right now (unplugged, still waking). Keep trying.
    private func armRetry() {
        guard retry == nil, !stopped else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak self] in _ = self?.open() }
        t.resume()
        retry = t
    }

    func stop() {
        queue.sync { stopped = true; pending?.cancel(); retry?.cancel(); close() }
    }
}

let mic = MicCapture()
let micOK = mic.start()
if !micOK { emit(["event": "warning", "message": "No microphone input available yet; will keep trying."]) }

emit(["event": "ready", "mic": micOK, "tapRate": tapFormat.sampleRate])

// MARK: run until told to stop

func shutdown() {
    mic.stop()
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
