// Production-style bridge regressions.
//
// Each case creates the same kind of standalone project a consumer would use,
// invokes the real swift-node CLI, then loads the generated addon.  These are
// intentionally not generator snapshots: a passing run proves the generated
// Swift and C++ compile, link, and carry values through Node-API.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, it } from 'vite-plus/test'
import { executableForPlatform, executionOptionsForPlatform } from './command.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(rootDir, 'packages', 'swift-node', 'bin', 'swift-node.js')
const tsgo = path.join(rootDir, 'node_modules', '.bin', 'tsgo')

function run(cmd, args, cwd) {
  execFileSync(executableForPlatform(cmd), args, {
    cwd,
    stdio: 'inherit',
    ...executionOptionsForPlatform(cmd),
  })
}

function runCase({ name, source, sources = {}, typeAssertion, assertion, postAssertion }) {
  const projectDir = mkdtempSync(path.join(tmpdir(), `swift-node-production-${name}-`))

  try {
    run(process.execPath, [cli, 'init', '.'], projectDir)
    writeFileSync(path.join(projectDir, 'src', 'native.swift'), source)
    for (const [filename, contents] of Object.entries(sources)) {
      writeFileSync(path.join(projectDir, 'src', filename), contents)
    }
    run(process.execPath, [cli, 'build'], projectDir)
    if (typeAssertion) {
      writeFileSync(path.join(projectDir, 'type-smoke.ts'), typeAssertion)
      run(
        tsgo,
        [
          '--module',
          'ESNext',
          '--moduleResolution',
          'Bundler',
          '--target',
          'ES2022',
          '--strict',
          '--noEmit',
          'type-smoke.ts',
        ],
        projectDir,
      )
    }
    const runtimeFailures = []
    try {
      run(process.execPath, ['--input-type=module', '-e', assertion], projectDir)
    } catch (error) {
      runtimeFailures.push(`runtime assertion: ${error.message}`)
    }
    if (postAssertion) {
      writeFileSync(path.join(projectDir, 'post-assertion.cjs'), postAssertion)
      try {
        run(process.execPath, ['--expose-gc', 'post-assertion.cjs'], projectDir)
      } catch (error) {
        runtimeFailures.push(`post-runtime assertion: ${error.message}`)
      }
    }
    if (runtimeFailures.length > 0) throw new Error(runtimeFailures.join('\n\n'))
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
}

function runMultipleAddonCase() {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'swift-node-production-multiple-addons-'))
  const firstProject = path.join(projectRoot, 'first')
  const secondProject = path.join(projectRoot, 'second')

  const createProject = (projectDir, packageName, prefix) => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
    )
    run(process.execPath, [cli, 'init', '.'], projectDir)
    writeFileSync(
      path.join(projectDir, 'src', 'native.swift'),
      `// @swift-node:export
func identify(_ value: String) -> String { "${prefix}:" + value }
`,
    )
    run(process.execPath, [cli, 'build'], projectDir)
  }

  try {
    // Scoped, hyphenated names exercise module-name sanitization while the
    // shared process proves independently generated symbols do not collide.
    createProject(firstProject, '@matrix/first-addon', 'first')
    createProject(secondProject, '@matrix/second-addon', 'second')
    const firstEntry = pathToFileURL(path.join(firstProject, 'dist_swift-node', 'index.mjs')).href
    const secondEntry = pathToFileURL(path.join(secondProject, 'dist_swift-node', 'index.mjs')).href
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const first = await import(${JSON.stringify(firstEntry)})
      const second = await import(${JSON.stringify(secondEntry)})
      if (first.identify('node') !== 'first:node') throw new Error('first addon returned the wrong value')
      if (second.identify('node') !== 'second:node') throw new Error('second addon returned the wrong value')
      if (first.identify('again') !== 'first:again') throw new Error('first addon changed after loading second addon')
    `,
      ],
      projectRoot,
    )
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

const cases = [
  {
    name: 'cpp-keyword-parameters',
    source: `// @swift-node:export
func measure(double: Double, float: Double, template: Double, namespace: Double, typename: Double) -> Double {
    double + float + template + namespace + typename
}
`,
    assertion: `
    const { measure } = await import('./dist_swift-node/index.mjs')
    if (measure(1.25, 2.5, 4, 8, 16) !== 31.75) {
      throw new Error('keyword-named parameters did not round-trip')
    }
  `,
  },
  {
    name: 'async-cpp-keyword-parameters',
    source: `// @swift-node:export
func measureLater(template: Double, namespace: Double) async -> Double {
    template + namespace
}
`,
    assertion: `
    const { measureLater } = await import('./dist_swift-node/index.mjs')
    if (await measureLater(1.25, 2.5) !== 3.75) {
      throw new Error('async keyword-named parameters did not round-trip')
    }
  `,
  },
  {
    name: 'float-struct-round-trip',
    source: `public struct FloatVector {
    public let x: Float
}

// @swift-node:export
func scaleVector(_ vector: FloatVector) -> FloatVector {
    FloatVector(x: vector.x * 2)
}
`,
    assertion: `
    const { scaleVector } = await import('./dist_swift-node/index.mjs')
    const result = scaleVector({ x: 1.25 })
    if (result.x !== 2.5) {
      throw new Error('Float struct input or return did not round-trip: ' + result.x)
    }
  `,
  },
  {
    name: 'cpp-keyword-struct-field',
    source: `public struct KeywordRecord {
    public let long: Int64
    public let template: Int32
    public let namespace: Double
}

// @swift-node:export
func echoRecord(_ value: KeywordRecord) -> KeywordRecord { value }
`,
    assertion: `
    const { echoRecord } = await import('./dist_swift-node/index.mjs')
    const result = echoRecord({ long: 4_000_000_000, template: 7, namespace: 1.5 })
    if (result.long !== 4_000_000_000 || result.template !== 7 || result.namespace !== 1.5) {
      throw new Error('keyword-named struct fields did not round-trip')
    }
  `,
  },
  {
    name: 'float-struct-return',
    source: `public struct FloatVector {
    public let x: Float
}

// @swift-node:export
func makeVector() -> FloatVector {
    FloatVector(x: 2.5)
}
`,
    assertion: `
    const { makeVector } = await import('./dist_swift-node/index.mjs')
    const result = makeVector()
    if (result.x !== 2.5) {
      throw new Error('Float struct return did not round-trip: ' + result.x)
    }
  `,
  },
  {
    // The Swift call deliberately returns before the callback runs. This requires
    // the generated Node-API threadsafe function to remain usable from a
    // background Swift queue, rather than only during the initial JS call.
    name: 'threadsafe-callback-lifetime',
    source: `import Foundation

// @swift-node:export
func notifyLater(_ value: Int, _ callback: @escaping (Int) -> Void) {
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(10)) {
        callback(value)
    }
}
`,
    assertion: `
    const { notifyLater } = await import('./dist_swift-node/index.mjs')
    const seen = []
    await Promise.race([
      new Promise(resolve => {
        notifyLater(1, value => {
          seen.push(value)
          if (seen.length === 2) resolve()
        })
        notifyLater(2, value => {
          seen.push(value)
          if (seen.length === 2) resolve()
        })
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('background Swift callbacks timed out')), 1_000)),
    ])
    if (seen.sort((left, right) => left - right).join(',') !== '1,2') {
      throw new Error('background Swift callbacks did not each deliver their value: ' + JSON.stringify(seen))
    }
  `,
  },
  {
    name: 'borrowed-buffer-input',
    source: `// @swift-node:export
func describeBytes(_ bytes: UnsafeRawBufferPointer) -> String {
    let values = bytes.bindMemory(to: UInt8.self)
    return "\\(bytes.count):" + values.map { String($0) }.joined(separator: ",")
}

// @swift-node:export
func byteLength(_ bytes: UnsafeRawBufferPointer) -> Int {
    bytes.count
}
`,
    typeAssertion: `import { byteLength, describeBytes } from './dist_swift-node/index.mjs'

const input: Uint8Array = new Uint8Array([1, 2, 3])
const length: number = byteLength(input)
const summary: string = describeBytes(input)
void length
void summary
`,
    assertion: `
    const { byteLength, describeBytes } = await import('./dist_swift-node/index.mjs')
    const bufferSlice = Buffer.from([99, 10, 20, 30, 77]).subarray(1, 4)
    if (describeBytes(bufferSlice) !== '3:10,20,30') {
      throw new Error('Buffer slice did not preserve byte offset and length')
    }
    const typedArraySlice = new Uint8Array([88, 4, 5, 66]).subarray(1, 3)
    if (describeBytes(typedArraySlice) !== '2:4,5') {
      throw new Error('Uint8Array slice did not preserve byte offset and length')
    }
    if (byteLength(Buffer.alloc(0)) !== 0) {
      throw new Error('empty Buffer did not reach Swift as a zero-length view')
    }
    for (const invalid of [{}, [1, 2], new Uint16Array([1])]) {
      let threw = false
      try { byteLength(invalid) } catch { threw = true }
      if (!threw) throw new Error('borrowed input accepted an invalid binary value: ' + invalid.constructor.name)
    }
  `,
  },
  {
    // This is a standalone consumer project, not a generator unit fixture. It
    // covers every documented transport and execution mode that currently has a
    // successful build path. The dedicated Float cases above cover the one raw
    // ABI struct variant that currently cannot compile.
    name: 'supported-type-matrix',
    source: `import Foundation

public struct ScalarRecord {
    public let count: Int
    public let compact: Int32
    public let large: Int64
    public let ratio: Double
    public let enabled: Bool
    public let label: String
}

// @swift-node:codable
struct BinaryPayload: Codable {
    let bytes: Data
}

// @swift-node:codable
struct Box<T: Codable>: Codable {
    let value: T
}

// @swift-node:codable
enum DeliverySpeed: String, Codable {
    case economy
    case express
}

// @swift-node:codable
final class Parcel: Codable {
    let id: String
    let speed: DeliverySpeed
    let payload: BinaryPayload

    init(id: String, speed: DeliverySpeed, payload: BinaryPayload) {
        self.id = id
        self.speed = speed
        self.payload = payload
    }
}

enum MatrixFailure: LocalizedError {
    case expected

    var errorDescription: String? { "matrix failure" }
}

// @swift-node:export
func echoString(_ value: String) -> String { value }

// @swift-node:export
func echoInt(_ value: Int) -> Int { value }

// @swift-node:export
func echoInt32(_ value: Int32) -> Int32 { value }

// @swift-node:export
func echoInt64(_ value: Int64) -> Int64 { value }

// @swift-node:export
func echoDouble(_ value: Double) -> Double { value }

// @swift-node:export
func echoFloat(_ value: Float) -> Float { value }

// @swift-node:export
func echoBool(_ value: Bool) -> Bool { value }

// @swift-node:export
func mark() {}

// @swift-node:export
func failMark() throws { throw MatrixFailure.expected }

// @swift-node:export
func echoOptionalString(_ value: String?) -> String? { value }

// @swift-node:export
func echoOptionalInt(_ value: Int?) -> Int? { value }

// @swift-node:export
func echoOptionalInt32(_ value: Int32?) -> Int32? { value }

// @swift-node:export
func echoOptionalInt64(_ value: Int64?) -> Int64? { value }

// @swift-node:export
func echoOptionalDouble(_ value: Double?) -> Double? { value }

// @swift-node:export
func echoOptionalFloat(_ value: Float?) -> Float? { value }

// @swift-node:export
func echoOptionalBool(_ value: Bool?) -> Bool? { value }

// @swift-node:export
func reverseData(_ value: Data) -> Data { Data(value.reversed()) }

// @swift-node:export
func reverseBytes(_ value: [UInt8]) -> [UInt8] { value.reversed() }

// @swift-node:export
func reverseOptionalData(_ value: Data?) -> Data? { value.map { Data($0.reversed()) } }

// @swift-node:export
func echoItems(_ value: [String?]) -> [String?] { value }

// @swift-node:export
func echoGenericItems(_ value: Array<Int32>) -> Array<Int32> { value }

// @swift-node:export
func echoCounts(_ value: [String: Double]) -> [String: Double] { value }

// @swift-node:export
func echoGenericCounts(_ value: Dictionary<String, Bool>) -> Dictionary<String, Bool> { value }

// @swift-node:export
func echoRecord(_ value: ScalarRecord) -> ScalarRecord { value }

// @swift-node:export
func echoPayload(_ value: BinaryPayload) -> BinaryPayload { value }

// @swift-node:export
func echoBox(_ value: Box<Int>?) -> Box<Int>? { value }

// @swift-node:export
func echoParcel(_ value: Parcel) -> Parcel { value }

// @swift-node:export
func divide(_ numerator: Double, _ denominator: Double) throws -> Double {
    guard denominator != 0 else { throw MatrixFailure.expected }
    return numerator / denominator
}

// @swift-node:export
func asyncString(_ value: String) async -> String { value.uppercased() }

// @swift-node:export
func asyncOptionalDouble(_ value: Double?) async -> Double? { value.map { $0 * 2 } }

// @swift-node:export
func asyncData(_ value: Data) async -> Data { Data(value.reversed()) }

// @swift-node:export
func asyncBox(_ value: Box<Int>) async throws -> Box<Int> {
    guard value.value >= 0 else { throw MatrixFailure.expected }
    return Box(value: value.value + 1)
}

// @swift-node:export
@MainActor
func mainActorEcho(_ value: String) -> String { "main-" + value }

@globalActor
actor MatrixActor {
    static let shared = MatrixActor()
}

// @swift-node:export
@MatrixActor
func globalActorEcho(_ value: String) -> String { "global-" + value }

// @swift-node:export
func notify(_ label: String?, _ callback: @escaping (String?, Int, Bool, Double) -> Void) {
    callback(label, -7, true, 2.5)
}

private func oneValueStream<T>(_ value: T) -> AsyncStream<T> {
    AsyncStream { continuation in
        continuation.yield(value)
        continuation.finish()
    }
}

// @swift-node:export
// @swift-node:stream
func floatStream() -> AsyncStream<Float> { oneValueStream(1.25) }

// @swift-node:export
// @swift-node:stream
func eventStream() -> AsyncStream<BinaryPayload> {
    oneValueStream(BinaryPayload(bytes: Data([1, 2])))
}

// @swift-node:export
// @swift-node:stream
func failingStream() -> AsyncThrowingStream<BinaryPayload, Error> {
    AsyncThrowingStream { continuation in
        continuation.yield(BinaryPayload(bytes: Data([3])))
        continuation.finish(throwing: MatrixFailure.expected)
    }
}

// @swift-node:export
// @swift-node:stream
func delayedStream() -> AsyncStream<String> {
    AsyncStream { continuation in
        let task = Task {
            try? await Task.sleep(nanoseconds: 30_000_000)
            guard !Task.isCancelled else { return }
            continuation.yield("late")
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}

// @swift-node:export
// @swift-node:stream
func stringStream(_ value: String) -> AsyncStream<String> { oneValueStream(value) }

// @swift-node:export
// @swift-node:stream
func endlessStream() -> AsyncStream<Int> {
    AsyncStream { continuation in
        let task = Task {
            var value = 0
            while !Task.isCancelled {
                continuation.yield(value)
                value += 1
                try? await Task.sleep(nanoseconds: 15_000_000)
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}
`,
    sources: {
      'cross-file.swift': `import Foundation

// @swift-node:codable
struct CrossFileEnvelope: Codable {
    let id: Int
    let payload: Box<Int>?
}

// @swift-node:export
func echoCrossFileEnvelope(_ value: CrossFileEnvelope) -> CrossFileEnvelope { value }
`,
    },
    typeAssertion: `import {
  asyncBox,
  asyncData,
  asyncOptionalDouble,
  asyncString,
  echoBool,
  echoCounts,
  echoDouble,
  echoFloat,
  echoGenericCounts,
  echoGenericItems,
  echoInt,
  echoInt32,
  echoInt64,
  echoItems,
  echoOptionalBool,
  echoOptionalDouble,
  echoOptionalFloat,
  echoOptionalInt,
  echoOptionalInt32,
  echoOptionalInt64,
  echoOptionalString,
  echoRecord,
  echoString,
  eventStream,
  failMark,
  floatStream,
  globalActorEcho,
  mainActorEcho,
  mark,
  notify,
  reverseBytes,
  reverseData,
  stringStream,
  type ScalarRecord,
  type SwiftNodeSubscription,
} from './dist_swift-node/index.mjs'

const string: string = echoString('value')
const integer: number = echoInt(1)
const int32: number = echoInt32(1)
const int64: number = echoInt64(1)
const double: number = echoDouble(1)
const float: number = echoFloat(1)
const boolean: boolean = echoBool(true)
const nothing: void = mark()
const rejectedNothing: void = failMark()
const optionalString: string | null = echoOptionalString(null)
const optionalInt: number | null = echoOptionalInt(null)
const optionalInt32: number | null = echoOptionalInt32(null)
const optionalInt64: number | null = echoOptionalInt64(null)
const optionalDouble: number | null = echoOptionalDouble(null)
const optionalFloat: number | null = echoOptionalFloat(null)
const optionalBool: boolean | null = echoOptionalBool(null)
const bytes: Uint8Array = reverseData(new Uint8Array())
const byteArray: Uint8Array = reverseBytes(new Uint8Array())
const items: (string | null)[] = echoItems(['value', null])
const genericItems: number[] = echoGenericItems([1])
const counts: Record<string, number> = echoCounts({ one: 1 })
const genericCounts: Record<string, boolean> = echoGenericCounts({ enabled: true })
const record: ScalarRecord = echoRecord({ count: 1, compact: 1, large: 1, ratio: 1, enabled: true, label: 'record' })
const promiseString: Promise<string> = asyncString('value')
const promiseOptional: Promise<number | null> = asyncOptionalDouble(null)
const promiseBytes: Promise<Uint8Array> = asyncData(new Uint8Array())
const promiseCodable: Promise<unknown> = asyncBox({ value: 1 })
const mainActor: string = mainActorEcho('value')
const globalActor: Promise<string> = globalActorEcho('value')
const callbackResult: void = notify(null, (label: string | null, count: number, enabled: boolean, ratio: number) => {
  void label; void count; void enabled; void ratio
})
const scalarSubscription: SwiftNodeSubscription = floatStream((value: number) => { void value })
const structuredSubscription: SwiftNodeSubscription = eventStream((value: unknown) => { void value })
const stringSubscription: SwiftNodeSubscription = stringStream('value', (value: string) => { void value })

void string; void integer; void int32; void int64; void double; void float; void boolean; void nothing; void rejectedNothing
void optionalString; void optionalInt; void optionalInt32; void optionalInt64; void optionalDouble; void optionalFloat; void optionalBool
void bytes; void byteArray; void items; void genericItems; void counts; void genericCounts; void record
void promiseString; void promiseOptional; void promiseBytes; void promiseCodable; void mainActor; void globalActor
void callbackResult; void scalarSubscription; void structuredSubscription; void stringSubscription
`,
    assertion: `
    import { isDeepStrictEqual } from 'node:util'
    const addon = await import('./dist_swift-node/index.mjs')
    const failures = []
    const same = (label, actual, expected) => {
      if (!isDeepStrictEqual(actual, expected)) {
        failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
      }
    }
    const check = (label, condition) => {
      if (!condition) failures.push(label + ': assertion failed')
    }
    const throws = (label, operation, expectedMessage) => {
      try {
        operation()
        failures.push(label + ': expected an exception')
      } catch (error) {
        if (expectedMessage && !String(error.message).includes(expectedMessage)) {
          failures.push(label + ': unexpected error ' + error.message)
        }
      }
    }
    const within = (label, promise) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), 1_000)),
    ])
    const collect = subscribe => new Promise((resolve, reject) => {
      const values = []
      subscribe(value => values.push(value), reject, () => resolve(values))
    })

    same('String', addon.echoString('a\\0b'), 'a\\0b')
    same('Int', addon.echoInt(4_000_000_000), 4_000_000_000)
    same('Int32', addon.echoInt32(-2_147_483_648), -2_147_483_648)
    same('Int64', addon.echoInt64(4_000_000_000), 4_000_000_000)
    same('Double', addon.echoDouble(1.25), 1.25)
    same('Float', addon.echoFloat(1.25), 1.25)
    same('Bool', addon.echoBool(true), true)
    check('Double negative zero', Object.is(addon.echoDouble(-0), -0))
    check('Float negative zero', Object.is(addon.echoFloat(-0), -0))
    check('Double NaN', Number.isNaN(addon.echoDouble(NaN)))
    check('Float NaN', Number.isNaN(addon.echoFloat(NaN)))
    same('Double infinity', addon.echoDouble(Infinity), Infinity)
    same('Float negative infinity', addon.echoFloat(-Infinity), -Infinity)
    same('safe Int64 maximum', addon.echoInt64(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
    same('safe Int64 minimum', addon.echoInt64(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER)
    throws('unsafe Int', () => addon.echoInt(Number.MAX_SAFE_INTEGER + 1))
    throws('unsafe Int64', () => addon.echoInt64(Number.MAX_SAFE_INTEGER + 1))
    for (const invalidInteger of [1.5, NaN, Infinity, -Infinity]) {
      throws('invalid Int ' + String(invalidInteger), () => addon.echoInt(invalidInteger))
      throws('invalid Int32 ' + String(invalidInteger), () => addon.echoInt32(invalidInteger))
      throws('invalid Int64 ' + String(invalidInteger), () => addon.echoInt64(invalidInteger))
    }
    same('Void', addon.mark(), undefined)
    throws('throws Void', () => addon.failMark(), 'matrix failure')

    same('optional String value', addon.echoOptionalString('optional'), 'optional')
    same('optional String null', addon.echoOptionalString(null), null)
    same('optional Int value', addon.echoOptionalInt(3), 3)
    same('optional Int null', addon.echoOptionalInt(null), null)
    throws('optional unsafe Int', () => addon.echoOptionalInt(Number.MAX_SAFE_INTEGER + 1))
    same('optional Int32 value', addon.echoOptionalInt32(-7), -7)
    same('optional Int32 null', addon.echoOptionalInt32(null), null)
    same('optional Int64 value', addon.echoOptionalInt64(4_000_000_000), 4_000_000_000)
    same('optional Int64 null', addon.echoOptionalInt64(null), null)
    throws('optional unsafe Int64', () => addon.echoOptionalInt64(Number.MAX_SAFE_INTEGER + 1))
    for (const invalidInteger of [1.5, NaN, Infinity, -Infinity]) {
      throws('invalid optional Int ' + String(invalidInteger), () => addon.echoOptionalInt(invalidInteger))
      throws('invalid optional Int32 ' + String(invalidInteger), () => addon.echoOptionalInt32(invalidInteger))
      throws('invalid optional Int64 ' + String(invalidInteger), () => addon.echoOptionalInt64(invalidInteger))
    }
    same('optional Double value', addon.echoOptionalDouble(1.5), 1.5)
    same('optional Double null', addon.echoOptionalDouble(null), null)
    same('optional Float value', addon.echoOptionalFloat(1.5), 1.5)
    same('optional Float null', addon.echoOptionalFloat(null), null)
    for (const nonFinite of [NaN, Infinity, -Infinity]) {
      throws('invalid optional Double ' + String(nonFinite), () => addon.echoOptionalDouble(nonFinite))
      throws('invalid optional Float ' + String(nonFinite), () => addon.echoOptionalFloat(nonFinite))
    }
    same('optional Bool value', addon.echoOptionalBool(false), false)
    same('optional Bool null', addon.echoOptionalBool(null), null)

    same('Unicode String', addon.echoString('Swi🧪ft 日本語'), 'Swi🧪ft 日本語')
    throws('BigInt scalar input', () => addon.echoInt64(1n))
    throws('undefined JSON input', () => addon.echoItems(undefined))
    const cyclic = {}; cyclic.self = cyclic
    throws('cyclic JSON input', () => addon.echoCounts(cyclic))

    same('Data Buffer input', addon.reverseData(Buffer.from([1, 2, 3])), Buffer.from([3, 2, 1]))
    same('Data Uint8Array view input', addon.reverseData(new Uint8Array([99, 4, 5, 99]).subarray(1, 3)), Buffer.from([5, 4]))
    const detachedBuffer = new ArrayBuffer(2)
    const detachedView = new Uint8Array(detachedBuffer)
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] })
    try { addon.reverseData(detachedView) } catch {}
    same('binary bridge remains healthy after detached view', addon.reverseData(new Uint8Array([6])), Buffer.from([6]))
    same('[UInt8]', addon.reverseBytes(new Uint8Array([7, 8])), Buffer.from([8, 7]))
    same('optional Data', addon.reverseOptionalData('AQID'), 'AwIB')
    same('optional Data null', addon.reverseOptionalData(null), null)
    throws('optional Data malformed base64', () => addon.reverseOptionalData('not-base64'), 'encode or decode')

    same('array shorthand', addon.echoItems(['swift', null]), ['swift', null])
    same('Array spelling', addon.echoGenericItems([1, -2]), [1, -2])
    same('dictionary shorthand', addon.echoCounts({ one: 1.5 }), { one: 1.5 })
    same('Dictionary spelling', addon.echoGenericCounts({ enabled: true }), { enabled: true })
    same('raw ABI struct', addon.echoRecord({ count: 7, compact: -3, large: 4_000_000_000, ratio: 1.5, enabled: true, label: 'record' }), { count: 7, compact: -3, large: 4_000_000_000, ratio: 1.5, enabled: true, label: 'record' })
    same('raw ABI struct embedded NUL String', addon.echoRecord({ count: 8, compact: -4, large: 5_000_000_000, ratio: 2.5, enabled: false, label: 'a\\0b' }), { count: 8, compact: -4, large: 5_000_000_000, ratio: 2.5, enabled: false, label: 'a\\0b' })
    throws('unsafe Int raw ABI struct field', () => addon.echoRecord({ count: Number.MAX_SAFE_INTEGER + 1, compact: 0, large: 0, ratio: 0, enabled: false, label: 'unsafe-int' }))
    throws('unsafe Int64 raw ABI struct field', () => addon.echoRecord({ count: 0, compact: 0, large: Number.MAX_SAFE_INTEGER + 1, ratio: 0, enabled: false, label: 'unsafe-int64' }))
    throws('fractional Int32 raw ABI struct field', () => addon.echoRecord({ count: 0, compact: 1.5, large: 0, ratio: 0, enabled: false, label: 'fractional-int32' }))

    same('Codable nested Data', addon.echoPayload({ bytes: 'AQI=' }), { bytes: 'AQI=' })
    same('optional generic Codable', addon.echoBox({ value: 9 }), { value: 9 })
    same('optional generic Codable null', addon.echoBox(null), null)
    same('Codable class and enum', addon.echoParcel({ id: 'parcel', speed: 'express', payload: { bytes: 'Aw==' } }), { id: 'parcel', speed: 'express', payload: { bytes: 'Aw==' } })
    same('cross-file Codable', addon.echoCrossFileEnvelope({ id: 2, payload: { value: 8 } }), { id: 2, payload: { value: 8 } })
    same('cross-file Codable null', addon.echoCrossFileEnvelope({ id: 3, payload: null }), { id: 3 })
    throws('throws', () => addon.divide(1, 0), 'matrix failure')

    same('async String', await addon.asyncString('promise'), 'PROMISE')
    same('async embedded NUL String', await addon.asyncString('a\\0b'), 'A\\0B')
    same('async optional scalar', await addon.asyncOptionalDouble(1.5), 3)
    same('async optional scalar null', await addon.asyncOptionalDouble(null), null)
    throws('invalid async optional Double', () => addon.asyncOptionalDouble(NaN))
    same('async Data', await addon.asyncData(new Uint8Array([9, 10])), Buffer.from([10, 9]))
    same('async Codable', await addon.asyncBox({ value: 4 }), { value: 5 })
    try {
      await addon.asyncBox({ value: -1 })
      failures.push('async throws: expected a rejected Promise')
    } catch (error) {
      if (!String(error.message).includes('matrix failure')) failures.push('async throws: unexpected error ' + error.message)
    }

    same('MainActor', addon.mainActorEcho('node'), 'main-node')
    same('global actor', await addon.globalActorEcho('node'), 'global-node')
    same('callback', await within('callback', new Promise(resolve => addon.notify(null, (...values) => resolve(values)))), [null, -7, true, 2.5])
    same('callback embedded NUL String', await within('callback embedded NUL String', new Promise(resolve => addon.notify('a\\0b', (...values) => resolve(values)))), ['a\\0b', -7, true, 2.5])
    same('callback reentrancy', await within('callback reentrancy', new Promise(resolve => addon.notify('again', () => resolve(addon.echoInt(41))))), 41)
    same('scalar stream', await within('scalar stream', collect(addon.floatStream)), [1.25])
    same('stream embedded NUL String input and output', await within('stream embedded NUL String input and output', new Promise((resolve, reject) => {
      const values = []
      addon.stringStream('a\\0b', value => values.push(value), reject, () => resolve(values))
    })), ['a\\0b'])
    same('structured stream', await within('structured stream', collect(addon.eventStream)), [{ bytes: 'AQI=' }])
    const failing = await within('throwing stream', new Promise(resolve => {
      const values = []
      addon.failingStream(value => values.push(value), error => resolve({ values, error: error.message }), () => resolve({ values, error: null }))
    }))
    same('throwing structured stream', failing, { values: [{ bytes: 'Aw==' }], error: 'matrix failure' })
    const delayedValues = []
    const delayed = addon.delayedStream(value => delayedValues.push(value))
    delayed.cancel()
    await new Promise(resolve => setTimeout(resolve, 60))
    same('cancelled delayed stream values', delayedValues, [])
    same('cancelled delayed stream closed', delayed.closed, true)

    if (failures.length > 0) throw new Error(failures.join('\\n'))
  `,
    postAssertion: `const addon = require('./dist_swift-node/index.cjs')

let callbackRan = false
let streamEvents = 0
addon.notify('throw', () => {
  callbackRan = true
  throw new Error('callback failure')
})
addon.endlessStream(() => { streamEvents += 1 })
global.gc()
setTimeout(() => {
  if (!callbackRan) {
    console.error('callback exception test did not invoke the callback')
    process.exit(1)
  }
  if (addon.echoInt(42) !== 42) {
    console.error('addon was unhealthy after a callback exception')
    process.exit(1)
  }
  if (streamEvents > 1) {
    console.error('garbage-collected stream subscription remained active:', streamEvents)
    process.exit(1)
  }
  process.exit(0)
}, 50)
`,
  },
]

const selectedCase = process.env.SWIFT_NODE_PRODUCTION_CASE
const selectedCases = selectedCase
  ? cases.filter((testCase) => testCase.name === selectedCase)
  : cases
if (selectedCase && selectedCases.length === 0) {
  throw new Error(`Unknown production bridge case: ${selectedCase}`)
}

describe.sequential('production bridge', () => {
  beforeAll(() => run('vp', ['-C', 'packages/swift-node', 'pack'], rootDir), 180_000)

  for (const testCase of selectedCases) {
    it(testCase.name, () => runCase(testCase), 180_000)
  }

  if (!selectedCase) {
    it('loads multiple independently generated addons', () => runMultipleAddonCase(), 180_000)
  }
})
