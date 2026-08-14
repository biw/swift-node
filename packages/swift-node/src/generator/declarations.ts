import {
  type SwiftFunction,
  type SwiftParam,
  type SwiftStruct,
  classifyNativeSwiftType,
  classifySwiftType,
  isCallbackType,
  parseCallbackType,
  splitParams,
} from '../parser.js'

import {
  findStruct,
  isNullableType,
  jsName,
  jsParams,
} from './shared.js'

// --- TypeScript definition generation ---

function tsType(swiftType: string): string {
  const cat = classifySwiftType(swiftType)
  const nullable = swiftType.endsWith('?')
  const base = (() => {
    switch (cat) {
      case 'int32':
      case 'int64':
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

function shorthandDictionaryValueType(type: string): string | null {
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
function tsTypeFromNative(swiftType: string, dataAsBase64 = false): string {
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
      case 'int64':
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

function tsParamType(param: SwiftParam): string {
  if (param.transport === 'data' || param.transport === 'borrowed') return 'Uint8Array'
  return param.nativeType
    ? tsTypeFromNative(param.nativeType, param.transport === 'json')
    : tsType(param.type)
}

function tsReturnType(fn: SwiftFunction, structs: SwiftStruct[]): string {
  const nativeType = fn.nativeReturnType || fn.returnType
  if (fn.returnTransport === 'data') return 'Uint8Array'
  if (fn.returnTransport)
    return fn.nativeReturnType
      ? tsTypeFromNative(nativeType, fn.returnTransport === 'json')
      : tsType(fn.returnType)
  const struct = findStruct(nativeType, structs)
  if (struct) return struct.name
  return fn.nativeReturnType ? tsTypeFromNative(nativeType) : tsType(fn.returnType)
}

function tsCallbackType(swiftType: string): string {
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

function tsStructType(s: SwiftStruct): string {
  const fields = s.fields.map((f) => {
    let t = 'unknown'
    switch (f.category) {
      case 'int32':
      case 'int64':
      case 'double':
        t = 'number'
        break
      case 'bool':
        t = 'boolean'
        break
      case 'string':
        t = 'string'
        break
    }
    return `  ${f.name}: ${t}`
  })
  return `{\n${fields.join('\n')}\n}`
}

function indentLines(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n')
}

export function generateDts(
  functions: SwiftFunction[],
  moduleName: string,
  structs: SwiftStruct[] = [],
): string {
  const lines: string[] = ['// Generated by swift-node — do not edit', '']

  if (functions.some((fn) => fn.stream)) {
    lines.push('declare global {')
    lines.push('  interface SymbolConstructor {')
    lines.push('    readonly dispose: unique symbol')
    lines.push('  }')
    lines.push('}')
    lines.push('')
    lines.push('export interface SwiftNodeSubscription {')
    lines.push('  readonly closed: boolean')
    lines.push('  cancel(): void')
    lines.push('  [Symbol.dispose](): void')
    lines.push('}')
    lines.push('')
  }

  // Generate TypeScript interfaces for structs
  for (const s of structs) {
    lines.push(`export interface ${s.name} ${tsStructType(s)}`)
    lines.push('')
  }

  for (const [index, fn] of functions.entries()) {
    const name = jsName(fn.symbolName, moduleName)

    const jp = jsParams(fn)
    const params = jp.map((p) => {
      if (isCallbackType(p.type)) {
        return `${p.name}: ${tsCallbackType(p.nativeType || p.type)}`
      }
      // Check for struct type — use the clean Swift name, not the C swift_node_ prefix
      const pStructDts = findStruct(p.type, structs)
      if (pStructDts) {
        return `${p.name}: ${pStructDts.name}`
      }
      return `${p.name}: ${tsParamType(p)}`
    })
    if (fn.stream) {
      const value = tsTypeFromNative(fn.stream.elementType, fn.stream.transport === 'json')
      params.push(`onValue: (value: ${value}) => void`)
      params.push('onError?: (error: Error) => void')
      params.push('onComplete?: () => void')
    }

    // Return type: check struct first — use clean Swift name
    const ret = tsReturnType(fn, structs)
    const asyncRet = fn.stream ? 'SwiftNodeSubscription' : fn.isAsync ? `Promise<${ret}>` : ret

    const binding = `__swift_node_${index}`
    lines.push(`declare const ${binding}: (${params.join(', ')}) => ${asyncRet}`)
    lines.push(`export { ${binding} as ${name} }`)
  }

  return lines.join('\n')
}

export function generateDtsCjs(
  functions: SwiftFunction[],
  moduleName: string,
  structs: SwiftStruct[] = [],
): string {
  const lines: string[] = ['// Generated by swift-node — do not edit', '']

  if (functions.some((fn) => fn.stream)) {
    lines.push('declare global {')
    lines.push('  interface SymbolConstructor {')
    lines.push('    readonly dispose: unique symbol')
    lines.push('  }')
    lines.push('}')
    lines.push('')
  }

  lines.push('declare namespace native {')

  if (functions.some((fn) => fn.stream)) {
    lines.push('  interface SwiftNodeSubscription {')
    lines.push('    readonly closed: boolean')
    lines.push('    cancel(): void')
    lines.push('    [Symbol.dispose](): void')
    lines.push('  }')
    lines.push('')
  }

  for (const s of structs) {
    lines.push(indentLines(`interface ${s.name} ${tsStructType(s)}`, 2))
    lines.push('')
  }

  const iface: string[] = []
  for (const fn of functions) {
    const name = jsName(fn.symbolName, moduleName)

    const jp = jsParams(fn)
    const params = jp.map((p) => {
      if (isCallbackType(p.type)) {
        return `${p.name}: ${tsCallbackType(p.nativeType || p.type)}`
      }
      const pStructDts = findStruct(p.type, structs)
      if (pStructDts) {
        return `${p.name}: ${pStructDts.name}`
      }
      return `${p.name}: ${tsParamType(p)}`
    })
    if (fn.stream) {
      const value = tsTypeFromNative(fn.stream.elementType, fn.stream.transport === 'json')
      params.push(`onValue: (value: ${value}) => void`)
      params.push('onError?: (error: Error) => void')
      params.push('onComplete?: () => void')
    }

    const ret = tsReturnType(fn, structs)
    const asyncRet = fn.stream ? 'SwiftNodeSubscription' : fn.isAsync ? `Promise<${ret}>` : ret

    iface.push(`  ${name}(${params.join(', ')}): ${asyncRet}`)
  }

  lines.push('  interface NativeBindings {')
  lines.push(iface.map((line) => `  ${line}`).join('\n'))
  lines.push('  }')
  lines.push('}')
  lines.push('')
  lines.push('declare const native: native.NativeBindings')
  lines.push('export = native')

  return lines.join('\n')
}

// Emitted verbatim into both module formats so generated packages load only
// their declared binary without a runtime dependency.
