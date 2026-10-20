// Reports which processes are using a microphone, via CoreAudio process
// objects (macOS 14+). This is the same information behind the orange
// microphone indicator in the menu bar.
//
// Emits line-delimited JSON on stdout:
//
//   {"type":"start"}
//   {"type":"mic","users":[{"pid":123,"bundleId":"us.zoom.xos"}]}
//
// A "mic" line is written once at start and again whenever the set of
// processes using a microphone changes. The host process
// (src/main/meetingDetector.ts) decides which of them is the call; this helper
// only reports. It captures no audio and needs no audio-capture permission.
//
// Build: swiftc -O -o meeting-detector main.swift -framework CoreAudio

import CoreAudio
import Darwin
import Foundation

// MARK: - Event reporting

let stdoutQueue = DispatchQueue(label: "app.cleanrecord.detector.stdout")

func emit(_ fields: [String: Any]) {
    stdoutQueue.sync {
        guard
            let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
            let line = String(data: data, encoding: .utf8)
        else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

// MARK: - CoreAudio reads

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

/// Every process CoreAudio currently knows about.
func processObjects() -> [AudioObjectID] {
    var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard
        AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &size) == noErr,
        size > 0
    else { return [] }

    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var objects = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
    guard AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &objects) == noErr else {
        return []
    }
    // The list can shrink between asking for its size and reading it.
    return Array(objects.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
}

func readUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = propertyAddress(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

func readPID(_ object: AudioObjectID) -> pid_t? {
    var address = propertyAddress(kAudioProcessPropertyPID)
    var pid: pid_t = -1
    var size = UInt32(MemoryLayout<pid_t>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid)
    return status == noErr ? pid : nil
}

/// Empty for a bare executable, which has no bundle.
func readBundleID(_ object: AudioObjectID) -> String {
    var address = propertyAddress(kAudioProcessPropertyBundleID)
    var bundleID: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &bundleID) { pointer in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, pointer)
    }
    return status == noErr ? bundleID as String : ""
}

// MARK: - Watcher

struct MicUser: Equatable {
    let pid: pid_t
    let bundleID: String
}

final class MicrophoneWatcher {
    private let queue = DispatchQueue(label: "app.cleanrecord.detector.watch")
    /// Process objects already carrying a listener, so none gets two.
    private var watched = Set<AudioObjectID>()
    private var lastReported: [MicUser]?
    private var pollTimer: DispatchSourceTimer?

    private lazy var listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        self?.refresh()
    }

    func start() {
        // Notifications otherwise go through the main thread's run loop, which
        // nothing runs here: the main thread is parked in dispatchMain(). A nil
        // run loop tells CoreAudio to use a thread of its own.
        var runLoopAddress = propertyAddress(kAudioHardwarePropertyRunLoop)
        var runLoop: CFRunLoop? = nil
        _ = AudioObjectSetPropertyData(
            systemObject, &runLoopAddress, 0, nil,
            UInt32(MemoryLayout<CFRunLoop?>.size), &runLoop
        )

        queue.sync {
            var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
            let status = AudioObjectAddPropertyListenerBlock(systemObject, &address, queue, listener)
            if status != noErr {
                // Not fatal: the poll below still notices every change, just
                // a little later.
                emit([
                    "type": "error",
                    "code": "listen_failed",
                    "message": "Could not listen for process changes",
                    "status": Int(status),
                ])
            }
        }

        emit(["type": "start"])
        queue.async { self.refresh() }

        // Listeners are the fast path. The poll is the safety net for a change
        // whose notification never arrives, and the way this helper notices its
        // parent has gone: it is re-parented to launchd, pid 1.
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            if getppid() == 1 { exit(0) }
            self?.refresh()
        }
        timer.resume()
        pollTimer = timer
    }

    /// Runs on `queue` only.
    private func refresh() {
        let objects = processObjects()
        var users: [MicUser] = []

        for object in objects {
            if !watched.contains(object) {
                var address = propertyAddress(kAudioProcessPropertyIsRunningInput)
                if AudioObjectAddPropertyListenerBlock(object, &address, queue, listener) == noErr {
                    watched.insert(object)
                }
            }
            guard (readUInt32(object, kAudioProcessPropertyIsRunningInput) ?? 0) != 0 else { continue }
            guard let pid = readPID(object) else { continue }
            users.append(MicUser(pid: pid, bundleID: readBundleID(object)))
        }

        // Objects for processes that have exited take their listeners with them.
        watched.formIntersection(objects)

        users.sort { $0.pid < $1.pid }
        if users == lastReported { return }
        lastReported = users
        emit([
            "type": "mic",
            "users": users.map { user -> [String: Any] in
                ["pid": Int(user.pid), "bundleId": user.bundleID]
            },
        ])
    }
}

// MARK: - Entry point

let watcher = MicrophoneWatcher()

let signalQueue = DispatchQueue(label: "app.cleanrecord.detector.signal")
var signalSources: [DispatchSourceSignal] = []

for signalNumber in [SIGINT, SIGTERM] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: signalQueue)
    source.setEventHandler {
        emit(["type": "stopped"])
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}

watcher.start()
dispatchMain()
