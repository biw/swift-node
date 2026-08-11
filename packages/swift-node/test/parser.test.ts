import { describe, it, expect } from 'vite-plus/test'
import {
  classifySwiftType,
  classifyNativeSwiftType,
  parseSwiftStructs,
  parseCallbackType,
  isCallbackType,
  isEscapingCallback,
  parseExportedFunctions,
  parseSwiftGlobalActorNames,
  parseSwiftCodableTypes,
  splitParams,
  bridgeTransportForType,
} from '../src/parser'

describe('classifySwiftType', () => {
  it('classifies primitive types', () => {
    expect(classifySwiftType('Int32')).toBe('int32')
    expect(classifySwiftType('Int')).toBe('int64')
    expect(classifySwiftType('Int64')).toBe('int64')
    expect(classifySwiftType('Double')).toBe('double')
    expect(classifySwiftType('Float')).toBe('double')
    expect(classifySwiftType('Bool')).toBe('bool')
  })

  it('classifies pointer types', () => {
    expect(classifySwiftType('UnsafePointer<CChar>')).toBe('string')
    expect(classifySwiftType('UnsafePointer<CChar>?')).toBe('string')
    expect(classifySwiftType('UnsafeMutablePointer<CChar>')).toBe('string')
    expect(classifySwiftType('UnsafeMutablePointer<CChar>?')).toBe('string')
    expect(classifySwiftType('UnsafePointer<UInt8>')).toBe('buffer')
    expect(classifySwiftType('UnsafePointer<Float>')).toBe('buffer')
  })

  it('classifies void', () => {
    expect(classifySwiftType('Void')).toBe('void')
    expect(classifySwiftType('()')).toBe('void')
  })

  it('classifies callback types', () => {
    expect(classifySwiftType('@convention(c) (UnsafePointer<CChar>) -> Void')).toBe('callback')
    expect(classifySwiftType('@escaping @convention(c) (UnsafePointer<CChar>) -> Void')).toBe(
      'callback',
    )
  })

  it('returns unknown for unrecognized types', () => {
    expect(classifySwiftType('MyCustomType')).toBe('unknown')
  })
})

describe('isCallbackType', () => {
  it('detects callback types', () => {
    expect(isCallbackType('@convention(c) (UnsafePointer<CChar>) -> Void')).toBe(true)
    expect(isCallbackType('@escaping @convention(c) (Int32, Double) -> Void')).toBe(true)
  })

  it('rejects non-callback types', () => {
    expect(isCallbackType('Int32')).toBe(false)
    expect(isCallbackType('UnsafePointer<CChar>')).toBe(false)
  })
})

describe('parseCallbackType', () => {
  it('parses single string param callback', () => {
    const cb = parseCallbackType('@escaping @convention(c) (UnsafePointer<CChar>) -> Void')
    expect(cb).not.toBeNull()
    expect(cb!.params).toHaveLength(1)
    expect(cb!.params[0].type).toBe('string')
    expect(cb!.returnType).toBe('Void')
  })

  it('parses multi-param callback (audio pattern)', () => {
    const cb = parseCallbackType('@convention(c) (UnsafePointer<Float>, Int32, Double) -> Void')
    expect(cb).not.toBeNull()
    expect(cb!.params).toHaveLength(3)
    expect(cb!.params[0].type).toBe('buffer')
    expect(cb!.params[1].type).toBe('int32')
    expect(cb!.params[2].type).toBe('double')
  })

  it('parses no-param callback', () => {
    const cb = parseCallbackType('@convention(c) () -> Void')
    expect(cb).not.toBeNull()
    expect(cb!.params).toHaveLength(0)
  })

  it('returns null for non-callback types', () => {
    expect(parseCallbackType('Int32')).toBeNull()
  })
})

describe('parseSwiftStructs', () => {
  it('parses a simple struct with numeric fields', () => {
    const source = `
public struct Point {
    public let x: Double
    public let y: Double
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(1)
    expect(structs[0].name).toBe('Point')
    expect(structs[0].fields).toEqual([
      { name: 'x', type: 'Double', category: 'double' },
      { name: 'y', type: 'Double', category: 'double' },
    ])
  })

  it('parses struct with mixed field types', () => {
    const source = `
public struct Config {
    public var name: UnsafePointer<CChar>
    public let count: Int32
    public let enabled: Bool
    public let rate: Double
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(1)
    expect(structs[0].fields).toHaveLength(4)
    expect(structs[0].fields[0].category).toBe('string')
    expect(structs[0].fields[1].category).toBe('int32')
    expect(structs[0].fields[2].category).toBe('bool')
    expect(structs[0].fields[3].category).toBe('double')
  })

  it('parses native String and Int fields', () => {
    const source = `
public struct User {
    public let id: Int
    public let name: String
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(1)
    expect(structs[0].fields).toEqual([
      { name: 'id', type: 'Int', category: 'int64' },
      { name: 'name', type: 'String', category: 'string' },
    ])
  })

  it('skips structs with unsupported fields', () => {
    const source = `
public struct Mixed {
    public let x: Double
    public let items: [String]
    public let y: Double
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(0)
  })

  it('skips structs with borrowed buffer fields', () => {
    const source = `
public struct Packet {
    public let bytes: UnsafeRawBufferPointer
}
`
    expect(parseSwiftStructs(source)).toHaveLength(0)
  })

  it('skips structs with private stored fields', () => {
    const source = `
public struct User {
    public let id: Int
    private let token: String
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(0)
  })

  it('ignores computed properties when parsing struct fields', () => {
    const source = `
public struct User {
    public let id: Int
    public let name: String
    public var displayName: String { name.uppercased() }
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(1)
    expect(structs[0].fields).toEqual([
      { name: 'id', type: 'Int', category: 'int64' },
      { name: 'name', type: 'String', category: 'string' },
    ])
  })

  it('skips private structs', () => {
    const source = `
struct PrivateStruct {
    let x: Double
}

public struct PublicStruct {
    public let x: Double
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(1)
    expect(structs[0].name).toBe('PublicStruct')
  })

  it('skips structs with no supported fields', () => {
    const source = `
public struct Empty {
    public let items: [String]
    public let optional: String?
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(0)
  })

  it('parses multiple structs', () => {
    const source = `
public struct Point {
    public let x: Double
    public let y: Double
}

public struct Size {
    public let width: Double
    public let height: Double
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(2)
    expect(structs[0].name).toBe('Point')
    expect(structs[1].name).toBe('Size')
  })

  it('handles struct with Codable conformance', () => {
    const source = `
public struct Event: Codable {
    public let timestamp: Double
    public let count: Int32
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(1)
    expect(structs[0].name).toBe('Event')
  })

  it('handles struct with multiple protocol conformances', () => {
    const source = `
public struct Event: Codable, Sendable {
    public let timestamp: Double
}
`
    const structs = parseSwiftStructs(source)
    expect(structs).toHaveLength(1)
    expect(structs[0].name).toBe('Event')
  })

  it('returns empty for source with no structs', () => {
    expect(parseSwiftStructs('import Foundation\n')).toHaveLength(0)
    expect(parseSwiftStructs('')).toHaveLength(0)
  })
})

// --- Export annotation tests ---

describe('classifyNativeSwiftType', () => {
  it('classifies Int as int64', () => {
    expect(classifyNativeSwiftType('Int')).toBe('int64')
  })

  it('classifies Int32 as int32', () => {
    expect(classifyNativeSwiftType('Int32')).toBe('int32')
  })

  it('classifies Int64 as int64', () => {
    expect(classifyNativeSwiftType('Int64')).toBe('int64')
  })

  it('classifies String types', () => {
    expect(classifyNativeSwiftType('String')).toBe('string')
    expect(classifyNativeSwiftType('String?')).toBe('string')
  })

  it('classifies Double and Float', () => {
    expect(classifyNativeSwiftType('Double')).toBe('double')
    expect(classifyNativeSwiftType('Float')).toBe('double')
  })

  it('classifies Bool', () => {
    expect(classifyNativeSwiftType('Bool')).toBe('bool')
  })

  it('classifies Void', () => {
    expect(classifyNativeSwiftType('Void')).toBe('void')
    expect(classifyNativeSwiftType('()')).toBe('void')
  })

  it('classifies @escaping closures as callback', () => {
    expect(classifyNativeSwiftType('@escaping (String) -> Void')).toBe('callback')
  })

  it('classifies Data and [UInt8] as buffer', () => {
    expect(classifyNativeSwiftType('Data')).toBe('buffer')
    expect(classifyNativeSwiftType('[UInt8]')).toBe('buffer')
  })

  it('classifies UnsafeRawBufferPointer as a borrowed buffer', () => {
    expect(classifyNativeSwiftType('UnsafeRawBufferPointer')).toBe('borrowed-buffer')
  })

  it('returns unknown for unsupported types', () => {
    expect(classifyNativeSwiftType('[String]')).toBe('unknown')
    expect(classifyNativeSwiftType('CustomType')).toBe('unknown')
  })
})

describe('bridgeTransportForType', () => {
  it.each([
    ['data', 'Data', []],
    ['data', '[UInt8]', []],
    ['borrowed', 'UnsafeRawBufferPointer', []],
    ['json', '[String?]', []],
    ['json', 'Int?', []],
    ['json', '[Data]', []],
    ['json', 'Box<String>', ['Box']],
    ['json', 'Array<Dictionary<String, Bool>>', []],
    ['json', '[String: Array<Int>]', []],
    ['json', 'Request', ['Request']],
  ])('uses %s transport for supported type %s', (transport, type, codableTypes) => {
    expect(bridgeTransportForType(type, codableTypes)).toBe(transport)
  })

  it.each(['[Int: String]', 'UnannotatedModel'])(
    'does not select a transport for unsupported type %s',
    (type) => {
      expect(bridgeTransportForType(type)).toBeNull()
    },
  )
})

describe('isEscapingCallback', () => {
  it('detects @escaping closures', () => {
    expect(isEscapingCallback('@escaping (String) -> Void')).toBe(true)
    expect(isEscapingCallback('@escaping (Int, Double) -> Void')).toBe(true)
  })

  it('does not match @convention(c) types', () => {
    expect(isEscapingCallback('@escaping @convention(c) (UnsafePointer<CChar>) -> Void')).toBe(
      false,
    )
  })

  it('does not match non-escaping types', () => {
    expect(isEscapingCallback('String')).toBe(false)
    expect(isEscapingCallback('Int')).toBe(false)
  })
})

describe('splitParams', () => {
  it('splits simple and generic parameter lists', () => {
    expect(splitParams('Int, String').map((s) => s.trim())).toEqual(['Int', 'String'])
    expect(splitParams('_ a: Dictionary<String, Int>, _ b: Int').map((s) => s.trim())).toEqual([
      '_ a: Dictionary<String, Int>',
      '_ b: Int',
    ])
  })

  it('does not treat a closure arrow as a bracket when a param follows it', () => {
    // The '>' in '->' must not unbalance the depth counter, or the trailing
    // parameter is swallowed into the closure type.
    expect(
      splitParams('_ onMsg: @escaping (String) -> Void, _ count: Int').map((s) => s.trim()),
    ).toEqual(['_ onMsg: @escaping (String) -> Void', '_ count: Int'])
  })
})

describe('parseExportedFunctions', () => {
  it('marks an AsyncStream export as a stream subscription', () => {
    const source = `
// @swift-node:export
// @swift-node:stream
func tokens(_ prompt: String) -> AsyncStream<String> {
  AsyncStream { $0.finish() }
}
`

    const [fn] = parseExportedFunctions(source)
    expect(fn.isStream).toBe(true)
    expect(fn.returnType).toBe('AsyncStream<String>')
  })
  it('parses a simple export function', () => {
    const source = `
// @swift-node:export
func greet(_ name: String) -> String {
    return "Hello, \\(name)!"
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].name).toBe('greet')
    expect(fns[0].params).toHaveLength(1)
    expect(fns[0].params[0].label).toBe('_')
    expect(fns[0].params[0].name).toBe('name')
    expect(fns[0].params[0].type).toBe('String')
    expect(fns[0].returnType).toBe('String')
    expect(fns[0].throws).toBe(false)
    expect(fns[0].isAsync).toBe(false)
  })

  it('parses a throwing function', () => {
    const source = `
// @swift-node:export
func divide(_ a: Double, _ b: Double) throws -> Double {
    guard b != 0 else { throw DivisionError.divideByZero }
    return a / b
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].name).toBe('divide')
    expect(fns[0].throws).toBe(true)
    expect(fns[0].returnType).toBe('Double')
    expect(fns[0].params).toHaveLength(2)
  })

  it('parses a source-level async export', () => {
    const source = `
// @swift-node:export
func processImage(_ data: String) async -> String {
    return "processed"
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].isAsync).toBe(true)
    expect(fns[0].name).toBe('processImage')
  })

  it('captures argument labels', () => {
    const source = `
// @swift-node:export
func set(key k: String, value v: String) -> Bool {
    return true
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].params[0].label).toBe('key')
    expect(fns[0].params[0].name).toBe('k')
    expect(fns[0].params[1].label).toBe('value')
    expect(fns[0].params[1].name).toBe('v')
  })

  it('parses void return function', () => {
    const source = `
// @swift-node:export
func stop() {
    running = false
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].returnType).toBe('Void')
    expect(fns[0].params).toHaveLength(0)
  })

  it('parses nullable return type', () => {
    const source = `
// @swift-node:export
func get(_ key: String) -> String? {
    return nil
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].returnType).toBe('String?')
  })

  it('skips attributes between annotation and func', () => {
    const source = `
// @swift-node:export
@available(macOS 10.15, *)
func newApi(_ x: Int) -> Int {
    return x
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].name).toBe('newApi')
  })

  it('records a global actor annotation for an exported function', () => {
    const source = `
// @swift-node:export
@MainActor
func updateTitle(_ title: String) -> String {
    title
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].actorIsolation).toBe('MainActor')
  })

  it('records a source-local custom global actor annotation for an exported function', () => {
    const source = `
actor Executor {}

@globalActor
public struct Database {
    static let shared = Executor()
}

// @swift-node:export
@Database
func read(_ key: String) -> String {
    key
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].actorIsolation).toBe('Database')
  })

  it('recognizes a custom global actor declared in another source file', () => {
    const actorsSource = `
actor Executor {}

@globalActor
struct Database {
    static let shared = Executor()
}
`
    const exportSource = `
// @swift-node:export
@Database
func read(_ key: String) -> String {
    key
}
`
    const fns = parseExportedFunctions(exportSource, parseSwiftGlobalActorNames(actorsSource))
    expect(fns).toHaveLength(1)
    expect(fns[0].actorIsolation).toBe('Database')
  })

  it('fails closed for qualified imported actors only on borrowed exports', () => {
    const borrowed = parseExportedFunctions(`
// @swift-node:export
@ActorLibrary.Database
func read(_ bytes: UnsafeRawBufferPointer) {}
`)
    const ordinary = parseExportedFunctions(`
// @swift-node:export
@Logged
func read(_ key: String) {}
`)

    expect(borrowed[0].actorIsolation).toBeUndefined()
    expect(borrowed[0].unrecognizedBorrowedAttributes).toEqual(['ActorLibrary.Database'])
    expect(ordinary[0].actorIsolation).toBeUndefined()
  })

  it('parses multiple exported functions', () => {
    const source = `
// @swift-node:export
func get(_ key: String) -> String? {
    return nil
}

// @swift-node:export
func set(_ key: String, _ value: String) -> Bool {
    return true
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(2)
    expect(fns[0].name).toBe('get')
    expect(fns[1].name).toBe('set')
  })

  it('parses function with public access modifier', () => {
    const source = `
// @swift-node:export
public func publicGet(_ key: String) -> String {
    return ""
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].name).toBe('publicGet')
  })

  it('ignores functions without an export annotation', () => {
    const source = `
public func existing(_ x: Int32) -> Int32 {
    return x
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(0)
  })

  it('handles empty source', () => {
    expect(parseExportedFunctions('')).toHaveLength(0)
  })

  it('handles annotation at end of file with no func', () => {
    const source = `
import Foundation
// @swift-node:export
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(0)
  })

  it('parses callback parameter', () => {
    const source = `
// @swift-node:export
func start(_ callback: @escaping (String) -> Void) {
    callback("hello")
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].params[0].type).toBe('@escaping (String) -> Void')
  })

  it('parses a callback that is not the last parameter', () => {
    const source = `
// @swift-node:export
func start(_ onMsg: @escaping (String) -> Void, _ count: Int) {
    onMsg("hello")
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].params).toEqual([
      { label: '_', name: 'onMsg', type: '@escaping (String) -> Void' },
      { label: '_', name: 'count', type: 'Int' },
    ])
  })

  it('parses a callback between two scalar parameters', () => {
    const source = `
// @swift-node:export
func watch(_ id: Int, _ onMsg: @escaping (String) -> Void, _ flag: Bool) {
    onMsg("hi")
}
`
    const fns = parseExportedFunctions(source)
    expect(fns[0].params.map((p) => p.name)).toEqual(['id', 'onMsg', 'flag'])
    expect(fns[0].params[1].type).toBe('@escaping (String) -> Void')
    expect(fns[0].params[2].type).toBe('Bool')
  })

  it('strips default parameter values', () => {
    const source = `
// @swift-node:export
func greet(_ name: String = "World") -> String {
    return "Hello, \\(name)!"
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].params[0].type).toBe('String')
  })

  it('records line numbers for error reporting', () => {
    const source = `import Foundation

// @swift-node:export
func foo() {
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].line).toBe(3) // 1-based, the annotation line
  })

  it('parses source-level async throws as a Promise export without a separate marker', () => {
    const source = `
// @swift-node:export
func respond(_ prompt: String) async throws -> String {
    prompt
}
`
    const fns = parseExportedFunctions(source)
    expect(fns).toHaveLength(1)
    expect(fns[0].isAsync).toBe(true)
    expect(fns[0].throws).toBe(true)
  })

  it('determines async behavior from the Swift function signature', () => {
    const source = `
// @swift-node:export
// This function deliberately has no async keyword.
func synchronousFunction() -> String {
  "sync"
}
`
    const [fn] = parseExportedFunctions(source)
    expect(fn.isAsync).toBe(false)
  })

  it('does not discover unannotated C ABI functions', () => {
    const source = `
@_cdecl("handwritten_greet")
public func handwrittenGreet(_ name: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar> {
  UnsafeMutablePointer(mutating: name)
}
`
    expect(parseExportedFunctions(source)).toEqual([])
  })
})

describe('parseSwiftCodableTypes', () => {
  it('only accepts explicitly annotated Codable declarations', () => {
    const source = `
// @swift-node:codable
public struct Request: Codable {
  let prompt: String
}

struct Incidental: Codable {}

// @swift-node:codable
enum Result: Codable { case ok }
`
    expect(parseSwiftCodableTypes(source)).toEqual([
      { name: 'Request', line: 2 },
      { name: 'Result', line: 9 },
    ])
  })

  it('recognizes annotated Codable classes with standard class modifiers', () => {
    const source = `
// @swift-node:codable
final class LocalRequest: Codable {
  let prompt: String
}

// @swift-node:codable
public final class PublicRequest: Codable {
  let prompt: String
}

// @swift-node:codable
open class OpenRequest: Codable {
  let prompt: String
}
`

    expect(parseSwiftCodableTypes(source)).toEqual([
      { name: 'LocalRequest', line: 2 },
      { name: 'PublicRequest', line: 7 },
      { name: 'OpenRequest', line: 12 },
    ])
  })

  it('accepts annotated Codable models with nested Data', () => {
    const source = `
// @swift-node:codable
struct Payload: Codable {
  let bytes: Data
}
`

    expect(parseSwiftCodableTypes(source)).toEqual([{ name: 'Payload', line: 2 }])
  })
})
