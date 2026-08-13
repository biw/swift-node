import Foundation

// A simple example demonstrating // @swift-node:export with callbacks.
// The tick function accepts a callback and calls it with a message.

private var timer: DispatchSourceTimer?
private let promiseCallbackLock = NSLock()
private var installedPromiseCallback: ((String) async throws -> String)?

// @swift-node:export
func installPromiseCallback(_ callback: @escaping (String) async throws -> String) {
    promiseCallbackLock.lock()
    installedPromiseCallback = callback
    promiseCallbackLock.unlock()
}

// @swift-node:export
func clearPromiseCallback() {
    promiseCallbackLock.lock()
    installedPromiseCallback = nil
    promiseCallbackLock.unlock()
}

// @swift-node:export
func invokeInstalledPromiseCallback(_ value: String, _ onResult: @escaping (String) -> Void) {
    promiseCallbackLock.lock()
    let callback = installedPromiseCallback
    promiseCallbackLock.unlock()

    Task {
        do {
            onResult(try await callback?(value) ?? "no callback")
        } catch {
            onResult("error:\(error.localizedDescription)")
        }
    }
}

// @swift-node:export
func tick(_ callback: @escaping (String) -> Void) {
    callback("tick at \(Date())")
}

// @swift-node:export
func add(_ a: Int, _ b: Int) -> Int {
    return a + b
}

// @swift-node:export
func greet(_ name: String) -> String {
    return "Hello, \(name)!"
}

// A callback that is NOT the last parameter — the surrounding args (id before,
// tag after) must still be passed through in the right positions.
// @swift-node:export
func report(_ id: Int, _ onMsg: @escaping (String) -> Void, _ tag: String) {
    onMsg("[\(tag)] id=\(id)")
}

// @swift-node:export
func reportMany(_ onMsg: @escaping (String, Int, String) -> Void) {
    onMsg("left", 42, "right")
}

// @swift-node:export
func reportMeasurement(_ onMeasurement: @escaping (Bool, Double) -> Void) {
    onMeasurement(true, 2.5)
}

// @swift-node:export
func reportOptional(_ present: Bool, _ onMsg: @escaping (String?) -> Void) {
    onMsg(present ? "value" : nil)
}

// @swift-node:export
func reportTag(_ tag: String?, _ onMsg: @escaping (String) -> Void) {
    onMsg(tag ?? "none")
}

enum StreamFailure: LocalizedError {
    case expected

    var errorDescription: String? {
        "expected stream failure"
    }
}

// Each call receives its own generated subscription and Task. The generated
// bridge cancels its consumer Task when JavaScript disposes the handle; the
// AsyncStream termination hook then cancels this producer Task too.
// @swift-node:export
// @swift-node:stream
func streamTicks(_ label: String, _ count: Int) -> AsyncStream<String> {
    AsyncStream { continuation in
        let task = Task {
            for index in 0..<count {
                guard !Task.isCancelled else { break }
                continuation.yield("\(label):\(index)")
                try? await Task.sleep(nanoseconds: 15_000_000)
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}

// @swift-node:export
// @swift-node:stream
func streamUntilCancelled(_ label: String) -> AsyncStream<String> {
    AsyncStream { continuation in
        let task = Task {
            var index = 0
            while !Task.isCancelled {
                continuation.yield("\(label):\(index)")
                index += 1
                try? await Task.sleep(nanoseconds: 15_000_000)
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}

// @swift-node:export
// @swift-node:stream
func streamFailure() -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            continuation.yield("before-error")
            try? await Task.sleep(nanoseconds: 15_000_000)
            guard !Task.isCancelled else {
                continuation.finish()
                return
            }
            continuation.finish(throwing: StreamFailure.expected)
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}
