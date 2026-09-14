// System-audio capture for macOS 14.2+ via a CoreAudio process tap.
//
// Emits raw 16 kHz mono signed 16-bit little-endian PCM on stdout and
// line-delimited JSON events on stderr. The host process (src/main/audioTapHost.ts)
// owns the lifecycle.
//
// Two deliberate choices, both from the teardown (see tasks/prd-meeting-notes.md):
//
//   * The tap is created with isMono + isMixdown, and AVAudioConverter resamples
//     straight to the app's canonical 16 kHz (FR-3). There is no 24 kHz
//     intermediate and therefore no hand-rolled downsampler to alias the
//     sibilance band.
//   * muteBehavior is .unmuted, so the user still hears the call normally.
//
// Build: swiftc -O -o meeting-audio-tap main.swift -framework AVFoundation -framework CoreAudio

import AVFoundation
import CoreAudio
import Darwin
import Foundation

// MARK: - Event reporting

let stderrQueue = DispatchQueue(label: "com.granola-alternative.tap.stderr")

func emit(_ fields: [String: Any]) {
    stderrQueue.sync {
        guard
            let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
            let line = String(data: data, encoding: .utf8)
        else { return }
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}

func fail(_ code: String, _ message: String, status: OSStatus? = nil) -> Never {
    var fields: [String: Any] = ["type": "error", "code": code, "message": message]
    if let status { fields["status"] = Int(status) }
    emit(fields)
    exit(1)
}

// MARK: - Configuration

struct Config {
    var sampleRate: Double = 16000
    var chunkMilliseconds: Int = 100
}

func parseArguments() -> Config {
    var config = Config()
    var args = Array(CommandLine.arguments.dropFirst())
    while let flag = args.first {
        args.removeFirst()
        switch flag {
        case "--sample-rate":
            if let raw = args.first, let value = Double(raw), value > 0 {
                config.sampleRate = value
                args.removeFirst()
            }
        case "--chunk-ms":
            if let raw = args.first, let value = Int(raw), value > 0 {
                config.chunkMilliseconds = value
                args.removeFirst()
            }
        default:
            break
        }
    }
    return config
}

// MARK: - Tap

final class SystemAudioTap {
    private let config: Config
    private let targetFormat: AVAudioFormat
    private let chunkBytes: Int
    private let ioQueue = DispatchQueue(label: "com.granola-alternative.tap.io")

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var carry = Data()
    private var stopping = false

    init(config: Config) {
        self.config = config
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: config.sampleRate,
                channels: 1,
                interleaved: true
            )
        else {
            fail("format_unavailable", "Could not build the 16 kHz mono output format")
        }
        self.targetFormat = format
        self.chunkBytes = max(2, Int(config.sampleRate * Double(config.chunkMilliseconds) / 1000.0) * 2)
    }

    func start() {
        let description = CATapDescription()
        description.name = "granola-alternative-system-audio"
        description.uuid = UUID()
        // Empty process list with isExclusive means "exclude nothing", i.e. tap
        // every process on every output device.
        description.processes = []
        description.isExclusive = true
        description.isMono = true
        description.isMixdown = true
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var newTapID = AudioObjectID(kAudioObjectUnknown)
        let createStatus = AudioHardwareCreateProcessTap(description, &newTapID)
        guard createStatus == noErr else {
            // The OS returns this when the user has not granted audio capture.
            let code = createStatus == kAudioHardwareIllegalOperationError
                ? "permission_denied" : "create_tap_failed"
            fail(code, "Could not create the system audio tap", status: createStatus)
        }
        tapID = newTapID

        let tapUID = readTapUID()
        createAggregateDevice(tapUID: tapUID)
        configureConverter()
        registerIOProc()

        let startStatus = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard startStatus == noErr else {
            fail("start_failed", "Could not start the aggregate device", status: startStatus)
        }

        emit([
            "type": "start",
            "sampleRate": Int(config.sampleRate),
            "channels": 1,
            "bitsPerChannel": 16,
        ])
    }

    func stop() {
        guard !stopping else { return }
        stopping = true

        if aggregateDeviceID != kAudioObjectUnknown, let ioProcID {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
        }
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }

        flushCarry(force: true)
    }

    // MARK: Setup helpers

    private func readTapUID() -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, pointer)
        }
        guard status == noErr else {
            fail("tap_uid_failed", "Could not read the tap UID", status: status)
        }
        return uid as String
    }

    private func createAggregateDevice(tapUID: String) {
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Granola Alternative Capture",
            kAudioAggregateDeviceUIDKey: "com.granola-alternative.tap.\(UUID().uuidString)",
            // No sub-devices: the aggregate exists only to host the tap, which
            // keeps it alive when the user switches output device.
            kAudioAggregateDeviceSubDeviceListKey: [],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID]],
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
        ]

        var deviceID = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &deviceID)
        guard status == noErr else {
            fail("create_device_failed", "Could not create the aggregate device", status: status)
        }
        aggregateDeviceID = deviceID
    }

    private func configureConverter() {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var streamDescription = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(
            aggregateDeviceID, &address, 0, nil, &size, &streamDescription
        )
        guard status == noErr, let source = AVAudioFormat(streamDescription: &streamDescription) else {
            fail("source_format_failed", "Could not read the tap's stream format", status: status)
        }
        guard let converter = AVAudioConverter(from: source, to: targetFormat) else {
            fail("converter_failed", "Could not build a converter to 16 kHz mono")
        }
        sourceFormat = source
        self.converter = converter
    }

    private func registerIOProc() {
        guard let sourceFormat, let converter else {
            fail("converter_missing", "Converter was not configured")
        }

        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(
            &procID, aggregateDeviceID, ioQueue
        ) { [weak self] _, inputData, _, _, _ in
            guard let self, !self.stopping else { return }
            self.handle(inputData, sourceFormat: sourceFormat, converter: converter)
        }
        guard status == noErr, let procID else {
            fail("ioproc_failed", "Could not register the IO proc", status: status)
        }
        ioProcID = procID
    }

    // MARK: Audio path

    private func handle(
        _ inputData: UnsafePointer<AudioBufferList>,
        sourceFormat: AVAudioFormat,
        converter: AVAudioConverter
    ) {
        let mutableList = UnsafeMutablePointer(mutating: inputData)
        guard
            let sourceBuffer = AVAudioPCMBuffer(
                pcmFormat: sourceFormat, bufferListNoCopy: mutableList, deallocator: nil
            )
        else { return }

        let sourceRate = max(sourceFormat.sampleRate, 1)
        let capacity = AVAudioFrameCount(
            ceil(Double(sourceBuffer.frameLength) * targetFormat.sampleRate / sourceRate)
        ) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            return
        }

        var provided = false
        var conversionError: NSError?
        converter.convert(to: output, error: &conversionError) { _, status in
            if provided {
                status.pointee = .noDataNow
                return nil
            }
            provided = true
            status.pointee = .haveData
            return sourceBuffer
        }

        if let conversionError {
            emit([
                "type": "error",
                "code": "convert_failed",
                "message": conversionError.localizedDescription,
            ])
            return
        }

        guard let channelData = output.int16ChannelData, output.frameLength > 0 else { return }
        let byteCount = Int(output.frameLength) * 2
        carry.append(Data(bytes: channelData[0], count: byteCount))
        flushCarry(force: false)
    }

    /// Write whole chunks so the host reads predictable frame counts.
    private func flushCarry(force: Bool) {
        while carry.count >= chunkBytes {
            let slice = carry.prefix(chunkBytes)
            carry.removeFirst(chunkBytes)
            FileHandle.standardOutput.write(slice)
        }
        if force, !carry.isEmpty {
            FileHandle.standardOutput.write(carry)
            carry.removeAll()
        }
    }
}

// MARK: - Entry point

let config = parseArguments()
let tap = SystemAudioTap(config: config)

var shouldRun = true
let signalQueue = DispatchQueue(label: "com.granola-alternative.tap.signal")

for signalNumber in [SIGINT, SIGTERM] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: signalQueue)
    source.setEventHandler {
        tap.stop()
        emit(["type": "stopped"])
        exit(0)
    }
    source.resume()
    // Keep the source alive for the process lifetime.
    withExtendedLifetime(source) {}
}

tap.start()

while shouldRun {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 1))
    if FileHandle.standardOutput.fileDescriptor < 0 { shouldRun = false }
}

tap.stop()
