import {
  BridgeTransport,
  ExportedFunction,
  SwiftStructField,
  bridgeTransportForType,
  classifyNativeSwiftType,
  splitParams,
} from '../../parser.js'
import { cppIdentifier } from '../shared.js'

// Map a native Swift type to its C-compatible equivalent for @_cdecl wrappers
export function nativeToCdeclType(type: string, isReturn: boolean): string {
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

export function swiftBaseType(type: string): string {
  return type.replace(/\s+/g, ' ').trim().replace(/\?$/, '').trim()
}

function isNativeStringField(field: SwiftStructField): boolean {
  return swiftBaseType(field.type) === 'String'
}

export function swiftStructInputValue(paramName: string, field: SwiftStructField): string {
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

export function swiftStructReturnValue(field: SwiftStructField): string {
  if (field.category === 'int64' && swiftBaseType(field.type) === 'Int') {
    return `Int64(result.${field.name})`
  }
  if (field.category === 'double' && swiftBaseType(field.type) === 'Float') {
    return `Double(result.${field.name})`
  }
  return `result.${field.name}`
}

// Generate the Swift call expression with proper argument labels
export function generateSwiftCall(fn: ExportedFunction): string {
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

export function generatedTransport(
  type: string,
  codableTypes: Iterable<string>,
): BridgeTransport | null {
  return bridgeTransportForType(type, codableTypes)
}

// Split callback param types (simple comma split for native types)
export function splitExportCallbackParams(str: string): string[] {
  return splitParams(str)
}
