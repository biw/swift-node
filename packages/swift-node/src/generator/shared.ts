/**
 * Generates C++ addon code, bridge header, and TypeScript definitions
 * from parsed Swift function metadata.
 */

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

// Sanitize name for use as a C/C++ identifier
export function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&')
}

const cppKeywords = new Set([
  'alignas',
  'alignof',
  'and',
  'and_eq',
  'asm',
  'atomic_cancel',
  'atomic_commit',
  'atomic_noexcept',
  'auto',
  'bitand',
  'bitor',
  'bool',
  'break',
  'case',
  'catch',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'class',
  'compl',
  'concept',
  'const',
  'consteval',
  'constexpr',
  'constinit',
  'const_cast',
  'continue',
  'co_await',
  'co_return',
  'co_yield',
  'decltype',
  'default',
  'delete',
  'do',
  'double',
  'dynamic_cast',
  'else',
  'enum',
  'explicit',
  'export',
  'extern',
  'false',
  'float',
  'for',
  'friend',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'mutable',
  'namespace',
  'new',
  'noexcept',
  'not',
  'not_eq',
  'nullptr',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'reflexpr',
  'register',
  'reinterpret_cast',
  'requires',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'static_cast',
  'struct',
  'switch',
  'synchronized',
  'template',
  'this',
  'thread_local',
  'throw',
  'true',
  'try',
  'typedef',
  'typeid',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'volatile',
  'wchar_t',
  'while',
  'xor',
  'xor_eq',
])

export function cppIdentifier(name: string): string {
  const identifier = sanitizeId(name)
  return cppKeywords.has(identifier) ? `_swift_node_${identifier}` : identifier
}

// Derive JS-facing name from a symbol like "ModuleName_funcName"
export function jsName(symbolName: string, moduleName: string): string {
  const sanitized = sanitizeId(moduleName)
  if (symbolName.startsWith(sanitized + '_')) {
    return symbolName.slice(sanitized.length + 1)
  }
  // No module prefix found — use full symbol name to avoid collisions
  return symbolName
}

// --- C++ type mapping ---

export function cppType(swiftType: string): string {
  if (swiftType === 'UnsafeRawPointer' || swiftType === 'UnsafeRawPointer?') return 'const void*'
  const cat = classifySwiftType(swiftType)
  switch (cat) {
    case 'int32':
      return 'int32_t'
    case 'int64':
      return 'int64_t'
    case 'double':
      return 'double'
    case 'bool':
      return 'bool'
    case 'string':
      return 'const char*'
    case 'buffer':
      return 'const uint8_t*'
    case 'void':
      return 'void'
    default:
      return 'void*'
  }
}

export function wireReturnType(fn: SwiftFunction): string {
  return fn.nativeReturnType || fn.returnType
}

// C++ type from a native Swift type category (used for export-generated bridge code)
export function cppTypeFromCategory(cat: SwiftTypeCategory): string {
  switch (cat) {
    case 'int32':
      return 'int32_t'
    case 'int64':
      return 'int64_t'
    case 'double':
      return 'double'
    case 'bool':
      return 'bool'
    case 'string':
      return 'const char*'
    case 'void':
      return 'void'
    default:
      return 'void*'
  }
}

export function cppReturnType(swiftType: string): string {
  if (swiftType.includes('UnsafeMutablePointer<CChar>')) return 'char*'
  return cppType(swiftType)
}

export function tsType(swiftType: string): string {
  const cat = classifySwiftType(swiftType)
  const nullable = swiftType.endsWith('?')
  const base = (() => {
    switch (cat) {
      case 'int32':
        return 'number'
      case 'int64':
        return 'number'
      case 'double':
        return 'number'
      case 'bool':
        return 'boolean'
      case 'string':
        return 'string'
      case 'buffer':
        return 'Buffer'
      case 'void':
        return 'void'
      case 'callback':
        return '(...args: any[]) => void'
      default:
        return 'unknown'
    }
  })()
  return nullable && base !== 'void' ? `${base} | null` : base
}

export function isNullableType(swiftType: string): boolean {
  return swiftType.replace(/\s+/g, ' ').trim().endsWith('?')
}

export function shorthandDictionaryValueType(type: string): string | null {
  if (!type.startsWith('[') || !type.endsWith(']')) return null

  const contents = type.slice(1, -1)
  let depth = 0
  for (let index = 0; index < contents.length; index++) {
    const character = contents[index]
    if (character === '[' || character === '<' || character === '(') depth++
    else if (character === ']' || character === '>' || character === ')') depth--
    else if (character === ':' && depth === 0) {
      return contents.slice(0, index) === 'String' ? contents.slice(index + 1) : null
    }
  }

  return null
}

// TypeScript type from native Swift type (for export-generated .d.ts)
export function tsTypeFromNative(swiftType: string, dataAsBase64 = false): string {
  const normalized = swiftType.replace(/\s+/g, '')
  const nullable = normalized.endsWith('?')
  const baseType = nullable ? normalized.slice(0, -1) : normalized
  const genericDictionary = baseType.match(/^Dictionary<(.*)>$/)
  const dictionaryArgs = genericDictionary ? splitParams(genericDictionary[1]) : []
  const dictionaryValue =
    dictionaryArgs.length === 2 && dictionaryArgs[0].replace(/\s+/g, '') === 'String'
      ? dictionaryArgs[1]
      : shorthandDictionaryValueType(baseType)
  if (dictionaryValue) {
    const type = `Record<string, ${tsTypeFromNative(dictionaryValue, dataAsBase64)}>`
    return nullable ? `${type} | null` : type
  }

  const arrayMatch = baseType.match(/^\[(.*)\]$/) || baseType.match(/^Array<(.*)>$/)
  if (arrayMatch) {
    const element = tsTypeFromNative(arrayMatch[1], dataAsBase64)
    const type = `${element.includes(' | ') ? `(${element})` : element}[]`
    return nullable ? `${type} | null` : type
  }
  if (baseType === 'Data')
    return `${dataAsBase64 ? 'string' : 'Uint8Array'}${nullable ? ' | null' : ''}`
  if (baseType === 'UnsafeRawBufferPointer') return 'Uint8Array'
  const cat = classifyNativeSwiftType(swiftType)
  const base = (() => {
    switch (cat) {
      case 'int32':
        return 'number'
      case 'int64':
        return 'number'
      case 'double':
        return 'number'
      case 'bool':
        return 'boolean'
      case 'string':
        return 'string'
      case 'buffer':
        return 'Buffer'
      case 'void':
        return 'void'
      case 'callback':
        return '(...args: any[]) => void'
      default:
        return 'unknown'
    }
  })()
  return nullable && base !== 'void' ? `${base} | null` : base
}

export function tsParamType(param: SwiftParam): string {
  if (param.transport === 'data' || param.transport === 'borrowed') return 'Uint8Array'
  return param.nativeType
    ? tsTypeFromNative(param.nativeType, param.transport === 'json')
    : tsType(param.type)
}

export function tsReturnType(fn: SwiftFunction, structs: SwiftStruct[]): string {
  const nativeType = wireReturnType(fn)
  if (fn.returnTransport === 'data') return 'Uint8Array'
  if (fn.returnTransport)
    return fn.nativeReturnType
      ? tsTypeFromNative(nativeType, fn.returnTransport === 'json')
      : tsType(fn.returnType)
  const struct = findStruct(nativeType, structs)
  if (struct) return struct.name
  return fn.nativeReturnType ? tsTypeFromNative(nativeType) : tsType(fn.returnType)
}

export function tsCallbackType(swiftType: string): string {
  const cb = parseCallbackType(swiftType)
  if (!cb) return '(...args: any[]) => void'

  const params = cb.params.map((p, i) => {
    const cat = p.type
    let tsT = 'any'
    if (cat === 'string') tsT = isNullableType(p.swiftType) ? 'string | null' : 'string'
    else if (cat === 'int32') tsT = 'number'
    else if (cat === 'int64') tsT = 'number'
    else if (cat === 'double') tsT = 'number'
    else if (cat === 'bool') tsT = 'boolean'
    else if (cat === 'buffer') tsT = 'Float32Array'
    return `arg${i}: ${tsT}`
  })

  if (cb.isAsync && cb.throws && cb.returnType === 'String') {
    return `(${params.join(', ')}) => string | Promise<string>`
  }

  return `(${params.join(', ')}) => void`
}

// Does this function use an error output parameter?
export function hasErrorOutParam(fn: SwiftFunction): boolean {
  return fn.params.some((p) => p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>'))
}

// Filter out error output params and callback params for the JS-facing signature count
export function jsParams(fn: SwiftFunction): SwiftParam[] {
  return fn.params.filter(
    (p) =>
      !p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>') &&
      !p.bridgeStringLengthFor &&
      !p.bridgeStringResultLength &&
      !p.bridgeBorrowedBufferLengthFor &&
      !p.callbackContext &&
      !p.promiseCallbackRelease,
  )
}

// Check if function has a callback parameter
export function getCallbackParam(fn: SwiftFunction): SwiftParam | null {
  return fn.params.find((p) => isCallbackType(p.type)) || null
}

export function promiseCallbackInfo(type: string): PromiseCallbackInfo | null {
  const callback = parseCallbackType(type)
  if (!callback || !callback.isAsync || !callback.throws || callback.returnType !== 'String') {
    return null
  }

  if (callback.params.some((parameter) => parameter.swiftType.replace(/\s+/g, '') !== 'String')) {
    return null
  }

  return { params: callback.params, returnType: callback.returnType }
}


// --- Bridge header generation ---

export function findStruct(typeName: string, structs: SwiftStruct[]): SwiftStruct | undefined {
  // Match by Swift name (Point) or C name (swift_node_Point)
  return structs.find((s) => s.name === typeName || `swift_node_${s.name}` === typeName)
}

export function streamElementUsesStringLength(type: string, transport?: BridgeTransport): boolean {
  return transport !== 'json' && classifyNativeSwiftType(type) === 'string'
}
