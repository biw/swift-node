import {
  ExportedFunction,
  SwiftFunction,
  SwiftParam,
  classifyNativeSwiftType,
  parseSwiftStreamReturnType,
} from '../../parser.js'
import { findStruct, promiseCallbackInfo, sanitizeId } from '../shared.js'
import {
  generatedTransport,
  nativeToCdeclType,
  splitExportCallbackParams,
  swiftBaseType,
} from './common.js'

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
