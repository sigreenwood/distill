// distill-callwatch — reports when a call app starts or stops using the
// microphone. Reading these Core Audio properties needs no permission.
//
//   distill-callwatch [bundle-id-prefix ...]
//
// Default prefixes cover Zoom and Microsoft Teams (new and classic). Prints
// line-delimited JSON on change: {"event":"call","active":true,"app":"us.zoom.xos"}.
// A browser-based Teams/Zoom call is not detected (the mic belongs to the
// browser), and "mic open" is a heuristic: a muted participant may still count.

import Foundation
import CoreAudio

setvbuf(stdout, nil, _IOLBF, 0)

let prefixes = CommandLine.arguments.dropFirst().isEmpty
    ? ["us.zoom.", "com.microsoft.teams"]
    : Array(CommandLine.arguments.dropFirst())

func addr(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func processes() -> [AudioObjectID] {
    var a = addr(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func bundleID(_ p: AudioObjectID) -> String? {
    var a = addr(kAudioProcessPropertyBundleID)
    var s: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(p, &a, 0, nil, &size, &s) == noErr, let s else { return nil }
    return s.takeRetainedValue() as String
}

func isRunningInput(_ p: AudioObjectID) -> Bool {
    var a = addr(kAudioProcessPropertyIsRunningInput)
    var v: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(p, &a, 0, nil, &size, &v) == noErr && v != 0
}

/// Bundle id of the first matching app using the mic, or nil.
func activeCallApp() -> String? {
    for p in processes() {
        guard let b = bundleID(p), prefixes.contains(where: { b.hasPrefix($0) }), isRunningInput(p) else { continue }
        return b
    }
    return nil
}

func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { print(s) }
}

var current: String?
// Debounce: a call is "over" only after the mic has been closed for 3 polls,
// so a brief device switch doesn't read as hang-up-and-redial.
var misses = 0
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: 2)
timer.setEventHandler {
    let now = activeCallApp()
    if let now {
        misses = 0
        if current == nil { current = now; emit(["event": "call", "active": true, "app": now]) }
    } else if let was = current {
        misses += 1
        if misses >= 3 { current = nil; misses = 0; emit(["event": "call", "active": false, "app": was]) }
    }
}
timer.resume()
signal(SIGTERM) { _ in exit(0) }
dispatchMain()
