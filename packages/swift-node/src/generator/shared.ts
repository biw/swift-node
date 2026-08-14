/**
 * Generates C++ addon code, bridge header, and TypeScript definitions
 * from parsed Swift function metadata.
 */

import {
  type BridgeTransport,
  type SwiftFunction,
  type SwiftParam,
  type SwiftStruct,
  type PromiseCallbackInfo,
  classifySwiftType,
  type SwiftTypeCategory,
  parseCallbackType,
  classifyNativeSwiftType,
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

export function isNullableType(swiftType: string): boolean {
  return swiftType.replace(/\s+/g, ' ').trim().endsWith('?')
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
