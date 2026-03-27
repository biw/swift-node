/**
 * Regex-based extraction of @swift-node:export annotations from Swift source files.
 *
 * Supported: single-line and multi-line signatures, explicit type annotations,
 * @escaping closure params, and source-level Swift async functions.
 * Not supported: annotations inside comments, #if blocks.
 */

export interface SwiftParam {
  name: string
  type: string
  /** Source Swift type when the C ABI transports this value as text. */
  nativeType?: string
  transport?: BridgeTransport
  /** Generated ABI length parameter for a direct String argument. */
  bridgeStringLengthFor?: string
  /** Generated ABI output parameter for a direct String return value. */
  bridgeStringResultLength?: boolean
  /** Generated context pointer paired with a callback function pointer. */
  callbackContext?: boolean
}

/** A deliberate text transport across the Swift/C/Node boundary. */
export type BridgeTransport = 'json' | 'data'

export interface CallbackParam {
  type: SwiftTypeCategory
  swiftType: string
}

export interface CallbackInfo {
  params: CallbackParam[]
  returnType: string // always 'Void'
}

export interface SwiftFunction {
  symbolName: string
  params: SwiftParam[]
  returnType: string
  isAsync: boolean
  nativeReturnType?: string
  returnTransport?: BridgeTransport
  /** A source-level AsyncStream export backed by a native subscription. */
  stream?: SwiftStreamInfo
}

// Map Swift types to categories for code generation
export type SwiftTypeCategory =
  | 'int32'
  | 'int64'
  | 'double'
  | 'bool'
  | 'string'
  | 'buffer'
  | 'void'
  | 'callback'
  | 'unknown'

export function classifySwiftType(type: string): SwiftTypeCategory {
  const t = type.trim()
  if (t === 'Int32') return 'int32'
  if (t === 'Int' || t === 'Int64') return 'int64'
  if (t === 'Double' || t === 'Float') return 'double'
  if (t === 'Bool') return 'bool'
  if (t === 'UnsafePointer<CChar>' || t === 'UnsafePointer<CChar>?') return 'string'
  if (t === 'UnsafeMutablePointer<CChar>' || t === 'UnsafeMutablePointer<CChar>?') return 'string'
  if (t === 'UnsafePointer<UInt8>') return 'buffer'
  if (t === 'UnsafePointer<Float>') return 'buffer'
  if (t === 'Void' || t === '()') return 'void'
  if (isCallbackType(t)) return 'callback'
  return 'unknown'
}

// Detect generated C callback types.
export function isCallbackType(type: string): boolean {
  return type.includes('@convention(c)')
}

// Detect @escaping closure types in export-annotated functions.
export function isEscapingCallback(type: string): boolean {
  return type.includes('@escaping') && type.includes('->') && !type.includes('@convention(c)')
}

// Classify Swift source types for export-annotated functions.
export function classifyNativeSwiftType(type: string): SwiftTypeCategory {
  const t = type.replace(/\s+/g, ' ').trim()
  // Strip Optional wrapper
  const base = t.endsWith('?') ? t.slice(0, -1).trim() : t
  if (base === 'Int') return 'int64'
  if (base === 'Int32') return 'int32'
  if (base === 'Int64') return 'int64'
  if (base === 'Double' || base === 'Float') return 'double'
  if (base === 'Bool') return 'bool'
  if (base === 'String') return 'string'
  if (base === 'Data' || base === '[UInt8]') return 'buffer'
  if (base === 'Void' || base === '()') return 'void'
  if (isEscapingCallback(t)) return 'callback'
  return 'unknown'
}

// Parse a callback type like "@escaping @convention(c) (UnsafePointer<CChar>) -> Void"
// into its parameter types and return type
export function parseCallbackType(type: string): CallbackInfo | null {
  // Strip @escaping and @convention(c)
  const cleaned = type
    .replace(/@escaping\s+/g, '')
    .replace(/@convention\(c\)\s*/g, '')
    .trim()

  // Match (ParamTypes) -> ReturnType
  const match = cleaned.match(/^\(([^)]*)\)\s*->\s*(.+)$/)
  if (!match) return null

  const paramsStr = match[1].trim()
  const returnType = match[2].trim()

  if (!paramsStr) {
    return { params: [], returnType }
  }

  const paramParts = splitParams(paramsStr)
  const params: CallbackParam[] = paramParts.map((p) => {
    const trimmed = p.trim()
    return {
      type: classifySwiftType(trimmed),
      swiftType: trimmed,
    }
  })

  return { params, returnType }
}

// Extract the full function signature, handling multi-line signatures
// by collecting lines until we find the opening brace
function extractFuncSignature(lines: string[], startIdx: number): string | null {
  let sig = ''
  for (let j = startIdx; j < lines.length && j < startIdx + 10; j++) {
    sig += ' ' + lines[j]
    if (lines[j].includes('{')) {
      return sig
    }
  }
  return null
}

// --- Struct parsing ---

export interface SwiftStructField {
  name: string
  type: string
  category: SwiftTypeCategory
}

export interface SwiftStruct {
  name: string
  fields: SwiftStructField[]
}

function classifyStructFieldType(type: string): SwiftTypeCategory {
  const t = type.trim()
  if (t.endsWith('?') || /^Optional\s*</.test(t)) return 'unknown'

  const native = classifyNativeSwiftType(t)
  if (native !== 'unknown' && native !== 'callback' && native !== 'buffer' && native !== 'void') {
    return native
  }

  const cInterop = classifySwiftType(t)
  if (
    cInterop !== 'unknown' &&
    cInterop !== 'callback' &&
    cInterop !== 'buffer' &&
    cInterop !== 'void'
  ) {
    return cInterop
  }

  return 'unknown'
}

// Parse all `public struct` definitions from Swift source
export function parseSwiftStructs(source: string): SwiftStruct[] {
  const structs: SwiftStruct[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*public\s+struct\s+(\w+)(?:\s*:\s*[^{]+)?\s*{/)
    if (!match) continue

    const name = match[1]
    const fields: SwiftStructField[] = []
    let hasUnsupportedField = false

    // Scan lines inside the struct for fields
    let braceDepth = 1
    for (let j = i + 1; j < lines.length && braceDepth > 0; j++) {
      const line = lines[j]
      for (const ch of line) {
        if (ch === '{') braceDepth++
        else if (ch === '}') braceDepth--
      }
      if (braceDepth <= 0) break

      // Match stored instance properties. If any stored field is private,
      // fileprivate, or unsupported, skip the whole struct; generating a
      // partial JS shape would misrepresent the Swift value and often fail
      // when the wrapper tries to call the memberwise initializer.
      const fieldMatch = line.match(
        /^\s*((?:(?:public|internal|private|fileprivate|public\(set\)|internal\(set\)|private\(set\)|fileprivate\(set\))\s+)*)?(?:let|var)\s+(\w+)\s*:\s*(.+?)(?:\s*=.*)?$/,
      )
      if (fieldMatch) {
        const modifiers = (fieldMatch[1] || '').replace(
          /\b(?:public|internal|private|fileprivate)\(set\)\s*/g,
          '',
        )
        if (/\b(?:private|fileprivate)\b/.test(modifiers)) {
          hasUnsupportedField = true
          continue
        }

        const fieldName = fieldMatch[2]
        const fieldType = fieldMatch[3].trim()
        if (fieldType.includes('{')) continue

        const category = classifyStructFieldType(fieldType)
        if (category === 'unknown') {
          hasUnsupportedField = true
        } else {
          fields.push({ name: fieldName, type: fieldType, category })
        }
      }
    }

    if (fields.length > 0 && !hasUnsupportedField) {
      structs.push({ name, fields })
    }
  }

  return structs
}

// Find the colon that separates param name from type.
// Must handle colons inside type annotations like UnsafePointer<CChar>
function findParamColon(param: string): number {
  // The first colon that's not inside parentheses or angle brackets
  let depth = 0
  for (let i = 0; i < param.length; i++) {
    const ch = param[i]
    if (ch === '<' || ch === '(') depth++
    else if (ch === '>' || ch === ')') depth--
    else if (ch === ':' && depth === 0) return i
  }
  return -1
}

// --- Export annotation parsing ---

export interface ExportedParam {
  label: string // external label ('_' for unlabeled)
  name: string // internal name
  type: string // native Swift type (e.g., 'String', 'Int')
}

export interface ExportedFunction {
  name: string
  params: ExportedParam[]
  returnType: string
  throws: boolean
  isAsync: boolean
  /** The global actor annotation applied to the exported declaration, if any. */
  actorIsolation?: string
  /** Set by `// @swift-node:stream`. */
  isStream?: boolean
  line: number // 1-based line number for error reporting
}

export interface SwiftStreamInfo {
  elementType: string
  isThrowing: boolean
  transport?: BridgeTransport
}

export interface SwiftCodableType {
  name: string
  line: number
}

// Parse // @swift-node:export annotated functions from Swift source.
// Skips attributes (@available, @MainActor, etc.) between annotation and func.
export function parseExportedFunctions(source: string): ExportedFunction[] {
  const functions: ExportedFunction[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Check for @swift-node:export annotation
    if (!/\/\/\s*@swift-node:export/.test(line)) continue

    const funcSearchStart = i + 1

    // Scan forward, skipping Swift attributes (@available, @MainActor, etc.)
    // and blank lines, until we find 'func'
    let funcLineIdx = -1
    for (let j = funcSearchStart; j < lines.length && j < funcSearchStart + 5; j++) {
      const candidate = lines[j].trim()
      if (!candidate || /^@\w/.test(candidate) || candidate.startsWith('//')) continue
      if (/^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+)?func\s/.test(lines[j])) {
        funcLineIdx = j
        break
      }
      // If we hit a non-attribute, non-func line, stop
      break
    }

    if (funcLineIdx === -1) continue

    // Extract the full function signature
    const sig = extractFuncSignature(lines, funcLineIdx)
    if (!sig) continue

    // Parse: [access] func name(params) [async] [throws] [-> ReturnType] {
    const exportFuncPattern =
      /(?:public\s+|internal\s+)?func\s+(\w+)\s*\(([^{]*)\)\s*(async\s+)?(throws\s+)?(?:->\s*([^{]+))?\s*\{/
    const funcMatch = sig.match(exportFuncPattern)
    if (!funcMatch) continue

    const name = funcMatch[1]
    const paramsStr = funcMatch[2].trim()
    const isAsync = !!funcMatch[3]
    const throws_ = !!funcMatch[4]
    const returnType = funcMatch[5]?.trim() || 'Void'

    const params = parseExportParams(paramsStr)

    const annotations = lines.slice(funcSearchStart, funcLineIdx)
    const isStream = annotations.some((candidate) =>
      /^\s*\/\/\s*@swift-node:stream\s*$/.test(candidate),
    )
    const actorIsolation = annotations
      .map((candidate) => candidate.trim().match(/^@(\w*Actor)$/)?.[1])
      .find(Boolean)

    functions.push({
      name,
      params,
      returnType,
      throws: throws_,
      isAsync,
      ...(actorIsolation ? { actorIsolation } : {}),
      ...(isStream ? { isStream: true } : {}),
      line: i + 1, // 1-based
    })
  }

  return functions
}

/**
 * Parse the deliberately narrow source surface for `@swift-node:stream`.
 * Generic AsyncSequence values cannot cross an @_cdecl boundary safely, while
 * the standard stream types let the generated wrapper own iteration and Task
 * cancellation without exposing Swift implementation details to JavaScript.
 */
export function parseSwiftStreamReturnType(type: string): SwiftStreamInfo | null {
  const normalized = type.replace(/\s+/g, ' ').trim()
  const match = normalized.match(/^(AsyncStream|AsyncThrowingStream)\s*<(.+)>$/)
  if (!match) return null

  const arguments_ = splitParams(match[2])
  if (match[1] === 'AsyncStream') {
    if (arguments_.length !== 1) return null
    return { elementType: arguments_[0].trim(), isThrowing: false }
  }

  if (arguments_.length !== 2) return null
  return { elementType: arguments_[0].trim(), isThrowing: true }
}

function parseExportParams(paramsStr: string): ExportedParam[] {
  if (!paramsStr) return []

  const params: ExportedParam[] = []
  const parts = splitParams(paramsStr)

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const colonIdx = findParamColon(trimmed)
    if (colonIdx === -1) continue

    const beforeColon = trimmed.slice(0, colonIdx).trim()
    let type = trimmed.slice(colonIdx + 1).trim()

    // Strip default values (e.g., '= "World"')
    const eqIdx = findDefaultValueEquals(type)
    if (eqIdx !== -1) {
      type = type.slice(0, eqIdx).trim()
    }

    // Handle "_ name", "label name", or just "name"
    const nameParts = beforeColon.split(/\s+/)
    let label: string
    let name: string
    if (nameParts.length >= 2) {
      label = nameParts[0]
      name = nameParts[nameParts.length - 1]
    } else {
      label = nameParts[0]
      name = nameParts[0]
    }

    params.push({ label, name, type })
  }

  return params
}

// Find the '=' for a default value in a type string, respecting brackets/parens
function findDefaultValueEquals(str: string): number {
  let depth = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '<' || ch === '(') depth++
    else if (ch === '>' || ch === ')') depth--
    else if (ch === '=' && depth === 0) return i
  }
  return -1
}

// Split parameter string on commas, respecting angle brackets and parentheses.
// A '>' preceded by '-' is the closure arrow '->', not a generic close, so it
// must not unbalance the depth counter — otherwise a closure-typed parameter
// followed by another parameter (e.g. a non-last callback) swallows the rest.
export function splitParams(str: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  let prev = ''

  for (const ch of str) {
    if (ch === '<' || ch === '(') {
      depth++
    } else if (ch === ')' || (ch === '>' && prev !== '-')) {
      depth--
    } else if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      prev = ch
      continue
    }
    current += ch
    prev = ch
  }

  if (current.trim()) parts.push(current)
  return parts
}

/**
 * Reads types explicitly opted into the Codable JSON bridge. Requiring this
 * annotation gives a useful validation error instead of burying a missing
 * Codable conformance inside generated Swift.
 */
export function parseSwiftCodableTypes(source: string): SwiftCodableType[] {
  const types: SwiftCodableType[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (!/\/\/\s*@swift-node:codable/.test(lines[i])) continue

    let declaration = ''
    for (let j = i + 1; j < lines.length && j < i + 7; j++) {
      const candidate = lines[j].trim()
      if (!candidate || /^@\w/.test(candidate) || candidate.startsWith('//')) continue
      declaration = candidate
      break
    }

    const match = declaration.match(
      /^(?:(?:public|internal|open)\s+)?(?:final\s+)?(?:struct|enum|class)\s+(\w+)(?:\s*<[^>]+>)?\s*:\s*([^{]+)/,
    )
    if (!match || !/\bCodable\b/.test(match[2])) continue
    types.push({ name: match[1], line: i + 1 })
  }

  return types
}

function normalizedType(type: string): string {
  return type.replace(/\s+/g, '')
}

function unwrapOptional(type: string): string {
  const t = normalizedType(type)
  return t.endsWith('?') ? t.slice(0, -1) : t
}

function dictionaryValueType(type: string): string | null {
  const t = unwrapOptional(type)
  const generic = t.match(/^Dictionary<(.*)>$/)
  if (generic) {
    const args = splitParams(generic[1])
    return args.length === 2 && normalizedType(args[0]) === 'String' ? args[1].trim() : null
  }

  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const contents = t.slice(1, -1)
  const separator = findParamColon(contents)
  return separator > 0 && normalizedType(contents.slice(0, separator)) === 'String'
    ? contents.slice(separator + 1).trim()
    : null
}

function arrayElementType(type: string): string | null {
  const t = unwrapOptional(type)
  if (t.startsWith('[') && t.endsWith(']') && !dictionaryValueType(t)) return t.slice(1, -1).trim()
  const generic = t.match(/^Array<(.*)>$/)
  return generic ? generic[1].trim() : null
}

function genericModel(type: string): { name: string; arguments: string[] } | null {
  const match = unwrapOptional(type).match(/^(\w+)<(.*)>$/)
  if (!match) return null
  return { name: match[1], arguments: splitParams(match[2]) }
}

function isJsonValueType(type: string, codableTypes: Set<string>): boolean {
  const base = unwrapOptional(type)
  if (['String', 'Int', 'Int32', 'Int64', 'Double', 'Float', 'Bool', 'Data'].includes(base))
    return true
  if (codableTypes.has(base)) return true
  const generic = genericModel(base)
  if (generic && codableTypes.has(generic.name)) {
    return generic.arguments.every((argument) => isJsonValueType(argument, codableTypes))
  }
  const arrayElement = arrayElementType(base)
  if (arrayElement) return isJsonValueType(arrayElement, codableTypes)
  const dictionaryValue = dictionaryValueType(base)
  return dictionaryValue ? isJsonValueType(dictionaryValue, codableTypes) : false
}

/** Return the safe wire format for a supported structured type, if any. */
export function bridgeTransportForType(
  type: string,
  codableTypeNames: Iterable<string> = [],
): BridgeTransport | null {
  const codableTypes = new Set(codableTypeNames)
  const base = unwrapOptional(type)
  const optional = normalizedType(type).endsWith('?')
  if ((base === 'Data' || base === '[UInt8]') && !optional) return 'data'
  if (!isJsonValueType(type, codableTypes)) return null

  const arrayElement = arrayElementType(type)
  const dictionaryValue = dictionaryValueType(type)
  if (
    (optional && base !== 'String') ||
    arrayElement ||
    dictionaryValue ||
    codableTypes.has(base) ||
    genericModel(base)
  )
    return 'json'
  return null
}
