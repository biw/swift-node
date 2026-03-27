import { describe, it, expect } from 'vite-plus/test'
import { validateExports } from '../src/validator'
import { parseSwiftCodableTypes } from '../src/parser'
import type { ExportedFunction } from '../src/parser'

const makeExported = (overrides: Partial<ExportedFunction> = {}): ExportedFunction => ({
  name: 'testFunc',
  params: [],
  returnType: 'Void',
  throws: false,
  isAsync: false,
  line: 1,
  ...overrides,
})

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
  })

  describe('callback signatures', () => {
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
