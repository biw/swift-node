/**
 * Validation passes for swift-node export annotations.
 * Catches errors before code generation: unsupported types, overloaded exports,
 * and access control issues.
 */

import {
  ExportedFunction,
  SwiftCodableType,
  bridgeTransportForType,
  classifyNativeSwiftType,
  isEscapingCallback,
  parseSwiftStreamReturnType,
  splitParams,
} from './parser.js'

export interface ValidationError {
  message: string
  line: number // 1-based
  severity: 'error' | 'warning'
}

// Validate all exported functions and return any errors found.
export function validateExports(
  exported: ExportedFunction[],
  source: string,
  knownStructNames: string[] = [],
  knownCodableTypes: Array<string | SwiftCodableType> = [],
): ValidationError[] {
  const errors: ValidationError[] = []
  const knownCodableNames = new Set(
    knownCodableTypes.map((type) => (typeof type === 'string' ? type : type.name)),
  )
  errors.push(...validateUnsupportedTypes(exported, new Set(knownStructNames), knownCodableNames))
  errors.push(...validateOverloads(exported))
  errors.push(...validateAccessControl(exported, source))
  errors.push(...validateAsyncRestrictions(exported, new Set(knownStructNames), knownCodableNames))
  errors.push(...validateCallbackSignatures(exported))
  errors.push(...validateStreams(exported, knownCodableNames))

  return errors
}

// Check for unsupported parameter and return types in export-annotated functions.
function validateUnsupportedTypes(
  exported: ExportedFunction[],
  knownStructNames: Set<string>,
  knownCodableNames: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const fn of exported) {
    for (const p of fn.params) {
      const cat = classifyNativeSwiftType(p.type)
      const transport = bridgeTransportForType(p.type, knownCodableNames)
      if (cat === 'buffer' && !transport) {
        errors.push({
          message: `Unsupported type '${p.type}' for parameter '${p.name}' in export function '${fn.name}'.`,
          line: fn.line,
          severity: 'error',
        })
      } else if (cat === 'unknown' && !knownStructNames.has(p.type.trim()) && !transport) {
        const suggestion = getSuggestion(p.type)
        errors.push({
          message: `Unsupported type '${p.type}' for parameter '${p.name}' in export function '${fn.name}'.${suggestion}`,
          line: fn.line,
          severity: 'error',
        })
      }
    }

    if (fn.returnType !== 'Void' && !fn.isStream) {
      const retCat = classifyNativeSwiftType(fn.returnType)
      const transport = bridgeTransportForType(fn.returnType, knownCodableNames)
      if (retCat === 'buffer' && !transport) {
        errors.push({
          message: `Unsupported return type '${fn.returnType}' in export function '${fn.name}'.`,
          line: fn.line,
          severity: 'error',
        })
      } else if (
        retCat === 'unknown' &&
        !knownStructNames.has(fn.returnType.trim()) &&
        !transport
      ) {
        const suggestion = getSuggestion(fn.returnType)
        errors.push({
          message: `Unsupported return type '${fn.returnType}' in export function '${fn.name}'.${suggestion}`,
          line: fn.line,
          severity: 'error',
        })
      }
    }
  }

  return errors
}

function getSuggestion(type: string): string {
  const t = type.trim()
  if (t.startsWith('[') || t.includes('Array')) {
    return ' Arrays must have JSON-safe element types.'
  }
  if (t.includes('Dictionary') || (t.includes('[') && t.includes(':'))) {
    return ' Dictionaries must use String keys and JSON-safe value types.'
  }
  if (t.includes('Optional')) {
    return ' Use the shorthand optional syntax (Type?) instead.'
  }
  return ' Supported types include scalars and their optionals, Data, [UInt8], public ABI structs, JSON-safe arrays/dictionaries, and // @swift-node:codable types.'
}

// Check for overloaded export functions (same name, different signatures).
// Generated bridge symbols are name-based, so Swift overloads collide at the boundary.
function validateOverloads(exported: ExportedFunction[]): ValidationError[] {
  const errors: ValidationError[] = []
  const seen = new Map<string, ExportedFunction>()

  for (const fn of exported) {
    const existing = seen.get(fn.name)
    if (existing) {
      errors.push({
        message: `Overloaded export function '${fn.name}' at line ${fn.line} conflicts with the same name at line ${existing.line}. Overloaded functions cannot be exported — rename one of them.`,
        line: fn.line,
        severity: 'error',
      })
    } else {
      seen.set(fn.name, fn)
    }
  }

  return errors
}

// Check that export-annotated functions have at least internal access (not private/fileprivate).
// The generated wrapper is a different file, so it cannot call private functions.
function validateAccessControl(exported: ExportedFunction[], source: string): ValidationError[] {
  const errors: ValidationError[] = []
  const lines = source.split('\n')

  for (const fn of exported) {
    // Scan forward from the annotation line to find the func declaration
    for (let i = fn.line; i < lines.length && i < fn.line + 6; i++) {
      const line = lines[i]
      if (/\bfunc\b/.test(line)) {
        const isFileprivate = /\bfileprivate\b/.test(line)
        const isPrivate = !isFileprivate && /\bprivate\b/.test(line)
        if (isFileprivate || isPrivate) {
          const access = isFileprivate ? 'fileprivate' : 'private'
          errors.push({
            message: `Export function '${fn.name}' is ${access}. Exported functions must be internal or public so the generated wrapper can call them.`,
            line: fn.line,
            severity: 'error',
          })
        }
        break
      }
    }
  }

  return errors
}

function validateAsyncRestrictions(
  exported: ExportedFunction[],
  knownStructNames: Set<string>,
  knownCodableNames: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const fn of exported) {
    if (!fn.isAsync) continue

    for (const p of fn.params) {
      const type = p.type.trim()
      const cat = classifyNativeSwiftType(type)
      const transport = bridgeTransportForType(type, knownCodableNames)
      if (cat === 'callback' || (knownStructNames.has(type) && !transport)) {
        errors.push({
          message: `Async export function '${fn.name}' uses unsupported async parameter '${p.name}: ${p.type}'. Async exports do not accept callback parameters or raw ABI structs.`,
          line: fn.line,
          severity: 'error',
        })
      }
    }

    if (fn.isStream) continue

    const retType = fn.returnType.trim()
    const retCat = classifyNativeSwiftType(retType)
    const returnTransport = bridgeTransportForType(retType, knownCodableNames)
    if (retCat === 'callback' || (knownStructNames.has(retType) && !returnTransport)) {
      errors.push({
        message: `Async export function '${fn.name}' uses unsupported async return type '${fn.returnType}'. Async exports do not return callbacks or raw ABI structs.`,
        line: fn.line,
        severity: 'error',
      })
    }
  }

  return errors
}

function validateStreams(
  exported: ExportedFunction[],
  knownCodableNames: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const fn of exported) {
    if (!fn.isStream) continue

    const stream = parseSwiftStreamReturnType(fn.returnType)
    if (!stream) {
      errors.push({
        message: `Stream export '${fn.name}' must return AsyncStream<Element> or AsyncThrowingStream<Element, Error>.`,
        line: fn.line,
        severity: 'error',
      })
      continue
    }

    const elementType = stream.elementType.replace(/\s+/g, ' ').trim()
    const elementCategory = classifyNativeSwiftType(elementType)
    const transport = bridgeTransportForType(elementType, knownCodableNames)
    if (
      (elementCategory === 'unknown' && transport !== 'json') ||
      (elementCategory === 'buffer' && transport !== 'json') ||
      elementCategory === 'callback' ||
      elementCategory === 'void'
    ) {
      errors.push({
        message: `Stream export '${fn.name}' has unsupported element type '${stream.elementType}'. Streams support scalar, String, and JSON-safe structured values.`,
        line: fn.line,
        severity: 'error',
      })
    }

    for (const parameter of fn.params) {
      if (!isEscapingCallback(parameter.type)) continue
      errors.push({
        message: `Stream export '${fn.name}' cannot declare callback parameter '${parameter.name}'. Return an AsyncStream instead; swift-node supplies the JavaScript subscription callback.`,
        line: fn.line,
        severity: 'error',
      })
    }
  }

  return errors
}

function validateCallbackSignatures(exported: ExportedFunction[]): ValidationError[] {
  const errors: ValidationError[] = []

  for (const fn of exported) {
    for (const p of fn.params) {
      if (!isEscapingCallback(p.type)) continue

      const cleaned = p.type.replace(/@escaping\s+/g, '').trim()
      const match = cleaned.match(/^\(([^)]*)\)\s*->\s*(.+)$/)
      if (!match) {
        errors.push({
          message: `Callback parameter '${p.name}' in export function '${fn.name}' must use a simple @escaping (...) -> Void signature.`,
          line: fn.line,
          severity: 'error',
        })
        continue
      }

      const returnType = match[2].trim()
      if (returnType !== 'Void' && returnType !== '()') {
        errors.push({
          message: `Callback parameter '${p.name}' in export function '${fn.name}' must return Void.`,
          line: fn.line,
          severity: 'error',
        })
      }

      const callbackParams = match[1].trim() ? splitParams(match[1]) : []
      for (const callbackParam of callbackParams) {
        const callbackType = callbackParam.trim()
        if (callbackType.endsWith('?') && callbackType !== 'String?') {
          errors.push({
            message: `Callback parameter '${p.name}' in export function '${fn.name}' uses unsupported optional callback argument type '${callbackType}'. Only String? callback arguments are supported.`,
            line: fn.line,
            severity: 'error',
          })
          continue
        }
        const cat = classifyNativeSwiftType(callbackType)
        if (cat === 'unknown' || cat === 'buffer' || cat === 'callback') {
          errors.push({
            message: `Callback parameter '${p.name}' in export function '${fn.name}' uses unsupported callback argument type '${callbackType}'.`,
            line: fn.line,
            severity: 'error',
          })
        }
      }
    }
  }

  return errors
}
