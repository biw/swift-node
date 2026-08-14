import {
  BridgeTransport,
  SwiftFunction,
  SwiftParam,
  SwiftStruct,
  SwiftStructField,
  PromiseCallbackInfo,
  bridgeTransportForType,
  classifySwiftType,
  SwiftTypeCategory,
  isCallbackType,
  parseCallbackType,
  ExportedFunction,
  classifyNativeSwiftType,
  parseSwiftStreamReturnType,
  splitParams,
} from '../parser.js'

import {
  cppIdentifier,
  findStruct,
  isNullableType,
  promiseCallbackInfo,
  sanitizeId,
  streamElementUsesStringLength,
} from './shared.js'

// --- Swift wrapper generation for export annotations ---

// Map a native Swift type to its C-compatible equivalent for @_cdecl wrappers
function nativeToCdeclType(type: string, isReturn: boolean): string {
  const cat = classifyNativeSwiftType(type)
  const nullable = type.endsWith('?')
  switch (cat) {
    case 'string':
      if (isReturn) return nullable ? 'UnsafeMutablePointer<CChar>?' : 'UnsafeMutablePointer<CChar>'
      return nullable ? 'UnsafePointer<CChar>?' : 'UnsafePointer<CChar>'
    case 'buffer':
      return 'UnsafePointer<UInt8>'
    case 'int32':
      return 'Int32'
    case 'int64':
      return swiftBaseType(type) === 'Int64' ? 'Int64' : 'Int'
    case 'double':
      return 'Double'
    case 'bool':
      return 'Bool'
    case 'void':
      return 'Void'
    default:
      return type
  }
}

function swiftBaseType(type: string): string {
  return type.replace(/\s+/g, ' ').trim().replace(/\?$/, '').trim()
}

function isNativeStringField(field: SwiftStructField): boolean {
  return swiftBaseType(field.type) === 'String'
}

function swiftStructInputValue(paramName: string, field: SwiftStructField): string {
  const fieldName = cppIdentifier(field.name)
  if (field.category === 'string') {
    return isNativeStringField(field)
      ? `swiftNodeDecodeUTF8(${paramName}.${fieldName}, ${paramName}.${fieldName}_len)`
      : `${paramName}.${fieldName}`
  }
  if (field.category === 'int64' && swiftBaseType(field.type) === 'Int') {
    return `Int(${paramName}.${fieldName})`
  }
  if (field.category === 'double' && swiftBaseType(field.type) === 'Float') {
    return `Float(${paramName}.${fieldName})`
  }
  return `${paramName}.${fieldName}`
}

function swiftStructReturnValue(field: SwiftStructField): string {
  if (field.category === 'int64' && swiftBaseType(field.type) === 'Int') {
    return `Int64(result.${field.name})`
  }
  if (field.category === 'double' && swiftBaseType(field.type) === 'Float') {
    return `Double(result.${field.name})`
  }
  return `result.${field.name}`
}

// Generate the Swift call expression with proper argument labels
function generateSwiftCall(fn: ExportedFunction): string {
  if (fn.params.length === 0) return `${fn.name}()`
  const args = fn.params.map((p) => {
    // Escape Swift keywords with backticks
    const callName = `swift_${p.name}`
    const cat = classifyNativeSwiftType(p.type)
    const conversion = cat === 'string' ? callName : `swift_${p.name}`
    if (p.label === '_') return conversion
    if (p.label === p.name) return `${p.label}: ${conversion}`
    return `${p.label}: ${conversion}`
  })
  return `${fn.name}(${args.join(', ')})`
}

function emitSwiftCallbackBridgeCall(
  lines: string[],
  callbackName: string,
  callbackContext: string,
  cbParamTypes: string[],
  indent: string,
  startIndex = 0,
  cArgs: string[][] = [],
): void {
  const nextStringIndex = cbParamTypes.findIndex(
    (t, i) => i >= startIndex && classifyNativeSwiftType(t) === 'string',
  )

  if (nextStringIndex === -1) {
    const callArgs = [
      callbackContext,
      ...cbParamTypes.flatMap(
        (type, i) =>
          cArgs[i] ??
          (classifyNativeSwiftType(type) === 'string'
            ? [`cbArg${i}`, `cbArg${i}.utf8.count`]
            : [`cbArg${i}`]),
      ),
    ]
    lines.push(`${indent}${callbackName}(${callArgs.join(', ')})`)
    return
  }

  const argName = `cbArg${nextStringIndex}`
  const cName = `cStr${nextStringIndex}`
  const type = cbParamTypes[nextStringIndex]

  if (isNullableType(type)) {
    lines.push(`${indent}if let ${argName} = ${argName} {`)
    lines.push(`${indent}    ${argName}.withCString { ${cName} in`)
    const withArgs = [...cArgs]
    withArgs[nextStringIndex] = [cName, `${argName}.utf8.count`]
    emitSwiftCallbackBridgeCall(
      lines,
      callbackName,
      callbackContext,
      cbParamTypes,
      `${indent}        `,
      nextStringIndex + 1,
      withArgs,
    )
    lines.push(`${indent}    }`)
    lines.push(`${indent}} else {`)
    const nilArgs = [...cArgs]
    nilArgs[nextStringIndex] = ['nil', '0']
    emitSwiftCallbackBridgeCall(
      lines,
      callbackName,
      callbackContext,
      cbParamTypes,
      `${indent}    `,
      nextStringIndex + 1,
      nilArgs,
    )
    lines.push(`${indent}}`)
    return
  }

  lines.push(`${indent}${argName}.withCString { ${cName} in`)
  const withArgs = [...cArgs]
  withArgs[nextStringIndex] = [cName, `${argName}.utf8.count`]
  emitSwiftCallbackBridgeCall(
    lines,
    callbackName,
    callbackContext,
    cbParamTypes,
    `${indent}    `,
    nextStringIndex + 1,
    withArgs,
  )
  lines.push(`${indent}}`)
}

// The generated Swift half of a stream owns the Task that iterates the source
// AsyncStream. The C++ half owns JavaScript callback references. Both sides use
// the same subscription id, so cancellation can race safely with completion.
function generateSwiftStreamRuntime(): string {
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
    error.localizedDescription.withCString { callback(subscriptionID, $0) }
}`
}

function generatePromiseCallbackSwiftRuntime(
  fn: ExportedFunction,
  parameter: ExportedFunction['params'][number],
): string {
  const info = promiseCallbackInfo(parameter.type)
  if (!info) return ''

  const prefix = `${sanitizeId(fn.name)}_${sanitizeId(parameter.name)}`
  const cParameters = info.params.flatMap(() => ['UnsafePointer<CChar>', 'Int']).join(', ')
  const lines: string[] = []

  lines.push(
    `public typealias SwiftNodePromiseCompletion_${prefix} = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?, Int, UnsafePointer<CChar>?, Int) -> Void`,
  )
  lines.push(
    `public typealias SwiftNodePromiseInvoke_${prefix} = @convention(c) (UnsafeMutableRawPointer?${cParameters ? `, ${cParameters}` : ''}, SwiftNodePromiseCompletion_${prefix}, UnsafeMutableRawPointer?) -> Void`,
  )
  lines.push(
    `public typealias SwiftNodePromiseRelease_${prefix} = @convention(c) (UnsafeMutableRawPointer?) -> Void`,
  )
  lines.push(`private final class SwiftNodePromiseContinuation_${prefix}: @unchecked Sendable {`)
  lines.push(`    private let lock = NSLock()`)
  lines.push(`    private var continuation: CheckedContinuation<String, Error>?`)
  lines.push(
    `    init(_ continuation: CheckedContinuation<String, Error>) { self.continuation = continuation }`,
  )
  lines.push(
    `    func resume(_ value: UnsafePointer<CChar>?, _ valueLength: Int, _ error: UnsafePointer<CChar>?, _ errorLength: Int) {`,
  )
  lines.push(`        lock.lock()`)
  lines.push(`        let continuation = self.continuation`)
  lines.push(`        self.continuation = nil`)
  lines.push(`        lock.unlock()`)
  lines.push(`        guard let continuation else { return }`)
  lines.push(
    `        if let error { continuation.resume(throwing: NSError(domain: "swift-node", code: 1, userInfo: [NSLocalizedDescriptionKey: swiftNodeDecodeUTF8(error, errorLength)])); return }`,
  )
  lines.push(
    `        guard let value else { continuation.resume(throwing: NSError(domain: "swift-node", code: 1, userInfo: [NSLocalizedDescriptionKey: "JavaScript callback resolved without a value"])); return }`,
  )
  lines.push(`        continuation.resume(returning: swiftNodeDecodeUTF8(value, valueLength))`)
  lines.push(`    }`)
  lines.push(`}`)
  lines.push(
    `private func swiftNodePromiseComplete_${prefix}(_ context: UnsafeMutableRawPointer?, _ value: UnsafePointer<CChar>?, _ valueLength: Int, _ error: UnsafePointer<CChar>?, _ errorLength: Int) {`,
  )
  lines.push(`    guard let context else { return }`)
  lines.push(
    `    Unmanaged<SwiftNodePromiseContinuation_${prefix}>.fromOpaque(context).takeRetainedValue().resume(value, valueLength, error, errorLength)`,
  )
  lines.push(`}`)
  lines.push(`private final class SwiftNodePromiseHandler_${prefix}: @unchecked Sendable {`)
  lines.push(`    let invoke: SwiftNodePromiseInvoke_${prefix}`)
  lines.push(`    let context: UnsafeMutableRawPointer?`)
  lines.push(`    let release: SwiftNodePromiseRelease_${prefix}`)
  lines.push(
    `    init(invoke: @escaping SwiftNodePromiseInvoke_${prefix}, context: UnsafeMutableRawPointer?, release: @escaping SwiftNodePromiseRelease_${prefix}) { self.invoke = invoke; self.context = context; self.release = release }`,
  )
  lines.push(`    deinit { release(context) }`)
  lines.push(
    `    func call(${info.params.map((_, index) => `_ callbackArg${index}: String`).join(', ')}) async throws -> String {`,
  )
  lines.push(`        try await withCheckedThrowingContinuation { continuation in`)
  lines.push(
    `            let pending = Unmanaged.passRetained(SwiftNodePromiseContinuation_${prefix}(continuation)).toOpaque()`,
  )
  if (info.params.length === 0) {
    lines.push(`            invoke(context, swiftNodePromiseComplete_${prefix}, pending)`)
  } else {
    const emit = (index: number, indent: string): void => {
      if (index === info.params.length) {
        const callArguments = Array.from({ length: info.params.length }, (_, argumentIndex) => [
          `cArg${argumentIndex}`,
          `callbackArg${argumentIndex}.utf8.count`,
        ]).flat()
        lines.push(
          `${indent}invoke(context, ${callArguments.join(', ')}, swiftNodePromiseComplete_${prefix}, pending)`,
        )
        return
      }
      lines.push(`${indent}callbackArg${index}.withCString { cArg${index} in`)
      emit(index + 1, `${indent}    `)
      lines.push(`${indent}}`)
    }
    emit(0, '            ')
  }
  lines.push(`        }`)
  lines.push(`    }`)
  lines.push(`}`)

  return lines.join('\n')
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

function generateSingleStreamWrapper(
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

// Generate a single Swift wrapper function for an exported function
function generatedTransport(type: string, codableTypes: Iterable<string>): BridgeTransport | null {
  return bridgeTransportForType(type, codableTypes)
}

function emitSwiftDummyReturn(
  lines: string[],
  retCat: SwiftTypeCategory,
  transport: BridgeTransport | null,
  indent: string,
  returnStruct?: SwiftStruct,
): void {
  if (retCat === 'void') lines.push(`${indent}return`)
  else if (returnStruct) lines.push(`${indent}return swift_node_${returnStruct.name}()`)
  else if (transport || retCat === 'string')
    lines.push(`${indent}return UnsafeMutablePointer(mutating: strdup("")!)`)
  else if (retCat === 'bool') lines.push(`${indent}return false`)
  else if (retCat === 'int32' || retCat === 'int64' || retCat === 'double')
    lines.push(`${indent}return 0`)
}

function emitSwiftBridgeFailure(
  lines: string[],
  retCat: SwiftTypeCategory,
  transport: BridgeTransport | null,
  indent: string,
  returnStruct?: SwiftStruct,
): void {
  lines.push(
    `${indent}out_error.pointee = UnsafeMutablePointer(mutating: strdup("swift-node could not encode or decode a bridged value")!)`,
  )
  emitSwiftDummyReturn(lines, retCat, transport, indent, returnStruct)
}

function generateSingleWrapper(
  fn: ExportedFunction,
  moduleName: string,
  structs: SwiftStruct[] = [],
  codableTypes: Iterable<string> = [],
): string {
  const lines: string[] = []
  const symbol = `${sanitizeId(moduleName)}_${fn.name}`
  const wrapperName = `_sn_${sanitizeId(moduleName)}_${fn.name}`
  const paramTransports = new Map(
    fn.params.map((p) => [p.name, generatedTransport(p.type, codableTypes)]),
  )
  const returnTransport = generatedTransport(fn.returnType, codableTypes)
  const retCat = classifyNativeSwiftType(fn.returnType)
  const retStruct = returnTransport ? undefined : findStruct(fn.returnType, structs)
  const directStringReturn = !returnTransport && retCat === 'string'
  const actorRunsAsync = !!fn.actorIsolation && fn.actorIsolation !== 'MainActor'
  const needsErrorBridge =
    fn.throws ||
    fn.isAsync ||
    actorRunsAsync ||
    returnTransport !== null ||
    Array.from(paramTransports.values()).some(Boolean)

  // Build @_cdecl parameter list
  const cdeclParams: string[] = fn.params.map((p) => {
    const cat = classifyNativeSwiftType(p.type)
    const transport = paramTransports.get(p.name)
    if (transport === 'borrowed') return `_ ${p.name}: UnsafeRawPointer?, _ ${p.name}Len: Int`
    if (transport) return `_ ${p.name}: UnsafePointer<CChar>`
    if (cat === 'callback') {
      const asyncInfo = promiseCallbackInfo(p.type)
      if (asyncInfo) {
        const prefix = `${sanitizeId(fn.name)}_${sanitizeId(p.name)}`
        return `_ ${p.name}: SwiftNodePromiseInvoke_${prefix}, _ ${p.name}Context: UnsafeMutableRawPointer?, _ ${p.name}Release: SwiftNodePromiseRelease_${prefix}`
      }
      const cleaned = p.type.replace(/@escaping\s+/g, '').trim()
      const match = cleaned.match(/^\(([^)]*)\)\s*->\s*(.+)$/)
      if (match) {
        const cbParams = match[1] ? splitExportCallbackParams(match[1]) : []
        const cParams = cbParams
          .flatMap((cp) => {
            const type = cp.trim()
            return classifyNativeSwiftType(type) === 'string'
              ? [nativeToCdeclType(type, false), 'Int']
              : [nativeToCdeclType(type, false)]
          })
          .join(', ')
        return `_ ${p.name}: @convention(c) (UnsafeMutableRawPointer?${cParams ? `, ${cParams}` : ''}) -> Void, _ ${p.name}Context: UnsafeMutableRawPointer?`
      }
      return `_ ${p.name}: @convention(c) (UnsafeMutableRawPointer?) -> Void, _ ${p.name}Context: UnsafeMutableRawPointer?`
    }
    // Check if it's a known struct type
    const pStruct = findStruct(p.type, structs)
    if (pStruct) {
      return `_ ${p.name}: swift_node_${pStruct.name}`
    }
    // Buffer types need a pointer + length pair
    if (cat === 'buffer') {
      return `_ ${p.name}: UnsafePointer<UInt8>, _ ${p.name}Len: Int`
    }
    if (cat === 'string') {
      return `_ ${p.name}: ${nativeToCdeclType(p.type, false)}, _ ${p.name}Len: Int`
    }
    const cdeclType = nativeToCdeclType(p.type, false)
    return `_ ${p.name}: ${cdeclType}`
  })

  if (directStringReturn) {
    cdeclParams.push('_ out_result_len: UnsafeMutablePointer<Int>')
  }

  // Add error out param if function throws
  if (needsErrorBridge) {
    cdeclParams.push('_ out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>')
  }

  // Return type
  const cdeclReturn =
    fn.returnType === 'Void'
      ? ''
      : returnTransport
        ? ' -> UnsafeMutablePointer<CChar>'
        : retStruct
          ? ` -> swift_node_${retStruct.name}`
          : ` -> ${nativeToCdeclType(fn.returnType, true)}`

  lines.push(`@_cdecl("${symbol}")`)
  lines.push(`public func ${wrapperName}(${cdeclParams.join(', ')})${cdeclReturn} {`)
  if (directStringReturn) lines.push('    out_result_len.pointee = 0')

  // Convert input params from C types to Swift types
  for (const p of fn.params) {
    const cat = classifyNativeSwiftType(p.type)
    const pStruct = findStruct(p.type, structs)
    const transport = paramTransports.get(p.name)
    if (transport === 'borrowed') {
      lines.push(
        `    let swift_${p.name} = UnsafeRawBufferPointer(start: ${p.name}, count: ${p.name}Len)`,
      )
    } else if (transport === 'json') {
      lines.push(`    let swift_${p.name}: ${p.type}`)
      lines.push('    do {')
      lines.push(
        `        swift_${p.name} = try JSONDecoder().decode(${p.type}.self, from: Data(String(cString: ${p.name}).utf8))`,
      )
      lines.push('    } catch {')
      emitSwiftBridgeFailure(lines, retCat, returnTransport, '        ', retStruct)
      lines.push('    }')
    } else if (transport === 'data') {
      const binaryName =
        p.type.replace(/\s+/g, '') === '[UInt8]' ? `binary_${p.name}` : `swift_${p.name}`
      lines.push(
        `    guard let ${binaryName} = Data(base64Encoded: String(cString: ${p.name})) else {`,
      )
      emitSwiftBridgeFailure(lines, retCat, returnTransport, '        ', retStruct)
      lines.push('    }')
      if (p.type.replace(/\s+/g, '') === '[UInt8]') {
        lines.push(`    let swift_${p.name} = [UInt8](${binaryName})`)
      }
    } else if (pStruct) {
      // Convert C struct to Swift struct via init
      const fieldArgs = pStruct.fields.map((f) => `${f.name}: ${swiftStructInputValue(p.name, f)}`)
      lines.push(`    let swift_${p.name} = ${pStruct.name}(${fieldArgs.join(', ')})`)
    } else if (cat === 'buffer') {
      lines.push(`    let swift_${p.name} = Data(bytes: ${p.name}, count: ${p.name}Len)`)
    } else if (cat === 'string') {
      const nullable = p.type.endsWith('?')
      if (nullable) {
        lines.push(
          `    let swift_${p.name}: String? = ${p.name}.map { swiftNodeDecodeUTF8($0, ${p.name}Len) }`,
        )
      } else {
        lines.push(`    let swift_${p.name} = swiftNodeDecodeUTF8(${p.name}, ${p.name}Len)`)
      }
    } else if (cat === 'double' && swiftBaseType(p.type) === 'Float') {
      lines.push(`    let swift_${p.name} = Float(${p.name})`)
    } else if (cat === 'callback') {
      const asyncInfo = promiseCallbackInfo(p.type)
      if (asyncInfo) {
        const prefix = `${sanitizeId(fn.name)}_${sanitizeId(p.name)}`
        const cleaned = p.type.replace(/@escaping\s+/g, '').trim()
        const callbackArguments = asyncInfo.params
          .map((_, index) => `callbackArg${index}`)
          .join(', ')
        lines.push(
          `    let handler_${prefix} = SwiftNodePromiseHandler_${prefix}(invoke: ${p.name}, context: ${p.name}Context, release: ${p.name}Release)`,
        )
        lines.push(
          `    let swift_${p.name}: ${cleaned} = { ${callbackArguments} in try await handler_${prefix}.call(${callbackArguments}) }`,
        )
        continue
      }
      // Create a bridging closure: user's function expects Swift types (String),
      // but we have a @convention(c) function pointer that takes C types (UnsafePointer<CChar>).
      // The closure accepts Swift types, converts them to C, and calls the C function.
      const cleaned = p.type.replace(/@escaping\s+/g, '').trim()
      const cbMatch = cleaned.match(/^\(([^)]*)\)\s*->\s*(.+)$/)
      if (cbMatch && cbMatch[1]) {
        const cbParamTypes = splitExportCallbackParams(cbMatch[1]).map((t) => t.trim())
        lines.push(
          `    let swift_${p.name}: ${cleaned} = { ${cbParamTypes.map((_, i) => `cbArg${i}`).join(', ')} in`,
        )
        emitSwiftCallbackBridgeCall(lines, p.name, `${p.name}Context`, cbParamTypes, '        ')
        lines.push(`    }`)
      } else {
        // No-param callback — pass through directly
        lines.push(`    let swift_${p.name} = ${p.name}`)
      }
    } else {
      lines.push(`    let swift_${p.name} = ${p.name}`)
    }
  }

  // Call the user's function and handle return
  const callExpr = generateSwiftCall(fn)
  const isolatedCallExpr = fn.actorIsolation
    ? `${fn.actorIsolation}.assumeIsolated { ${fn.throws ? 'try ' : ''}${callExpr} }`
    : callExpr

  if (fn.isAsync || actorRunsAsync) {
    lines.push('    let semaphore = DispatchSemaphore(value: 0)')
    if (retCat !== 'void') lines.push(`    var asyncResult: ${fn.returnType}?`)
    lines.push('    var asyncError: Error?')
    lines.push(fn.actorIsolation ? `    Task { @${fn.actorIsolation} in` : '    Task {')
    lines.push('        do {')
    if (retCat === 'void') {
      lines.push(`            ${fn.throws ? 'try ' : ''}${fn.isAsync ? 'await ' : ''}${callExpr}`)
    } else {
      lines.push(
        `            asyncResult = ${fn.throws ? 'try ' : ''}${fn.isAsync ? 'await ' : ''}${callExpr}`,
      )
    }
    lines.push('        } catch {')
    lines.push('            asyncError = error')
    lines.push('        }')
    lines.push('        semaphore.signal()')
    lines.push('    }')
    lines.push('    semaphore.wait()')
    lines.push('    if let asyncError {')
    lines.push(
      '        out_error.pointee = UnsafeMutablePointer(mutating: strdup(asyncError.localizedDescription)!)',
    )
    emitSwiftDummyReturn(lines, retCat, returnTransport, '        ', retStruct)
    lines.push('    }')
    if (retCat !== 'void') {
      lines.push('    guard let result = asyncResult else {')
      emitSwiftBridgeFailure(lines, retCat, returnTransport, '        ', retStruct)
      lines.push('    }')
      generateSwiftReturnConversion(
        lines,
        fn.returnType,
        retCat,
        '    ',
        structs,
        returnTransport,
        directStringReturn ? 'out_result_len' : undefined,
      )
    }
  } else if (fn.throws) {
    lines.push('    do {')
    if (retCat === 'void') {
      lines.push(`        try ${isolatedCallExpr}`)
    } else {
      lines.push(`        let result = try ${isolatedCallExpr}`)
      generateSwiftReturnConversion(
        lines,
        fn.returnType,
        retCat,
        '        ',
        structs,
        returnTransport,
        directStringReturn ? 'out_result_len' : undefined,
      )
    }
    lines.push('    } catch {')
    lines.push(
      '        out_error.pointee = UnsafeMutablePointer(mutating: strdup(error.localizedDescription)!)',
    )
    // Return a dummy value on error — the C++ side checks out_error first and throws a JS exception
    if (retCat === 'string' && fn.returnType.endsWith('?')) lines.push('        return nil')
    else if (returnTransport || retCat === 'string')
      lines.push('        return UnsafeMutablePointer(mutating: strdup("")!)')
    else if (retStruct) lines.push(`        return swift_node_${retStruct.name}()`)
    else if (retCat === 'bool') lines.push('        return false')
    else if (retCat === 'int32' || retCat === 'int64' || retCat === 'double')
      lines.push('        return 0')
    lines.push('    }')
  } else {
    if (retCat === 'void') {
      lines.push(`    ${isolatedCallExpr}`)
    } else {
      lines.push(`    let result = ${isolatedCallExpr}`)
      generateSwiftReturnConversion(
        lines,
        fn.returnType,
        retCat,
        '    ',
        structs,
        returnTransport,
        directStringReturn ? 'out_result_len' : undefined,
      )
    }
  }

  lines.push('}')
  return lines.join('\n')
}

function generateSwiftReturnConversion(
  lines: string[],
  returnType: string,
  retCat: SwiftTypeCategory,
  indent: string,
  structs: SwiftStruct[] = [],
  transport: BridgeTransport | null = null,
  stringResultLength?: string,
): void {
  const nullable = returnType.endsWith('?')

  if (transport === 'json') {
    lines.push(`${indent}guard let encoded = try? JSONEncoder().encode(result) else {`)
    emitSwiftBridgeFailure(lines, retCat, transport, `${indent}    `)
    lines.push(`${indent}}`)
    lines.push(
      `${indent}return UnsafeMutablePointer(mutating: strdup(String(decoding: encoded, as: UTF8.self))!)`,
    )
    return
  }
  if (transport === 'data') {
    const dataResult = returnType.replace(/\s+/g, '') === '[UInt8]' ? 'Data(result)' : 'result'
    lines.push(
      `${indent}return UnsafeMutablePointer(mutating: strdup(${dataResult}.base64EncodedString())!)`,
    )
    return
  }

  const retStruct = findStruct(returnType, structs)
  if (retStruct) {
    lines.push(`${indent}var cResult = swift_node_${retStruct.name}()`)
    for (const f of retStruct.fields) {
      const fieldName = cppIdentifier(f.name)
      if (f.category === 'string') {
        if (isNativeStringField(f)) {
          lines.push(
            `${indent}cResult.${fieldName} = UnsafePointer(swiftNodeCopyUTF8(result.${f.name})!)`,
          )
          lines.push(`${indent}cResult.${fieldName}_len = result.${f.name}.utf8.count`)
        } else {
          lines.push(`${indent}cResult.${fieldName} = result.${f.name}`)
          lines.push(`${indent}cResult.${fieldName}_len = strlen(result.${f.name})`)
        }
      } else {
        lines.push(`${indent}cResult.${fieldName} = ${swiftStructReturnValue(f)}`)
      }
    }
    lines.push(`${indent}return cResult`)
    return
  }

  switch (retCat) {
    case 'string':
      if (nullable) {
        lines.push(`${indent}guard let result = result else { return nil }`)
        if (stringResultLength)
          lines.push(`${indent}${stringResultLength}.pointee = result.utf8.count`)
        lines.push(`${indent}return swiftNodeCopyUTF8(result)!`)
      } else {
        if (stringResultLength)
          lines.push(`${indent}${stringResultLength}.pointee = result.utf8.count`)
        lines.push(`${indent}return swiftNodeCopyUTF8(result)!`)
      }
      break
    case 'int32':
    case 'int64':
    case 'bool':
      lines.push(`${indent}return result`)
      break
    case 'double':
      lines.push(
        `${indent}return ${swiftBaseType(returnType) === 'Float' ? 'Double(result)' : 'result'}`,
      )
      break
  }
}

// Split callback param types (simple comma split for native types)
function splitExportCallbackParams(str: string): string[] {
  return splitParams(str)
}

// Convert ExportedFunction[] to SwiftFunction[] for feeding the existing C++ generator.
// This avoids re-parsing the generated Swift wrappers.
export function exportedToSwiftFunctions(
  exported: ExportedFunction[],
  moduleName: string,
  structs: SwiftStruct[] = [],
  codableTypes: Iterable<string> = [],
): SwiftFunction[] {
  const mod = sanitizeId(moduleName)
  return exported.map((fn) => {
    const symbolName = `${mod}_${fn.name}`
    const params: SwiftParam[] = fn.params.flatMap<SwiftParam>((p) => {
      const cat = classifyNativeSwiftType(p.type)
      const transport = generatedTransport(p.type, codableTypes)
      if (transport === 'borrowed') {
        return [
          {
            name: p.name,
            type: 'UnsafeRawPointer?',
            nativeType: p.type,
            transport,
          },
          {
            name: `${p.name}Len`,
            type: 'Int',
            bridgeBorrowedBufferLengthFor: p.name,
          },
        ]
      }
      if (transport) {
        return [
          {
            name: p.name,
            type: 'UnsafePointer<CChar>',
            nativeType: p.type,
            transport,
          },
        ]
      }
      switch (cat) {
        case 'string': {
          const nullable = p.type.endsWith('?')
          return [
            { name: p.name, type: nullable ? 'UnsafePointer<CChar>?' : 'UnsafePointer<CChar>' },
            { name: `${p.name}Len`, type: 'Int', bridgeStringLengthFor: p.name },
          ]
        }
        case 'buffer':
          return [
            { name: p.name, type: 'UnsafePointer<UInt8>' },
            { name: `${p.name}Len`, type: 'Int' },
          ]
        case 'int32':
          return [{ name: p.name, type: 'Int32' }]
        case 'int64':
          return [{ name: p.name, type: swiftBaseType(p.type) === 'Int64' ? 'Int64' : 'Int' }]
        case 'double':
          return [{ name: p.name, type: 'Double' }]
        case 'bool':
          return [{ name: p.name, type: 'Bool' }]
        case 'callback': {
          const asyncInfo = promiseCallbackInfo(p.type)
          if (asyncInfo) {
            const cParams = asyncInfo.params
              .flatMap(() => ['UnsafePointer<CChar>', 'Int'])
              .join(', ')
            const signature = `@escaping @convention(c) (UnsafeMutableRawPointer?${cParams ? `, ${cParams}` : ''}, @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?, Int, UnsafePointer<CChar>?, Int) -> Void, UnsafeMutableRawPointer?) -> Void`
            return [
              {
                name: p.name,
                type: signature,
                nativeType: p.type,
                promiseCallback: asyncInfo,
              },
              { name: `${p.name}Context`, type: 'UnsafeMutableRawPointer?', callbackContext: true },
              {
                name: `${p.name}Release`,
                type: '@escaping @convention(c) (UnsafeMutableRawPointer?) -> Void',
                promiseCallbackRelease: true,
              },
            ]
          }
          const cleaned = p.type.replace(/@escaping\s+/g, '').trim()
          const match = cleaned.match(/^\(([^)]*)\)\s*->\s*(.+)$/)
          if (match) {
            const cbParams = match[1] ? splitExportCallbackParams(match[1]) : []
            const cParams = cbParams
              .flatMap((cp) => {
                const type = cp.trim()
                return classifyNativeSwiftType(type) === 'string'
                  ? [nativeToCdeclType(type, false), 'Int']
                  : [nativeToCdeclType(type, false)]
              })
              .join(', ')
            const signature = `@escaping @convention(c) (UnsafeMutableRawPointer?${cParams ? `, ${cParams}` : ''}) -> Void`
            return [
              { name: p.name, type: signature, nativeType: p.type },
              { name: `${p.name}Context`, type: 'UnsafeMutableRawPointer?', callbackContext: true },
            ]
          }
          return [
            {
              name: p.name,
              type: '@escaping @convention(c) (UnsafeMutableRawPointer?) -> Void',
              nativeType: p.type,
            },
            { name: `${p.name}Context`, type: 'UnsafeMutableRawPointer?', callbackContext: true },
          ]
        }
        default: {
          // Check if it's a known struct type
          const pStruct = findStruct(p.type, structs)
          if (pStruct) return [{ name: p.name, type: `swift_node_${pStruct.name}` }]
          return [{ name: p.name, type: p.type }]
        }
      }
    })

    if (fn.isStream) {
      const stream = parseSwiftStreamReturnType(fn.returnType)
      // validateExports reports malformed stream declarations before codegen.
      // Keeping this guard makes the public generator safe to call directly in
      // tests and other tooling as well.
      if (!stream) {
        throw new Error(
          `Stream export '${fn.name}' has an unsupported return type '${fn.returnType}'.`,
        )
      }
      return {
        symbolName,
        params,
        returnType: 'Void',
        isAsync: false,
        nativeReturnType: 'Void',
        stream: {
          ...stream,
          ...(generatedTransport(stream.elementType, codableTypes) === 'json'
            ? { transport: 'json' as const }
            : {}),
        },
      }
    }

    const returnTransport = generatedTransport(fn.returnType, codableTypes)
    const actorRunsAsync = !!fn.actorIsolation && fn.actorIsolation !== 'MainActor'
    const needsErrorBridge =
      fn.throws ||
      fn.isAsync ||
      actorRunsAsync ||
      returnTransport !== null ||
      params.some((p) => p.transport)

    // Generated Codable conversion can fail before the user's function runs,
    // so it needs the same error channel as a Swift `throws` declaration.
    const directStringReturn =
      !returnTransport && classifyNativeSwiftType(fn.returnType) === 'string'
    if (directStringReturn) {
      params.push({ name: 'outResultLen', type: 'Int', bridgeStringResultLength: true })
    }
    if (needsErrorBridge) {
      params.push({ name: 'outError', type: 'UnsafeMutablePointer<UnsafePointer<CChar>?>' })
    }

    // Map return type to C-compatible
    const retCat = classifyNativeSwiftType(fn.returnType)
    let returnType: string
    if (returnTransport) {
      returnType = 'UnsafeMutablePointer<CChar>'
    } else
      switch (retCat) {
        case 'string': {
          const nullable = fn.returnType.endsWith('?')
          returnType = nullable ? 'UnsafeMutablePointer<CChar>?' : 'UnsafeMutablePointer<CChar>'
          break
        }
        case 'int32':
          returnType = 'Int32'
          break
        case 'int64':
          returnType = swiftBaseType(fn.returnType) === 'Int64' ? 'Int64' : 'Int'
          break
        case 'double':
          returnType = 'Double'
          break
        case 'bool':
          returnType = 'Bool'
          break
        case 'void':
          returnType = 'Void'
          break
        default: {
          const retStruct = findStruct(fn.returnType, structs)
          returnType = retStruct ? `swift_node_${retStruct.name}` : fn.returnType
        }
      }

    return {
      symbolName,
      params,
      returnType,
      isAsync: fn.isAsync || actorRunsAsync,
      nativeReturnType: fn.returnType,
      returnTransport: returnTransport || undefined,
    }
  })
}

// Generate Swift wrapper functions containing @_cdecl exports.
export function generateWrappersSwift(
  exported: ExportedFunction[],
  moduleName: string,
  structs: SwiftStruct[] = [],
  codableTypes: Iterable<string> = [],
): string {
  if (exported.length === 0) return ''

  const lines: string[] = [
    '// Generated by swift-node — do not edit',
    `// Source annotation: // @swift-node:export`,
    '',
    'import Foundation',
    '',
    `private func swiftNodeCopyUTF8(_ value: String) -> UnsafeMutablePointer<CChar>? {
    let bytes = Array(value.utf8)
    guard let destination = malloc(bytes.count + 1)?.assumingMemoryBound(to: CChar.self) else { return nil }
    bytes.withUnsafeBytes { source in
        if !bytes.isEmpty { memcpy(destination, source.baseAddress!, bytes.count) }
    }
    destination[bytes.count] = 0
    return destination
}`,
    '',
    `private func swiftNodeDecodeUTF8(_ value: UnsafePointer<CChar>, _ length: Int) -> String {
    String(decoding: UnsafeRawBufferPointer(start: value, count: length).bindMemory(to: UInt8.self), as: UTF8.self)
}`,
    '',
  ]

  if (exported.some((fn) => fn.isStream)) {
    lines.push(generateSwiftStreamRuntime())
    lines.push('')
  }

  for (const fn of exported) {
    for (const parameter of fn.params) {
      if (promiseCallbackInfo(parameter.type)) {
        lines.push(generatePromiseCallbackSwiftRuntime(fn, parameter))
        lines.push('')
      }
    }
  }

  for (const fn of exported) {
    lines.push(
      fn.isStream
        ? generateSingleStreamWrapper(fn, moduleName, structs, codableTypes)
        : generateSingleWrapper(fn, moduleName, structs, codableTypes),
    )
    lines.push('')
  }

  return lines.join('\n')
}
