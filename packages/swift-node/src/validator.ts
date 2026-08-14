/**
 * Validation passes for swift-node export annotations.
 * Catches errors before code generation: unsupported types, overloaded exports,
 * and access control issues.
 */

import {
  ExportedFunction,
  SwiftCodableType,
  SwiftStruct,
  bridgeTransportForType,
  classifyNativeSwiftType,
  isEscapingCallback,
  parseCallbackType,
  parseSwiftStreamReturnType,
} from './parser.js'
import { cppIdentifier } from './generator/index.js'

export interface ValidationError {
  message: string
  line: number // 1-based
  severity: 'error' | 'warning'
}

// Validate all exported functions and return any errors found.
export function validateExports(
  exported: ExportedFunction[],
  source: string,
  knownStructs: Array<string | SwiftStruct> = [],
  knownCodableTypes: Array<string | SwiftCodableType> = [],
): ValidationError[] {
  const errors: ValidationError[] = []
  const knownStructNames = new Set(
    knownStructs.map((struct) => (typeof struct === 'string' ? struct : struct.name)),
  )
  const stringStructNames = new Set(
    knownStructs
      .filter((struct): struct is SwiftStruct => typeof struct !== 'string')
      .filter((struct) => struct.fields.some((field) => field.category === 'string'))
      .map((struct) => struct.name),
  )
  const knownCodableNames = new Set(
    knownCodableTypes.map((type) => (typeof type === 'string' ? type : type.name)),
  )
  errors.push(...validateUnsupportedTypes(exported, knownStructNames, knownCodableNames))
  errors.push(...validateOverloads(exported))
  errors.push(...validateAccessControl(exported, source))
  errors.push(...validateAsyncRestrictions(exported, knownStructNames, knownCodableNames))
  errors.push(...validateCallbackSignatures(exported))
  errors.push(...validateStreams(exported, knownCodableNames))
  errors.push(
    ...validateBorrowedBufferRestrictions(
      exported,
      knownStructNames,
      stringStructNames,
      knownCodableNames,
    ),
  )
  errors.push(
    ...validateSynchronousBridgeIdentifiers(
      exported,
      knownStructNames,
      stringStructNames,
      knownCodableNames,
    ),
  )

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
      if (cat === 'borrowed-buffer' && !transport) {
        errors.push({
          message: `Unsupported type '${p.type}' for parameter '${p.name}' in export function '${fn.name}'. UnsafeRawBufferPointer parameters must be non-optional.`,
          line: fn.line,
          severity: 'error',
        })
      } else if (cat === 'buffer' && !transport) {
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
      if (retCat === 'borrowed-buffer' || transport === 'borrowed') {
        errors.push({
          message: `Unsupported return type '${fn.returnType}' in export function '${fn.name}'. UnsafeRawBufferPointer is an input-only borrowed view; return Data or [UInt8] instead.`,
          line: fn.line,
          severity: 'error',
        })
      } else if (retCat === 'buffer' && !transport) {
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

/**
 * A borrowed buffer aliases a JavaScript Buffer or Uint8Array. The generated
 * C++ wrapper keeps that memory valid only until the native function returns,
 * so it must never enter an async, stream, or escaping-callback bridge.
 */
function validateBorrowedBufferRestrictions(
  exported: ExportedFunction[],
  knownStructNames: Set<string>,
  stringStructNames: Set<string>,
  knownCodableNames: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const fn of exported) {
    const borrowedParams = fn.params.filter(
      (parameter) => bridgeTransportForType(parameter.type, knownCodableNames) === 'borrowed',
    )
    if (borrowedParams.length === 0) continue

    const names = borrowedParams.map((parameter) => `'${parameter.name}'`).join(', ')
    if (fn.isAsync) {
      errors.push({
        message: `Export function '${fn.name}' uses borrowed UnsafeRawBufferPointer parameter ${names} and cannot be async. Borrowed bytes are valid only until the synchronous export call returns.`,
        line: fn.line,
        severity: 'error',
      })
    }
    if (fn.isStream) {
      errors.push({
        message: `Stream export '${fn.name}' uses borrowed UnsafeRawBufferPointer parameter ${names}. Streams outlive the call; use Data or [UInt8] instead.`,
        line: fn.line,
        severity: 'error',
      })
    }
    if (fn.actorIsolation && fn.actorIsolation !== 'MainActor') {
      errors.push({
        message: `Export function '${fn.name}' uses borrowed UnsafeRawBufferPointer parameter ${names} and cannot use @${fn.actorIsolation}. That actor bridge may run after the JavaScript call returns; use @MainActor or Data instead.`,
        line: fn.line,
        severity: 'error',
      })
    }
    for (const attribute of fn.unrecognizedBorrowedAttributes ?? []) {
      errors.push({
        message: `Export function '${fn.name}' uses borrowed UnsafeRawBufferPointer parameter ${names} with unrecognized declaration attribute @${attribute}. swift-node cannot verify that this attribute does not hop to another actor, so use Data or [UInt8] instead.`,
        line: fn.line,
        severity: 'error',
      })
    }
    if (fn.params.some((parameter) => isSourceClosure(parameter.type))) {
      errors.push({
        message: `Export function '${fn.name}' uses borrowed UnsafeRawBufferPointer parameter ${names} and cannot declare an @escaping callback or another closure parameter. Store copied Data if work must outlive the call.`,
        line: fn.line,
        severity: 'error',
      })
    }
    for (const parameter of fn.params) {
      if (/^`[^`]+`$/.test(parameter.name)) {
        errors.push({
          message: `Export function '${fn.name}' parameter '${parameter.name}' is an escaped Swift identifier. UnsafeRawBufferPointer bridge parameters must use an unescaped identifier so generated ABI names remain valid.`,
          line: fn.line,
          severity: 'error',
        })
      }
    }
    for (const parameter of borrowedParams) {
      const generatedSwiftLengthName = `${parameter.name}Len`
      const generatedCppAbiLengthName = cppIdentifier(generatedSwiftLengthName)
      const generatedCppLengthName = `${cppIdentifier(parameter.name)}_len`
      for (const candidate of fn.params) {
        if (candidate === parameter) continue

        const hasLengthNameConflict =
          candidate.name === generatedSwiftLengthName ||
          cppIdentifier(candidate.name) === generatedCppAbiLengthName ||
          cppIdentifier(candidate.name) === generatedCppLengthName
        if (hasLengthNameConflict) {
          errors.push({
            message: `Export function '${fn.name}' parameter '${candidate.name}' conflicts with generated length naming for borrowed UnsafeRawBufferPointer '${parameter.name}'. Rename the source parameter.`,
            line: fn.line,
            severity: 'error',
          })
          continue
        }
      }
    }

    const reportedIdentifierConflicts = new Set<string>()
    const reportIdentifierConflict = (
      parameter: (typeof fn.params)[number],
      identifier: string,
    ) => {
      const key = `${parameter.name}:${identifier}`
      if (reportedIdentifierConflicts.has(key)) return
      reportedIdentifierConflicts.add(key)
      errors.push({
        message: `Export function '${fn.name}' parameter '${parameter.name}' conflicts with generated bridge identifier '${identifier}' for a borrowed UnsafeRawBufferPointer input. Rename the source parameter.`,
        line: fn.line,
        severity: 'error',
      })
    }

    const generatedSwiftAbiNames = new Map<string, (typeof fn.params)[number]>()
    for (const parameter of fn.params) {
      const generatedNames = [parameter.name]
      const transport = bridgeTransportForType(parameter.type, knownCodableNames)
      if (transport === 'borrowed' || classifyNativeSwiftType(parameter.type) === 'string') {
        generatedNames.push(`${parameter.name}Len`)
      }
      for (const generatedName of generatedNames) {
        if (generatedSwiftAbiNames.has(generatedName)) {
          reportIdentifierConflict(parameter, generatedName)
        } else {
          generatedSwiftAbiNames.set(generatedName, parameter)
        }
      }
    }

    const generatedSwiftParameterNames = new Set(['out_error'])
    if (classifyNativeSwiftType(fn.returnType) === 'string') {
      generatedSwiftParameterNames.add('out_result_len')
    }
    for (const parameter of fn.params) {
      if (generatedSwiftParameterNames.has(parameter.name)) {
        reportIdentifierConflict(parameter, parameter.name)
      }
    }

    for (const sourceParameter of fn.params) {
      const generatedSwiftLocalNames = [`swift_${sourceParameter.name}`]
      if (sourceParameter.type.replace(/\s+/g, '') === '[UInt8]') {
        generatedSwiftLocalNames.push(`binary_${sourceParameter.name}`)
      }
      for (const generatedSwiftLocalName of generatedSwiftLocalNames) {
        for (const candidate of fn.params) {
          if (candidate !== sourceParameter && candidate.name === generatedSwiftLocalName) {
            reportIdentifierConflict(candidate, generatedSwiftLocalName)
          }
        }
      }
    }

    const returnTransport = bridgeTransportForType(fn.returnType, knownCodableNames)
    const generatedSwiftReturnLocalNames = [
      ...(returnTransport === 'json' ? ['encoded'] : []),
      ...(knownStructNames.has(fn.returnType.trim()) ? ['cResult'] : []),
    ]
    for (const generatedSwiftReturnLocalName of generatedSwiftReturnLocalNames) {
      for (const parameter of fn.params) {
        if (parameter.name === generatedSwiftReturnLocalName) {
          reportIdentifierConflict(parameter, generatedSwiftReturnLocalName)
        }
      }
    }

    const generatedCppAbiNames = new Map<string, (typeof fn.params)[number]>()
    for (const parameter of fn.params) {
      const generatedNames = [cppIdentifier(parameter.name)]
      const transport = bridgeTransportForType(parameter.type, knownCodableNames)
      if (transport === 'borrowed' || classifyNativeSwiftType(parameter.type) === 'string') {
        generatedNames.push(cppIdentifier(`${parameter.name}Len`))
      }
      for (const generatedName of generatedNames) {
        if (generatedCppAbiNames.has(generatedName)) {
          reportIdentifierConflict(parameter, generatedName)
        } else {
          generatedCppAbiNames.set(generatedName, parameter)
        }
      }
    }

    const generatedCppInputLocalNames = new Map<string, (typeof fn.params)[number]>()
    for (const parameter of fn.params) {
      const name = cppIdentifier(parameter.name)
      const transport = bridgeTransportForType(parameter.type, knownCodableNames)
      const category = classifyNativeSwiftType(parameter.type)
      const generatedNames: string[] = []
      if (
        transport === 'borrowed' ||
        transport === 'json' ||
        transport === 'data' ||
        category === 'string'
      ) {
        generatedNames.push(`${name}_len`)
      }
      if (transport === 'json') generatedNames.push(`${name}_json`)
      if (generatesOptionalJsonScalarValidation(parameter, knownCodableNames)) {
        generatedNames.push(`${name}_type`, `${name}_validated`)
      }
      if (transport === 'data') generatedNames.push(`${name}_data`, `${name}_base64`)
      if (category === 'string' && parameter.type.endsWith('?')) generatedNames.push(`${name}_type`)
      if (knownStructNames.has(parameter.type.trim())) generatedNames.push(`${name}_ok`)
      for (const generatedName of generatedNames) {
        generatedCppInputLocalNames.set(generatedName, parameter)
      }
    }
    for (const parameter of fn.params) {
      const sourceName = cppIdentifier(parameter.name)
      const owner = generatedCppInputLocalNames.get(sourceName)
      if (owner && owner !== parameter) reportIdentifierConflict(parameter, sourceName)
    }

    const generatedCppLocalNames = new Set(['env', 'info', 'argc', 'argv', 'swift_error'])
    if (fn.returnType !== 'Void' && fn.returnType !== '()') {
      generatedCppLocalNames.add('result')
      generatedCppLocalNames.add('js_result')
    }
    if (classifyNativeSwiftType(fn.returnType) === 'string') {
      generatedCppLocalNames.add('result_len')
      generatedCppLocalNames.add('outResultLen')
      generatedCppLocalNames.add('guard')
      if (fn.returnType.endsWith('?')) generatedCppLocalNames.add('js_null')
    }
    if (returnTransport === 'json' || returnTransport === 'data') {
      generatedCppLocalNames.add('guard')
    }
    if (returnTransport === 'data') {
      generatedCppLocalNames.add('swift_node_result_bytes')
    }
    if (fn.returnType === 'Void' || fn.returnType === '()') {
      generatedCppLocalNames.add('js_undefined')
    }
    if (
      fn.params.some((parameter) =>
        needsGeneratedInputCleanup(parameter, stringStructNames, knownCodableNames),
      )
    ) {
      generatedCppLocalNames.add('swift_node_cleanup_args')
    }

    for (const parameter of fn.params) {
      if (generatedCppLocalNames.has(cppIdentifier(parameter.name))) {
        reportIdentifierConflict(parameter, cppIdentifier(parameter.name))
      }
    }
  }

  return errors
}

/**
 * Keep the generated synchronous wrapper namespace collision-free even for
 * exports that do not use a borrowed buffer. This also prevents a generated
 * helper introduced for one transport from breaking an adjacent transport.
 */
function validateSynchronousBridgeIdentifiers(
  exported: ExportedFunction[],
  knownStructNames: Set<string>,
  stringStructNames: Set<string>,
  knownCodableNames: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const fn of exported) {
    const hasBorrowedInput = fn.params.some(
      (parameter) => bridgeTransportForType(parameter.type, knownCodableNames) === 'borrowed',
    )
    const actorRunsAsync = !!fn.actorIsolation && fn.actorIsolation !== 'MainActor'
    const hasCallback = fn.params.some((parameter) => isEscapingCallback(parameter.type))
    if (hasBorrowedInput || fn.isAsync || actorRunsAsync || hasCallback) continue

    const reported = new Set<string>()
    const report = (parameter: (typeof fn.params)[number], identifier: string) => {
      const key = `${parameter.name}:${identifier}`
      if (reported.has(key)) return
      reported.add(key)
      errors.push({
        message: `Export function '${fn.name}' parameter '${parameter.name}' conflicts with generated bridge identifier '${identifier}'. Rename the source parameter.`,
        line: fn.line,
        severity: 'error',
      })
    }
    const register = (
      names: Map<string, (typeof fn.params)[number]>,
      identifier: string,
      parameter: (typeof fn.params)[number],
    ) => {
      const owner = names.get(identifier)
      if (owner && owner !== parameter) report(parameter, identifier)
      else names.set(identifier, parameter)
    }

    const returnTransport = bridgeTransportForType(fn.returnType, knownCodableNames)
    const returnCategory = classifyNativeSwiftType(fn.returnType)
    const directStringReturn = returnTransport === null && returnCategory === 'string'
    const needsErrorBridge =
      fn.throws ||
      returnTransport !== null ||
      fn.params.some(
        (parameter) => bridgeTransportForType(parameter.type, knownCodableNames) !== null,
      )

    const swiftAbiNames = new Map<string, (typeof fn.params)[number]>()
    const cppNames = new Map<string, (typeof fn.params)[number]>()
    for (const parameter of fn.params) {
      const transport = bridgeTransportForType(parameter.type, knownCodableNames)
      const category = classifyNativeSwiftType(parameter.type)
      const name = cppIdentifier(parameter.name)
      register(swiftAbiNames, parameter.name, parameter)
      register(cppNames, name, parameter)
      if (category === 'string') {
        register(swiftAbiNames, `${parameter.name}Len`, parameter)
        register(cppNames, cppIdentifier(`${parameter.name}Len`), parameter)
      }
      if (transport === 'json') {
        register(cppNames, `${name}_json`, parameter)
        register(cppNames, `${name}_len`, parameter)
        if (generatesOptionalJsonScalarValidation(parameter, knownCodableNames)) {
          register(cppNames, `${name}_type`, parameter)
          register(cppNames, `${name}_validated`, parameter)
        }
      }
      if (transport === 'data') {
        register(cppNames, `${name}_data`, parameter)
        register(cppNames, `${name}_len`, parameter)
        register(cppNames, `${name}_base64`, parameter)
      }
      if (category === 'string') {
        register(cppNames, `${name}_len`, parameter)
        if (parameter.type.endsWith('?')) register(cppNames, `${name}_type`, parameter)
      }
      if (knownStructNames.has(parameter.type.trim())) register(cppNames, `${name}_ok`, parameter)
      register(swiftAbiNames, `swift_${parameter.name}`, parameter)
      if (parameter.type.replace(/\s+/g, '') === '[UInt8]') {
        register(swiftAbiNames, `binary_${parameter.name}`, parameter)
      }
    }

    if (directStringReturn) {
      for (const parameter of fn.params) {
        if (parameter.name === 'out_result_len') report(parameter, 'out_result_len')
        if (cppIdentifier(parameter.name) === 'outResultLen') report(parameter, 'outResultLen')
      }
    }
    if (needsErrorBridge) {
      for (const parameter of fn.params) {
        if (parameter.name === 'out_error') report(parameter, 'out_error')
        if (cppIdentifier(parameter.name) === 'out_error') report(parameter, 'out_error')
      }
    }
    const generatedSwiftReturnLocals = [
      ...(returnTransport === 'json' ? ['encoded'] : []),
      ...(knownStructNames.has(fn.returnType.trim()) ? ['cResult'] : []),
    ]
    for (const generatedSwiftReturnLocal of generatedSwiftReturnLocals) {
      for (const parameter of fn.params) {
        if (parameter.name === generatedSwiftReturnLocal)
          report(parameter, generatedSwiftReturnLocal)
      }
    }

    const fixedLocals = new Set(['env', 'info', 'argc', 'argv'])
    if (needsErrorBridge) fixedLocals.add('swift_error')
    if (returnCategory === 'void') fixedLocals.add('js_undefined')
    else {
      fixedLocals.add('result')
      fixedLocals.add('js_result')
    }
    if (directStringReturn) {
      fixedLocals.add('result_len')
      fixedLocals.add('guard')
      if (fn.returnType.endsWith('?')) fixedLocals.add('js_null')
    }
    if (returnTransport === 'json' || returnTransport === 'data') fixedLocals.add('guard')
    if (returnTransport === 'data') fixedLocals.add('swift_node_result_bytes')
    if (
      fn.params.some((parameter) =>
        needsGeneratedInputCleanup(parameter, stringStructNames, knownCodableNames),
      )
    ) {
      fixedLocals.add('swift_node_cleanup_args')
    }
    for (const parameter of fn.params) {
      const name = cppIdentifier(parameter.name)
      if (fixedLocals.has(name)) report(parameter, name)
    }
  }

  return errors
}

function isSourceClosure(type: string): boolean {
  return type.includes('->') && !type.includes('@convention(c)')
}

function generatesOptionalJsonScalarValidation(
  parameter: ExportedFunction['params'][number],
  knownCodableNames: Set<string>,
): boolean {
  if (bridgeTransportForType(parameter.type, knownCodableNames) !== 'json') return false
  const nativeType = parameter.type.replace(/\s+/g, '')
  if (!nativeType.endsWith('?')) return false
  return ['Int', 'Int32', 'Int64', 'Double', 'Float'].includes(nativeType.slice(0, -1))
}

function needsGeneratedInputCleanup(
  parameter: ExportedFunction['params'][number],
  stringStructNames: Set<string>,
  knownCodableNames: Set<string>,
): boolean {
  const transport = bridgeTransportForType(parameter.type, knownCodableNames)
  return (
    transport === 'json' ||
    transport === 'data' ||
    classifyNativeSwiftType(parameter.type) === 'string' ||
    stringStructNames.has(parameter.type.trim())
  )
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
      elementCategory === 'borrowed-buffer' ||
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

      const callback = parseCallbackType(p.type)
      if (!callback) {
        errors.push({
          message: `Callback parameter '${p.name}' in export function '${fn.name}' must use a supported @escaping closure signature.`,
          line: fn.line,
          severity: 'error',
        })
        continue
      }

      const isPromiseCallback =
        callback.isAsync && callback.throws && callback.returnType === 'String'
      if (!isPromiseCallback && (callback.isAsync || callback.throws)) {
        errors.push({
          message: `Callback parameter '${p.name}' in export function '${fn.name}' must be synchronous and return Void, or be an async throws callback returning String.`,
          line: fn.line,
          severity: 'error',
        })
      }
      if (!isPromiseCallback && callback.returnType !== 'Void' && callback.returnType !== '()') {
        errors.push({
          message: `Callback parameter '${p.name}' in export function '${fn.name}' must return Void.`,
          line: fn.line,
          severity: 'error',
        })
      }

      for (const callbackParam of callback.params) {
        const callbackType = callbackParam.swiftType.trim()
        if (callbackType.endsWith('?') && callbackType !== 'String?') {
          errors.push({
            message: `Callback parameter '${p.name}' in export function '${fn.name}' uses unsupported optional callback argument type '${callbackType}'. Only String? callback arguments are supported.`,
            line: fn.line,
            severity: 'error',
          })
          continue
        }
        const cat = classifyNativeSwiftType(callbackType)
        if (isPromiseCallback && callbackType !== 'String') {
          errors.push({
            message: `Async callback parameter '${p.name}' in export function '${fn.name}' supports String arguments only.`,
            line: fn.line,
            severity: 'error',
          })
          continue
        }
        if (
          cat === 'unknown' ||
          cat === 'buffer' ||
          cat === 'borrowed-buffer' ||
          cat === 'callback'
        ) {
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
