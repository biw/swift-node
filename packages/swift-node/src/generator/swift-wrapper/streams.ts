import {
  BridgeTransport,
  ExportedFunction,
  SwiftStruct,
  classifyNativeSwiftType,
  parseSwiftStreamReturnType,
} from '../../parser.js'
import { findStruct, isNullableType, sanitizeId } from '../shared.js'
import {
  generateSwiftCall,
  generatedTransport,
  nativeToCdeclType,
  swiftStructInputValue,
} from './common.js'

// The generated Swift half of a stream owns the Task that iterates the source
// AsyncStream. The C++ half owns JavaScript callback references. Both sides use
// the same subscription id, so cancellation can race safely with completion.
export function generateSwiftStreamRuntime(): string {
  return `private final class SwiftNodeStreamTask: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var cancelled = false

    func install(_ task: Task<Void, Never>) {
        lock.lock()
        self.task = task
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { task.cancel() }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = task
        lock.unlock()
        task?.cancel()
    }
}

private enum SwiftNodeStreamRegistry {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var entries: [Int64: SwiftNodeStreamTask] = [:]

    static func reserve(_ id: Int64) -> SwiftNodeStreamTask {
        let entry = SwiftNodeStreamTask()
        lock.lock()
        entries[id] = entry
        lock.unlock()
        return entry
    }

    static func finish(_ id: Int64) {
        lock.lock()
        entries.removeValue(forKey: id)
        lock.unlock()
    }

    static func cancel(_ id: Int64) {
        lock.lock()
        let entry = entries.removeValue(forKey: id)
        lock.unlock()
        entry?.cancel()
    }
}

private func swiftNodeStreamComplete(
    _ subscriptionID: Int64,
    _ callback: @convention(c) (Int64, UnsafePointer<CChar>?) -> Void,
    _ error: Error? = nil
) {
    guard let error else {
        callback(subscriptionID, nil)
        return
    }
    let encoded = swiftNodeBridgeError(error)
    defer { free(encoded) }
    callback(subscriptionID, UnsafePointer(encoded))
}`
}

function streamElementCdeclType(type: string, transport?: BridgeTransport): string {
  if (transport === 'json') return 'UnsafePointer<CChar>'
  const cdeclType = nativeToCdeclType(type, false)
  return classifyNativeSwiftType(type) === 'string' ? `${cdeclType}, Int` : cdeclType
}

function streamElementCallValue(type: string, valueName: string): string {
  const normalized = type.replace(/\s+/g, '')
  const category = classifyNativeSwiftType(type)
  if (category === 'double' && normalized === 'Float') return `Double(${valueName})`
  return valueName
}

function emitSwiftStreamValue(
  lines: string[],
  elementType: string,
  indent: string,
  transport?: BridgeTransport,
): void {
  if (transport === 'json') {
    lines.push(`${indent}guard let encoded = try? JSONEncoder().encode(value) else {`)
    lines.push(
      `${indent}    swiftNodeStreamComplete(subscription_id, on_complete, NSError(domain: "swift-node", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not encode stream value"]))`,
    )
    lines.push(`${indent}    return`)
    lines.push(`${indent}}`)
    lines.push(
      `${indent}String(decoding: encoded, as: UTF8.self).withCString { on_value(subscription_id, $0) }`,
    )
    return
  }
  const category = classifyNativeSwiftType(elementType)
  if (category === 'string') {
    if (isNullableType(elementType)) {
      lines.push(`${indent}if let value {`)
      lines.push(
        `${indent}    value.withCString { on_value(subscription_id, $0, value.utf8.count) }`,
      )
      lines.push(`${indent}} else {`)
      lines.push(`${indent}    on_value(subscription_id, nil, 0)`)
      lines.push(`${indent}}`)
    } else {
      lines.push(`${indent}value.withCString { on_value(subscription_id, $0, value.utf8.count) }`)
    }
    return
  }
  lines.push(`${indent}on_value(subscription_id, ${streamElementCallValue(elementType, 'value')})`)
}

export function generateSingleStreamWrapper(
  fn: ExportedFunction,
  moduleName: string,
  structs: SwiftStruct[] = [],
  codableTypes: Iterable<string> = [],
): string {
  const stream = parseSwiftStreamReturnType(fn.returnType)
  if (!stream)
    throw new Error(`Stream export '${fn.name}' has an unsupported return type '${fn.returnType}'.`)

  const lines: string[] = []
  const symbol = `${sanitizeId(moduleName)}_${fn.name}`
  const wrapperName = `_sn_${sanitizeId(moduleName)}_${fn.name}`
  const paramTransports = new Map(
    fn.params.map((p) => [p.name, generatedTransport(p.type, codableTypes)]),
  )
  const elementTransport =
    generatedTransport(stream.elementType, codableTypes) === 'json' ? 'json' : undefined
  const cdeclParams: string[] = fn.params.map((p) => {
    const category = classifyNativeSwiftType(p.type)
    const transport = paramTransports.get(p.name)
    if (transport) return `_ ${p.name}: UnsafePointer<CChar>`
    const struct = findStruct(p.type, structs)
    if (struct) return `_ ${p.name}: swift_node_${struct.name}`
    if (category === 'buffer') return `_ ${p.name}: UnsafePointer<UInt8>, _ ${p.name}Len: Int`
    if (category === 'string')
      return `_ ${p.name}: ${nativeToCdeclType(p.type, false)}, _ ${p.name}Len: Int`
    return `_ ${p.name}: ${nativeToCdeclType(p.type, false)}`
  })
  cdeclParams.push('_ subscription_id: Int64')
  cdeclParams.push(
    `_ on_value: @convention(c) (Int64, ${streamElementCdeclType(stream.elementType, elementTransport)}) -> Void`,
  )
  cdeclParams.push('_ on_complete: @convention(c) (Int64, UnsafePointer<CChar>?) -> Void')

  lines.push(`@_cdecl("${symbol}")`)
  lines.push(`public func ${wrapperName}(${cdeclParams.join(', ')}) {`)

  // Decode parameters before reserving the generated Task. A malformed JS
  // value is still reported through the subscription's onError callback.
  for (const p of fn.params) {
    const category = classifyNativeSwiftType(p.type)
    const struct = findStruct(p.type, structs)
    const transport = paramTransports.get(p.name)
    if (transport === 'json') {
      lines.push(
        `    guard let swift_${p.name} = try? JSONDecoder().decode(${p.type}.self, from: Data(String(cString: ${p.name}).utf8)) else {`,
      )
      lines.push(
        `        swiftNodeStreamComplete(subscription_id, on_complete, NSError(domain: "swift-node", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not decode stream argument '${p.name}'"]))`,
      )
      lines.push('        return')
      lines.push('    }')
    } else if (transport === 'data') {
      const binaryName =
        p.type.replace(/\s+/g, '') === '[UInt8]' ? `binary_${p.name}` : `swift_${p.name}`
      lines.push(
        `    guard let ${binaryName} = Data(base64Encoded: String(cString: ${p.name})) else {`,
      )
      lines.push(
        `        swiftNodeStreamComplete(subscription_id, on_complete, NSError(domain: "swift-node", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not decode stream argument '${p.name}'"]))`,
      )
      lines.push('        return')
      lines.push('    }')
      if (p.type.replace(/\s+/g, '') === '[UInt8]')
        lines.push(`    let swift_${p.name} = [UInt8](${binaryName})`)
    } else if (struct) {
      const fields = struct.fields.map(
        (field) => `${field.name}: ${swiftStructInputValue(p.name, field)}`,
      )
      lines.push(`    let swift_${p.name} = ${struct.name}(${fields.join(', ')})`)
    } else if (category === 'buffer') {
      lines.push(`    let swift_${p.name} = Data(bytes: ${p.name}, count: ${p.name}Len)`)
    } else if (category === 'string') {
      if (p.type.endsWith('?'))
        lines.push(
          `    let swift_${p.name}: String? = ${p.name}.map { swiftNodeDecodeUTF8($0, ${p.name}Len) }`,
        )
      else lines.push(`    let swift_${p.name} = swiftNodeDecodeUTF8(${p.name}, ${p.name}Len)`)
    } else {
      lines.push(`    let swift_${p.name} = ${p.name}`)
    }
  }

  const call = generateSwiftCall(fn)
  lines.push('    let registration = SwiftNodeStreamRegistry.reserve(subscription_id)')
  lines.push('    let task = Task {')
  lines.push('        do {')
  lines.push(
    `            let stream = ${fn.throws ? 'try ' : ''}${fn.isAsync ? 'await ' : ''}${call}`,
  )
  if (stream.isThrowing) lines.push('            for try await value in stream {')
  else lines.push('            for await value in stream {')
  lines.push('                if Task.isCancelled { break }')
  emitSwiftStreamValue(lines, stream.elementType, '                ', elementTransport)
  lines.push('            }')
  lines.push(
    '            if !Task.isCancelled { swiftNodeStreamComplete(subscription_id, on_complete) }',
  )
  lines.push('        } catch is CancellationError {')
  lines.push('            // JS cancellation intentionally has no terminal callback.')
  lines.push('        } catch {')
  lines.push(
    '            if !Task.isCancelled { swiftNodeStreamComplete(subscription_id, on_complete, error) }',
  )
  lines.push('        }')
  lines.push('        SwiftNodeStreamRegistry.finish(subscription_id)')
  lines.push('    }')
  lines.push('    registration.install(task)')
  lines.push('}')
  lines.push('')
  lines.push(`@_cdecl("${symbol}_cancel")`)
  lines.push(`public func ${wrapperName}_cancel(_ subscription_id: Int64) {`)
  lines.push('    SwiftNodeStreamRegistry.cancel(subscription_id)')
  lines.push('}')
  return lines.join('\n')
}
