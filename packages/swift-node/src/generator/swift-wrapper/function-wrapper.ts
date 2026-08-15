import {
  BridgeTransport,
  ExportedFunction,
  SwiftStruct,
  SwiftTypeCategory,
  classifyNativeSwiftType,
} from '../../parser.js'
import { cppIdentifier, findStruct, promiseCallbackInfo, sanitizeId } from '../shared.js'
import { emitSwiftCallbackBridgeCall } from './callbacks.js'
import {
  generateSwiftCall,
  generatedTransport,
  nativeToCdeclType,
  splitExportCallbackParams,
  swiftBaseType,
  swiftStructInputValue,
  swiftStructReturnValue,
} from './common.js'

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
    `${indent}out_error.pointee = swiftNodeBridgeError("swift-node could not encode or decode a bridged value")`,
  )
  emitSwiftDummyReturn(lines, retCat, transport, indent, returnStruct)
}

export function generateSingleWrapper(
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
    lines.push('        out_error.pointee = swiftNodeBridgeError(asyncError)')
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
    lines.push('        out_error.pointee = swiftNodeBridgeError(error)')
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
        if (swiftBaseType(f.type) === 'String') {
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
