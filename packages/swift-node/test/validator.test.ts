import { describe, it, expect } from 'vite-plus/test'
import { validateExports } from '../src/validator'
import {
  parseExportedFunctions,
  parseSwiftCodableTypes,
  parseSwiftGlobalActorNames,
} from '../src/parser'
import type { ExportedFunction, SwiftStruct } from '../src/parser'

const makeExported = (overrides: Partial<ExportedFunction> = {}): ExportedFunction => ({
  name: 'testFunc',
  params: [],
  returnType: 'Void',
  throws: false,
  isAsync: false,
  line: 1,
  ...overrides,
})

const profileWithString: SwiftStruct = {
  name: 'Profile',
  fields: [{ name: 'name', type: 'String', category: 'string' }],
}

const pointWithoutString: SwiftStruct = {
  name: 'Point',
  fields: [{ name: 'x', type: 'Double', category: 'double' }],
}

describe('validateExports', () => {
  describe('stream exports', () => {
    it('accepts standard AsyncStream scalar elements', () => {
      const fn = makeExported({
        isStream: true,
        returnType: 'AsyncThrowingStream<String, Error>',
      })
      expect(
        validateExports(
          [fn],
          '// @swift-node:export\n// @swift-node:stream\nfunc testFunc() -> AsyncThrowingStream<String, Error> { fatalError() }',
        ),
      ).toHaveLength(0)
    })

    it('accepts explicitly annotated structured stream elements', () => {
      const fn = makeExported({
        isStream: true,
        returnType: 'AsyncStream<ModelEvent>',
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\n// @swift-node:stream\nfunc testFunc() -> AsyncStream<ModelEvent> { fatalError() }',
        [],
        ['ModelEvent'],
      )
      expect(errors).toHaveLength(0)
    })

    it('rejects callbacks in a stream source signature', () => {
      const fn = makeExported({
        isStream: true,
        params: [{ label: '_', name: 'callback', type: '@escaping (String) -> Void' }],
        returnType: 'AsyncStream<String>',
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\n// @swift-node:stream\nfunc testFunc(_ callback: @escaping (String) -> Void) -> AsyncStream<String> { fatalError() }',
      )
      expect(errors.some((error) => error.message.includes('cannot declare callback'))).toBe(true)
    })
  })
  describe('unsupported types', () => {
    it('accepts JSON-safe array parameters', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'items', type: '[String]' }],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc testFunc(_ items: [String]) {\n}',
      )
      expect(errors).toHaveLength(0)
    })

    it('accepts JSON-safe dictionary parameters', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'data', type: 'Dictionary<String, Int>' }],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc testFunc(_ data: Dictionary<String, Int>) {\n}',
      )
      expect(errors).toHaveLength(0)
    })

    it('accepts JSON-safe shorthand dictionary parameters', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'data', type: '[String: Int]' }],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc testFunc(_ data: [String: Int]) {\n}',
      )
      expect(errors).toHaveLength(0)
    })

    it('accepts JSON-safe array return types', () => {
      const fn = makeExported({ returnType: '[String]' })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc testFunc() -> [String] {\n}',
      )
      expect(errors).toHaveLength(0)
    })

    it('accepts all supported types', () => {
      const fn = makeExported({
        params: [
          { label: '_', name: 'a', type: 'String' },
          { label: '_', name: 'b', type: 'Int' },
          { label: '_', name: 'c', type: 'Double' },
          { label: '_', name: 'd', type: 'Bool' },
        ],
        returnType: 'String?',
      })
      const source =
        '// @swift-node:export\nfunc testFunc(_ a: String, _ b: Int, _ c: Double, _ d: Bool) -> String? {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)
    })

    it('accepts optional scalar parameters', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'count', type: 'Int?' }],
      })
      const source = '// @swift-node:export\nfunc testFunc(_ count: Int?) {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)
    })

    it('accepts optional scalar return types', () => {
      const fn = makeExported({ returnType: 'Bool?' })
      const source = '// @swift-node:export\nfunc testFunc() -> Bool? {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)
    })

    it('accepts known public struct types', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'point', type: 'Point' }],
        returnType: 'Point',
      })
      const source = '// @swift-node:export\nfunc testFunc(_ point: Point) -> Point {\n}'
      const errors = validateExports([fn], source, ['Point'])
      expect(errors).toHaveLength(0)
    })

    it('accepts top-level Data and [UInt8]', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'data', type: 'Data' }],
        returnType: 'Data',
      })
      const source = '// @swift-node:export\nfunc testFunc(_ data: Data) -> Data {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)

      const byteFn = makeExported({
        params: [{ label: '_', name: 'bytes', type: '[UInt8]' }],
        returnType: '[UInt8]',
      })
      expect(
        validateExports(
          [byteFn],
          '// @swift-node:export\nfunc testFunc(_ bytes: [UInt8]) -> [UInt8] { bytes }',
        ),
      ).toHaveLength(0)
    })

    it('accepts a non-optional borrowed UnsafeRawBufferPointer input', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' }],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc testFunc(_ bytes: UnsafeRawBufferPointer) {}',
      )
      expect(errors).toHaveLength(0)
    })

    it('rejects optional and return borrowed buffer types', () => {
      const optional = makeExported({
        params: [{ label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer?' }],
      })
      const returning = makeExported({ returnType: 'UnsafeRawBufferPointer' })

      expect(
        validateExports(
          [optional],
          '// @swift-node:export\nfunc testFunc(_ bytes: UnsafeRawBufferPointer?) {}',
        ).some((error) => error.message.includes('must be non-optional')),
      ).toBe(true)
      expect(
        validateExports(
          [returning],
          '// @swift-node:export\nfunc testFunc() -> UnsafeRawBufferPointer { fatalError() }',
        ).some((error) => error.message.includes('input-only borrowed view')),
      ).toBe(true)
    })

    it('accepts explicitly annotated Codable types', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'request', type: 'ModelRequest' }],
        returnType: 'ModelResponse',
      })
      const source =
        '// @swift-node:export\nfunc testFunc(_ request: ModelRequest) -> ModelResponse {\n}'
      const errors = validateExports([fn], source, [], ['ModelRequest', 'ModelResponse'])
      expect(errors).toHaveLength(0)
    })

    it('accepts Codable models with nested Data as base64 JSON values', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'payload', type: 'Payload' }],
      })
      const source = `
// @swift-node:codable
struct Payload: Codable {
  let bytes: Data
}

// @swift-node:export
func testFunc(_ payload: Payload) {}
`

      const errors = validateExports([fn], source, [], ['Payload'])
      expect(errors).toHaveLength(0)
    })

    it('accepts Codable models with nested Data as return values too', () => {
      const fn = makeExported({ returnType: 'Payload' })
      const source = `
// @swift-node:codable
struct Payload: Codable {
  let bytes: Data
}

// @swift-node:export
func testFunc() -> Payload { fatalError() }
`

      const errors = validateExports([fn], source, [], ['Payload'])
      expect(errors).toHaveLength(0)
    })

    it('accepts a cross-file Codable model with nested Data', () => {
      const payloadTypes = parseSwiftCodableTypes(`
// @swift-node:codable
struct Payload: Codable {
  let bytes: Data
}
`)
      const fn = makeExported({ params: [{ label: '_', name: 'payload', type: 'Payload' }] })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc testFunc(_ payload: Payload) {}',
        [],
        payloadTypes,
      )

      expect(errors).toHaveLength(0)
    })

    it.each(['[Data]', 'Array<Data>', '[String: Data]', 'Dictionary<String, Array<Data>>'])(
      'accepts nested Data type %s through JSON base64 values',
      (type) => {
        const fn = makeExported({ params: [{ label: '_', name: 'payload', type }] })
        const errors = validateExports(
          [fn],
          `// @swift-node:export\nfunc testFunc(_ payload: ${type}) {}`,
        )
        expect(errors).toHaveLength(0)
      },
    )
  })

  describe('overloads', () => {
    it('detects overloaded export functions', () => {
      const fn1 = makeExported({ name: 'get', line: 1 })
      const fn2 = makeExported({
        name: 'get',
        params: [{ label: '_', name: 'key', type: 'Int' }],
        line: 5,
      })
      const source =
        '// @swift-node:export\nfunc get() {\n}\n// @swift-node:export\nfunc get(_ key: Int) {\n}'
      const errors = validateExports([fn1, fn2], source)
      expect(errors.some((e) => e.message.includes('Overloaded'))).toBe(true)
    })

    it('passes with uniquely named functions', () => {
      const fn1 = makeExported({ name: 'get', line: 1 })
      const fn2 = makeExported({ name: 'set', line: 5 })
      const source =
        '// @swift-node:export\nfunc get() {\n}\n// @swift-node:export\nfunc set() {\n}'
      const errors = validateExports([fn1, fn2], source)
      expect(errors).toHaveLength(0)
    })
  })

  describe('access control', () => {
    it('rejects private functions', () => {
      const fn = makeExported({ name: 'secret', line: 1 })
      const source = '// @swift-node:export\nprivate func secret() {\n}'
      const errors = validateExports([fn], source)
      expect(errors.some((e) => e.message.includes('private'))).toBe(true)
    })

    it('rejects fileprivate functions', () => {
      const fn = makeExported({ name: 'secret', line: 1 })
      const source = '// @swift-node:export\nfileprivate func secret() {\n}'
      const errors = validateExports([fn], source)
      expect(errors.some((e) => e.message.includes('fileprivate'))).toBe(true)
    })

    it('accepts internal functions (default access)', () => {
      const fn = makeExported({ name: 'okay', line: 1 })
      const source = '// @swift-node:export\nfunc okay() {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)
    })

    it('accepts public functions', () => {
      const fn = makeExported({ name: 'okay', line: 1 })
      const source = '// @swift-node:export\npublic func okay() {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)
    })
  })

  describe('async restrictions', () => {
    it('accepts source-level async throwing functions', () => {
      const fn = makeExported({
        name: 'slow',
        isAsync: true,
        throws: true,
        returnType: 'String',
      })
      const source = '// @swift-node:export\nfunc slow() async throws -> String {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)
    })

    it('accepts source-level async JSON and Data values', () => {
      const fn = makeExported({
        name: 'transform',
        isAsync: true,
        params: [
          { label: '_', name: 'items', type: '[String?]' },
          { label: '_', name: 'metadata', type: 'Dictionary<String, Int>' },
          { label: '_', name: 'input', type: 'Data' },
          { label: '_', name: 'request', type: 'Request' },
        ],
        returnType: 'Data',
      })
      const source =
        '// @swift-node:export\nfunc transform(_ items: [String?], _ metadata: Dictionary<String, Int>, _ input: Data, _ request: Request) async -> Data { input }\n'

      expect(validateExports([fn], source, [], ['Request'])).toHaveLength(0)
    })

    it('rejects async callbacks', () => {
      const fn = makeExported({
        name: 'slow',
        isAsync: true,
        params: [{ label: '_', name: 'callback', type: '@escaping (String) -> Void' }],
      })
      const source =
        '// @swift-node:export\nfunc slow(_ callback: @escaping (String) -> Void) async {\n}'
      const errors = validateExports([fn], source)
      expect(errors.some((e) => e.message.includes('unsupported async parameter'))).toBe(true)
    })

    it('rejects borrowed buffers in async, stream, global-actor, and callback exports', () => {
      const bytes = { label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' }
      const async = makeExported({ name: 'asyncBytes', isAsync: true, params: [bytes] })
      const stream = makeExported({
        name: 'streamBytes',
        isStream: true,
        params: [bytes],
        returnType: 'AsyncStream<String>',
      })
      const actor = makeExported({
        name: 'actorBytes',
        actorIsolation: 'StorageActor',
        params: [bytes],
      })
      const callback = makeExported({
        name: 'callbackBytes',
        params: [bytes, { label: '_', name: 'done', type: '@escaping () -> Void' }],
      })

      const source = '// @swift-node:export\nfunc ignored() {}'
      expect(
        validateExports([async], source).some((error) => error.message.includes('cannot be async')),
      ).toBe(true)
      expect(
        validateExports([stream], source).some((error) =>
          error.message.includes('Streams outlive'),
        ),
      ).toBe(true)
      expect(
        validateExports([actor], source).some((error) => error.message.includes('@StorageActor')),
      ).toBe(true)
      expect(
        validateExports([callback], source).some((error) =>
          error.message.includes('@escaping callback'),
        ),
      ).toBe(true)
    })

    it('rejects unsafe borrowed-buffer combinations parsed from source', () => {
      const source = `
@globalActor
actor Database {
  static let shared = Database()
}

// @swift-node:export
func asyncBytes(_ bytes: UnsafeRawBufferPointer) async {}

// @swift-node:export
// @swift-node:stream
func streamBytes(_ bytes: UnsafeRawBufferPointer) -> AsyncStream<String> { fatalError() }

// @swift-node:export
@Database
func actorBytes(_ bytes: UnsafeRawBufferPointer) {}

// @swift-node:export
func callbackBytes(_ bytes: UnsafeRawBufferPointer, _ done: @escaping () -> Void) {}
`
      const exported = parseExportedFunctions(source)
      const errors = validateExports(exported, source)

      expect(exported.find((fn) => fn.name === 'actorBytes')?.actorIsolation).toBe('Database')
      expect(errors.some((error) => error.message.includes('cannot be async'))).toBe(true)
      expect(errors.some((error) => error.message.includes('Streams outlive'))).toBe(true)
      expect(errors.some((error) => error.message.includes('@Database'))).toBe(true)
      expect(errors.some((error) => error.message.includes('@escaping callback'))).toBe(true)
    })

    it('rejects a borrowed buffer isolated to a custom global actor from another source', () => {
      const actorsSource = `
actor Executor {}

@globalActor
struct Database {
  static let shared = Executor()
}
`
      const source = `
// @swift-node:export
@Database
func read(_ bytes: UnsafeRawBufferPointer) {}
`
      const exported = parseExportedFunctions(source, parseSwiftGlobalActorNames(actorsSource))
      const errors = validateExports(exported, source)

      expect(exported[0].actorIsolation).toBe('Database')
      expect(errors.some((error) => error.message.includes('@Database'))).toBe(true)
    })

    it('fails closed for an imported custom global actor without an Actor suffix', () => {
      const source = `
import ActorLibrary

// @swift-node:export
@Database
func read(_ bytes: UnsafeRawBufferPointer) {}
`
      const exported = parseExportedFunctions(source)
      const errors = validateExports(exported, source)

      expect(exported[0].actorIsolation).toBe('Database')
      expect(errors.some((error) => error.message.includes('@Database'))).toBe(true)
    })

    it('rejects a borrowed buffer on a qualified imported global actor', () => {
      const source = `
// @swift-node:export
@ActorLibrary.Database
func read(_ bytes: UnsafeRawBufferPointer) {}
`
      const exported = parseExportedFunctions(source)
      const errors = validateExports(exported, source)

      expect(exported[0].actorIsolation).toBe('ActorLibrary.Database')
      expect(errors.some((error) => error.message.includes('@ActorLibrary.Database'))).toBe(true)
    })

    it('rejects non-escaping closures beside borrowed inputs', () => {
      const fn = makeExported({
        name: 'consume',
        params: [
          { label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'done', type: '() -> Void' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc consume(_ bytes: UnsafeRawBufferPointer, _ done: () -> Void) {}',
      )

      expect(errors.some((error) => error.message.includes('closure parameter'))).toBe(true)
    })

    it('rejects borrowed buffers as stream elements', () => {
      const fn = makeExported({
        name: 'streamBytes',
        isStream: true,
        returnType: 'AsyncStream<UnsafeRawBufferPointer>',
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:stream\n// @swift-node:export\nfunc streamBytes() -> AsyncStream<UnsafeRawBufferPointer> { fatalError() }',
      )
      expect(errors.some((error) => error.message.includes('unsupported element type'))).toBe(true)
    })

    it('rejects generated borrowed-buffer length name collisions', () => {
      const fn = makeExported({
        name: 'digest',
        params: [
          { label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'bytesLen', type: 'Int' },
          { label: '_', name: 'bytes_len', type: 'Int' },
          { label: '_', name: 'friend', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: '_swift_node_friend_len', type: 'Int' },
          { label: '_', name: 'é', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: '_Len', type: 'Int' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc digest(_ bytes: UnsafeRawBufferPointer, _ bytesLen: Int, _ bytes_len: Int, _ friend: UnsafeRawBufferPointer, _ _swift_node_friend_len: Int, _ é: UnsafeRawBufferPointer, _ _Len: Int) {}',
      )
      expect(
        errors.filter((error) => error.message.includes('conflicts with generated length naming')),
      ).toHaveLength(4)
    })

    it('rejects borrowed inputs that collide with generated ABI and local identifiers', () => {
      const fn = makeExported({
        name: 'bridgeNames',
        returnType: 'String',
        params: [
          { label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'swift_bytes', type: 'Int' },
          { label: '_', name: 'out_error', type: 'Int' },
          { label: '_', name: 'swift_error', type: 'Int' },
          { label: '_', name: 'result', type: 'Int' },
          { label: '_', name: 'result_len', type: 'Int' },
          { label: '_', name: 'out_result_len', type: 'Int' },
          { label: '_', name: 'outResultLen', type: 'Int' },
          { label: '_', name: 'env', type: 'Int' },
          { label: '_', name: 'info', type: 'Int' },
          { label: '_', name: 'argc', type: 'Int' },
          { label: '_', name: 'argv', type: 'Int' },
          { label: '_', name: 'js_result', type: 'Int' },
          { label: '_', name: 'guard', type: 'Int' },
          { label: '_', name: 'friend', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: '_swift_node_friend', type: 'Int' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc bridgeNames(_ bytes: UnsafeRawBufferPointer, _ swift_bytes: Int, _ out_error: Int, _ swift_error: Int, _ result: Int, _ result_len: Int, _ out_result_len: Int, _ outResultLen: Int, _ env: Int, _ info: Int, _ argc: Int, _ argv: Int, _ js_result: Int, _ guard: Int, _ friend: UnsafeRawBufferPointer, _ _swift_node_friend: Int) -> String { "" }',
      )

      for (const name of [
        'swift_bytes',
        'out_error',
        'swift_error',
        'result',
        'result_len',
        'out_result_len',
        'outResultLen',
        'env',
        'info',
        'argc',
        'argv',
        'js_result',
        'guard',
        '_swift_node_friend',
      ]) {
        expect(errors.some((error) => error.message.includes(`'${name}'`))).toBe(true)
      }
    })

    it('rejects generated Data conversion locals adjacent to borrowed inputs', () => {
      const fn = makeExported({
        name: 'dataNames',
        params: [
          { label: '_', name: 'payload', type: 'Data' },
          { label: '_', name: 'payload_base64', type: 'UnsafeRawBufferPointer' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc dataNames(_ payload: Data, _ payload_base64: UnsafeRawBufferPointer) {}',
      )

      expect(errors.some((error) => error.message.includes("'payload_base64'"))).toBe(true)
    })

    it('rejects remaining borrowed bridge temporary collisions', () => {
      const fn = makeExported({
        name: 'bridgeTemps',
        returnType: 'Profile',
        params: [
          { label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'payload', type: '[UInt8]' },
          { label: '_', name: 'binary_payload', type: 'Int' },
          { label: '_', name: 'maybe', type: 'Int?' },
          { label: '_', name: 'maybe_type', type: 'Int' },
          { label: '_', name: 'maybe_validated', type: 'Int' },
          { label: '_', name: 'profile', type: 'Profile' },
          { label: '_', name: 'swift_node_cleanup_args', type: 'Int' },
          { label: '_', name: 'cResult', type: 'Int' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc bridgeTemps(_ bytes: UnsafeRawBufferPointer, _ payload: [UInt8], _ binary_payload: Int, _ maybe: Int?, _ maybe_type: Int, _ maybe_validated: Int, _ profile: Profile, _ swift_node_cleanup_args: Int, _ cResult: Int) -> Profile { fatalError() }',
        [profileWithString],
      )

      for (const name of [
        'binary_payload',
        'maybe_type',
        'maybe_validated',
        'swift_node_cleanup_args',
        'cResult',
      ]) {
        expect(errors.some((error) => error.message.includes(`'${name}'`))).toBe(true)
      }
    })

    it('does not reserve the cleanup helper for numeric-only ABI structs', () => {
      const fn = makeExported({
        name: 'numericStruct',
        params: [
          { label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'point', type: 'Point' },
          { label: '_', name: 'swift_node_cleanup_args', type: 'Int' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc numericStruct(_ bytes: UnsafeRawBufferPointer, _ point: Point, _ swift_node_cleanup_args: Int) {}',
        [pointWithoutString],
      )

      expect(errors.some((error) => error.message.includes("'swift_node_cleanup_args'"))).toBe(
        false,
      )
    })

    it('rejects the JSON return encoder local beside a borrowed input', () => {
      const fn = makeExported({
        name: 'encodedResult',
        returnType: '[String]',
        params: [
          { label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'encoded', type: 'Int' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc encodedResult(_ bytes: UnsafeRawBufferPointer, _ encoded: Int) -> [String] { [] }',
      )

      expect(errors.some((error) => error.message.includes("'encoded'"))).toBe(true)
    })

    it('rejects synchronous wrapper identifiers even without a borrowed input', () => {
      const fn = makeExported({
        name: 'ordinaryNames',
        returnType: 'Data',
        params: [
          { label: '_', name: 'value', type: 'String' },
          { label: '_', name: 'swift_node_cleanup_args', type: 'Int' },
          { label: '_', name: 'swift_node_result_bytes', type: 'Int' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc ordinaryNames(_ value: String, _ swift_node_cleanup_args: Int, _ swift_node_result_bytes: Int) -> Data { Data() }',
      )

      for (const name of ['swift_node_cleanup_args', 'swift_node_result_bytes']) {
        expect(errors.some((error) => error.message.includes(`'${name}'`))).toBe(true)
      }
    })

    it('rejects Swift return-temporary names even without a borrowed input', () => {
      const structFn = makeExported({
        name: 'structResult',
        returnType: 'Profile',
        params: [{ label: '_', name: 'cResult', type: 'Int' }],
      })
      const jsonFn = makeExported({
        name: 'jsonResult',
        returnType: '[String]',
        params: [{ label: '_', name: 'encoded', type: 'Int' }],
      })

      expect(
        validateExports(
          [structFn],
          '// @swift-node:export\nfunc structResult(_ cResult: Int) -> Profile { fatalError() }',
          ['Profile'],
        ).some((error) => error.message.includes("'cResult'")),
      ).toBe(true)
      expect(
        validateExports(
          [jsonFn],
          '// @swift-node:export\nfunc jsonResult(_ encoded: Int) -> [String] { [] }',
        ).some((error) => error.message.includes("'encoded'")),
      ).toBe(true)
    })

    it('rejects expanded String ABI names after C++ sanitization', () => {
      const fn = makeExported({
        name: 'unicodeNames',
        params: [
          { label: '_', name: 'é', type: 'String' },
          { label: '_', name: '_Len', type: 'Int' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc unicodeNames(_ é: String, _ _Len: Int) {}',
      )

      expect(errors.some((error) => error.message.includes("'_Len'"))).toBe(true)
    })

    it('rejects reverse and C++ local identifier collisions around borrowed inputs', () => {
      const fn = makeExported({
        name: 'reverseNames',
        params: [
          { label: '_', name: 'key', type: 'String' },
          { label: '_', name: 'keyLen', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'value', type: 'Int' },
          { label: '_', name: 'swift_value', type: 'UnsafeRawBufferPointer' },
          { label: '_', name: 'payload', type: 'Data' },
          { label: '_', name: 'payload_len', type: 'UnsafeRawBufferPointer' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc reverseNames(_ key: String, _ keyLen: UnsafeRawBufferPointer, _ value: Int, _ swift_value: UnsafeRawBufferPointer, _ payload: Data, _ payload_len: UnsafeRawBufferPointer) {}',
      )

      for (const name of ['keyLen', 'swift_value', 'payload_len']) {
        expect(errors.some((error) => error.message.includes(`'${name}'`))).toBe(true)
      }
    })

    it('allows borrowed buffers in synchronous MainActor exports', () => {
      const fn = makeExported({
        name: 'mainBytes',
        actorIsolation: 'MainActor',
        params: [{ label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' }],
      })
      expect(
        validateExports([fn], '// @swift-node:export\n@MainActor\nfunc mainBytes() {}'),
      ).toHaveLength(0)
    })
  })

  describe('callback signatures', () => {
    it('rejects borrowed buffer callback arguments', () => {
      const fn = makeExported({
        params: [
          { label: '_', name: 'callback', type: '@escaping (UnsafeRawBufferPointer) -> Void' },
        ],
      })
      const errors = validateExports(
        [fn],
        '// @swift-node:export\nfunc testFunc(_ callback: @escaping (UnsafeRawBufferPointer) -> Void) {}',
      )
      expect(
        errors.some((error) => error.message.includes('unsupported callback argument type')),
      ).toBe(true)
    })

    it('accepts optional String callback arguments', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'callback', type: '@escaping (String?) -> Void' }],
      })
      const source =
        '// @swift-node:export\nfunc testFunc(_ callback: @escaping (String?) -> Void) {\n}'
      const errors = validateExports([fn], source)
      expect(errors).toHaveLength(0)
    })

    it('rejects optional scalar callback arguments other than String?', () => {
      const fn = makeExported({
        params: [{ label: '_', name: 'callback', type: '@escaping (Int?) -> Void' }],
      })
      const source =
        '// @swift-node:export\nfunc testFunc(_ callback: @escaping (Int?) -> Void) {\n}'
      const errors = validateExports([fn], source)
      expect(
        errors.some((e) => e.message.includes('Only String? callback arguments are supported')),
      ).toBe(true)
    })
  })
})
