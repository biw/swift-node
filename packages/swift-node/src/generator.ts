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
} from './parser.js'

// Sanitize name for use as a C/C++ identifier
function sanitizeId(name: string): string {
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
function jsName(symbolName: string, moduleName: string): string {
  const sanitized = sanitizeId(moduleName)
  if (symbolName.startsWith(sanitized + '_')) {
    return symbolName.slice(sanitized.length + 1)
  }
  // No module prefix found — use full symbol name to avoid collisions
  return symbolName
}

// --- C++ type mapping ---

function cppType(swiftType: string): string {
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

function wireReturnType(fn: SwiftFunction): string {
  return fn.nativeReturnType || fn.returnType
}

// C++ type from a native Swift type category (used for export-generated bridge code)
function cppTypeFromCategory(cat: SwiftTypeCategory): string {
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

function cppReturnType(swiftType: string): string {
  if (swiftType.includes('UnsafeMutablePointer<CChar>')) return 'char*'
  return cppType(swiftType)
}

function tsType(swiftType: string): string {
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

function isNullableType(swiftType: string): boolean {
  return swiftType.replace(/\s+/g, ' ').trim().endsWith('?')
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

function tsParamType(param: SwiftParam): string {
  if (param.transport === 'data' || param.transport === 'borrowed') return 'Uint8Array'
  return param.nativeType
    ? tsTypeFromNative(param.nativeType, param.transport === 'json')
    : tsType(param.type)
}

function tsReturnType(fn: SwiftFunction, structs: SwiftStruct[]): string {
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

// Does this function use an error output parameter?
function hasErrorOutParam(fn: SwiftFunction): boolean {
  return fn.params.some((p) => p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>'))
}

// Filter out error output params and callback params for the JS-facing signature count
function jsParams(fn: SwiftFunction): SwiftParam[] {
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
function getCallbackParam(fn: SwiftFunction): SwiftParam | null {
  return fn.params.find((p) => isCallbackType(p.type)) || null
}

function promiseCallbackInfo(type: string): PromiseCallbackInfo | null {
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

function findStruct(typeName: string, structs: SwiftStruct[]): SwiftStruct | undefined {
  // Match by Swift name (Point) or C name (swift_node_Point)
  return structs.find((s) => s.name === typeName || `swift_node_${s.name}` === typeName)
}

// Generate C struct typedefs for bridge header
function generateCStructDefs(structs: SwiftStruct[]): string[] {
  const lines: string[] = []
  for (const s of structs) {
    lines.push(`typedef struct {`)
    for (const f of s.fields) {
      const fieldName = cppIdentifier(f.name)
      switch (f.category) {
        case 'int32':
          lines.push(`    int32_t ${fieldName};`)
          break
        case 'int64':
          lines.push(`    int64_t ${fieldName};`)
          break
        case 'double':
          lines.push(`    double ${fieldName};`)
          break
        case 'bool':
          lines.push(`    bool ${fieldName};`)
          break
        case 'string':
          lines.push(`    const char* ${fieldName};`)
          lines.push(`    size_t ${fieldName}_len;`)
          break
      }
    }
    lines.push(`} swift_node_${s.name};`)
    lines.push('')
  }
  return lines
}

// Standalone header with just struct typedefs — imported into Swift via -import-objc-header
export function generateStructsHeader(structs: SwiftStruct[]): string {
  const lines = [
    '// Generated by swift-node — do not edit',
    '#ifndef SWIFT_NODE_STRUCTS_H',
    '#define SWIFT_NODE_STRUCTS_H',
    '',
    '#include <stdint.h>',
    '#include <stdbool.h>',
    '#include <stddef.h>',
    '',
    ...generateCStructDefs(structs),
    '#endif',
  ]
  return lines.join('\n')
}

export function generateBridgeH(
  functions: SwiftFunction[],
  moduleName: string,
  structs: SwiftStruct[] = [],
): string {
  const guard = `${sanitizeId(moduleName).toUpperCase()}_BRIDGE_H`
  const lines: string[] = [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    '',
    '#include <stdint.h>',
    '#include <stdbool.h>',
    '#include <stddef.h>',
    '',
    '#ifdef __cplusplus',
    'extern "C" {',
    '#endif',
    '',
  ]

  // Struct typedefs (before function declarations that reference them)
  if (structs.length > 0) {
    lines.push(...generateCStructDefs(structs))
  }

  for (const fn of functions) {
    if (fn.stream) {
      const params = fn.params.map((p) => {
        const paramName = cppIdentifier(p.name)
        if (p.type.includes('UnsafeMutablePointer<CChar>')) return `char* ${paramName}`
        const pStruct = findStruct(p.type, structs)
        if (pStruct) return `swift_node_${pStruct.name} ${paramName}`
        return `${cppType(p.type)} ${paramName}`
      })
      const valueType =
        fn.stream.transport === 'json'
          ? 'const char*'
          : cppTypeFromCategory(classifyNativeSwiftType(fn.stream.elementType))
      const valueHasLength = streamElementUsesStringLength(
        fn.stream.elementType,
        fn.stream.transport,
      )
      params.push('int64_t subscription_id')
      params.push(`void (*on_value)(int64_t, ${valueType}${valueHasLength ? ', int64_t' : ''})`)
      params.push('void (*on_complete)(int64_t, const char*)')
      lines.push(`void ${fn.symbolName}(${params.join(', ')});`)
      lines.push(`void ${fn.symbolName}_cancel(int64_t subscription_id);`)
      continue
    }

    const ret = cppReturnType(fn.returnType)
    const params = fn.params
      .map((p) => {
        const paramName = cppIdentifier(p.name)
        if (p.bridgeStringResultLength) return `int64_t* ${paramName}`
        if (p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>')) {
          return 'const char** out_error'
        }
        if (p.type.includes('UnsafeMutablePointer<CChar>')) {
          return `char* ${paramName}`
        }
        if (p.promiseCallback) {
          const callbackParams = p.promiseCallback.params
            .flatMap((parameter) => {
              const type = parameter.swiftType
              return classifyNativeSwiftType(type) === 'string'
                ? [`const char*`, 'int64_t']
                : [cppType(type)]
            })
            .join(', ')
          return `void (*${paramName})(void*, ${callbackParams}${callbackParams ? ', ' : ''}void (*)(void*, const char*, int64_t, const char*, int64_t), void*)`
        }
        if (p.promiseCallbackRelease) {
          return `void (*${paramName})(void*)`
        }
        if (isCallbackType(p.type)) {
          // Generate the C callback function pointer signature
          const cb = parseCallbackType(p.type)
          if (cb) {
            const cbParams = cb.params.map((cp) => cppType(cp.swiftType)).join(', ')
            return `void (*${paramName})(${cbParams})`
          }
          return `void (*${paramName})(void)`
        }
        // Check for struct type
        const pStruct = findStruct(p.type, structs)
        if (pStruct) {
          return `swift_node_${pStruct.name} ${paramName}`
        }
        const t = cppType(p.type)
        return `${t} ${paramName}`
      })
      .join(', ')

    // Handle struct return types
    let retType = ret
    const retStruct2 = findStruct(fn.returnType, structs)
    if (retStruct2) {
      retType = `swift_node_${retStruct2.name}`
    }

    lines.push(`${retType} ${fn.symbolName}(${params});`)
  }

  lines.push('', '#ifdef __cplusplus', '}', '#endif', '', `#endif`)
  return lines.join('\n')
}

// --- C++ addon generation ---

function callbackParamCategory(type: string): SwiftTypeCategory {
  const generated = classifySwiftType(type)
  return generated === 'unknown' ? classifyNativeSwiftType(type) : generated
}

function generatePromiseCallbackTrampoline(fn: SwiftFunction, cbParam: SwiftParam): string {
  const info = cbParam.promiseCallback
  if (!info) return ''

  const lines: string[] = []
  const prefix = fn.symbolName
  const callbackParams = info.params

  lines.push(
    `struct CallbackState_${prefix} { napi_env env = nullptr; napi_threadsafe_function tsfn = nullptr; std::atomic<bool> released{false}; };`,
  )
  lines.push(`static std::mutex callbacks_mutex_${prefix};`)
  lines.push(`static std::unordered_set<CallbackState_${prefix}*> callbacks_${prefix};`)
  lines.push(`static void finalize_callback_${prefix}(napi_env, void* data, void*) {`)
  lines.push(`    auto* state = static_cast<CallbackState_${prefix}*>(data);`)
  lines.push(`    if (!state) return;`)
  lines.push(
    `    { std::lock_guard<std::mutex> lock(callbacks_mutex_${prefix}); callbacks_${prefix}.erase(state); }`,
  )
  lines.push(`    delete state;`)
  lines.push(`}`)
  lines.push(`static void cleanup_callbacks_${prefix}(void*) {`)
  lines.push(`    std::vector<CallbackState_${prefix}*> states;`)
  lines.push(
    `    { std::lock_guard<std::mutex> lock(callbacks_mutex_${prefix}); states.assign(callbacks_${prefix}.begin(), callbacks_${prefix}.end()); }`,
  )
  lines.push(
    `    for (auto* state : states) { if (!state->released.exchange(true)) napi_release_threadsafe_function(state->tsfn, napi_tsfn_abort); }`,
  )
  lines.push(`}`)
  lines.push(`static void release_callback_${prefix}(void* callback_context) {`)
  lines.push(`    auto* state = static_cast<CallbackState_${prefix}*>(callback_context);`)
  lines.push(`    if (!state || state->released.exchange(true)) return;`)
  lines.push(`    napi_release_threadsafe_function(state->tsfn, napi_tsfn_abort);`)
  lines.push(`}`)
  lines.push(`struct PromiseCallbackData_${prefix} {`)
  for (let i = 0; i < callbackParams.length; i++) {
    lines.push(`    char* arg${i} = nullptr;`)
    lines.push(`    size_t arg${i}_len = 0;`)
  }
  lines.push(`    void (*complete)(void*, const char*, int64_t, const char*, int64_t) = nullptr;`)
  lines.push(`    void* completion_context = nullptr;`)
  lines.push(`};`)
  lines.push(`struct PromiseResolution_${prefix} {`)
  lines.push(`    void (*complete)(void*, const char*, int64_t, const char*, int64_t) = nullptr;`)
  lines.push(`    void* completion_context = nullptr;`)
  lines.push(`    std::atomic<bool> settled{false};`)
  lines.push(`};`)
  lines.push(
    `static void cleanup_promise_callback_data_${prefix}(PromiseCallbackData_${prefix}* data) {`,
  )
  lines.push(`    if (!data) return;`)
  for (let i = 0; i < callbackParams.length; i++) {
    lines.push(`    free(data->arg${i});`)
  }
  lines.push(`    delete data;`)
  lines.push(`}`)
  lines.push(
    `static void settle_promise_callback_${prefix}(PromiseResolution_${prefix}* resolution, const char* value, size_t value_len, const char* error, size_t error_len) {`,
  )
  lines.push(`    if (!resolution || resolution->settled.exchange(true)) return;`)
  lines.push(
    `    resolution->complete(resolution->completion_context, value, static_cast<int64_t>(value_len), error, static_cast<int64_t>(error_len));`,
  )
  lines.push(`    delete resolution;`)
  lines.push(`}`)
  lines.push(
    `static napi_value resolve_promise_callback_${prefix}(napi_env env, napi_callback_info info) {`,
  )
  lines.push(`    size_t argc = 1; napi_value argv[1]; void* raw = nullptr;`)
  lines.push(
    `    if (napi_get_cb_info(env, info, &argc, argv, nullptr, &raw) != napi_ok) return nullptr;`,
  )
  lines.push(`    auto* resolution = static_cast<PromiseResolution_${prefix}*>(raw);`)
  lines.push(`    if (!resolution) return nullptr;`)
  lines.push(
    `    if (argc != 1) { const char* error = "JavaScript callback resolved without a value"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return nullptr; }`,
  )
  lines.push(`    napi_valuetype type;`)
  lines.push(
    `    if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) { const char* error = "JavaScript callback must resolve to a string"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return nullptr; }`,
  )
  lines.push(`    size_t length = 0;`)
  lines.push(
    `    if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok) { const char* error = "Could not read JavaScript callback result"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return nullptr; }`,
  )
  lines.push(`    std::string value(length, '\\0');`)
  lines.push(
    `    if (length > 0 && napi_get_value_string_utf8(env, argv[0], value.data(), length + 1, &length) != napi_ok) { const char* error = "Could not read JavaScript callback result"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return nullptr; }`,
  )
  lines.push(
    `    settle_promise_callback_${prefix}(resolution, value.data(), length, nullptr, 0); return nullptr;`,
  )
  lines.push(`}`)
  lines.push(
    `static napi_value reject_promise_callback_${prefix}(napi_env env, napi_callback_info info) {`,
  )
  lines.push(`    size_t argc = 1; napi_value argv[1]; void* raw = nullptr;`)
  lines.push(
    `    if (napi_get_cb_info(env, info, &argc, argv, nullptr, &raw) != napi_ok) return nullptr;`,
  )
  lines.push(`    auto* resolution = static_cast<PromiseResolution_${prefix}*>(raw);`)
  lines.push(`    if (!resolution) return nullptr;`)
  lines.push(`    const char* fallback = "JavaScript callback rejected";`)
  lines.push(
    `    if (argc != 1) { settle_promise_callback_${prefix}(resolution, nullptr, 0, fallback, strlen(fallback)); return nullptr; }`,
  )
  lines.push(`    napi_value text;`)
  lines.push(
    `    if (napi_coerce_to_string(env, argv[0], &text) != napi_ok) { settle_promise_callback_${prefix}(resolution, nullptr, 0, fallback, strlen(fallback)); return nullptr; }`,
  )
  lines.push(`    size_t length = 0;`)
  lines.push(
    `    if (napi_get_value_string_utf8(env, text, nullptr, 0, &length) != napi_ok) { settle_promise_callback_${prefix}(resolution, nullptr, 0, fallback, strlen(fallback)); return nullptr; }`,
  )
  lines.push(`    std::string error(length, '\\0');`)
  lines.push(
    `    if (length > 0 && napi_get_value_string_utf8(env, text, error.data(), length + 1, &length) != napi_ok) { settle_promise_callback_${prefix}(resolution, nullptr, 0, fallback, strlen(fallback)); return nullptr; }`,
  )
  lines.push(
    `    settle_promise_callback_${prefix}(resolution, nullptr, 0, error.data(), length); return nullptr;`,
  )
  lines.push(`}`)
  lines.push(
    `static void call_js_${prefix}(napi_env env, napi_value js_callback, void*, void* raw) {`,
  )
  lines.push(`    auto* data = static_cast<PromiseCallbackData_${prefix}*>(raw);`)
  lines.push(`    if (!data) return;`)
  lines.push(`    auto* resolution = new PromiseResolution_${prefix}();`)
  lines.push(
    `    resolution->complete = data->complete; resolution->completion_context = data->completion_context;`,
  )
  lines.push(
    `    if (!env) { const char* error = "JavaScript environment was released"; cleanup_promise_callback_data_${prefix}(data); settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return; }`,
  )
  lines.push(`    napi_value global;`)
  lines.push(`    napi_value argv[${Math.max(callbackParams.length, 1)}];`)
  lines.push(
    `    if (napi_get_global(env, &global) != napi_ok) { const char* error = "Could not read JavaScript global object"; cleanup_promise_callback_data_${prefix}(data); settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return; }`,
  )
  for (let i = 0; i < callbackParams.length; i++) {
    lines.push(
      `    if (!swift_node_napi_ok(env, swift_node_create_string(env, data->arg${i}, data->arg${i}_len, &argv[${i}]), "Failed to create Promise callback argument")) { const char* error = "Could not create JavaScript callback argument"; cleanup_promise_callback_data_${prefix}(data); settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return; }`,
    )
  }
  lines.push(`    napi_value result;`)
  lines.push(
    `    napi_status call_status = napi_call_function(env, global, js_callback, ${callbackParams.length}, argv, &result);`,
  )
  lines.push(`    cleanup_promise_callback_data_${prefix}(data);`)
  lines.push(
    `    if (call_status != napi_ok) { napi_value ignored; napi_get_and_clear_last_exception(env, &ignored); const char* error = "JavaScript callback threw"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return; }`,
  )
  lines.push(`    napi_value promise_constructor; napi_value resolve; napi_value promise;`)
  lines.push(
    `    if (napi_get_named_property(env, global, "Promise", &promise_constructor) != napi_ok || napi_get_named_property(env, promise_constructor, "resolve", &resolve) != napi_ok || napi_call_function(env, promise_constructor, resolve, 1, &result, &promise) != napi_ok) { const char* error = "Could not await JavaScript callback"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return; }`,
  )
  lines.push(
    `    napi_value then; napi_value fulfilled; napi_value rejected; napi_value handlers[2];`,
  )
  lines.push(
    `    if (napi_get_named_property(env, promise, "then", &then) != napi_ok || napi_create_function(env, "swift_node_promise_fulfilled", NAPI_AUTO_LENGTH, resolve_promise_callback_${prefix}, resolution, &fulfilled) != napi_ok || napi_create_function(env, "swift_node_promise_rejected", NAPI_AUTO_LENGTH, reject_promise_callback_${prefix}, resolution, &rejected) != napi_ok) { const char* error = "Could not attach JavaScript Promise handlers"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return; }`,
  )
  lines.push(`    handlers[0] = fulfilled; handlers[1] = rejected;`)
  lines.push(
    `    if (napi_call_function(env, promise, then, 2, handlers, nullptr) != napi_ok) { napi_value ignored; napi_get_and_clear_last_exception(env, &ignored); const char* error = "Could not await JavaScript callback"; settle_promise_callback_${prefix}(resolution, nullptr, 0, error, strlen(error)); return; }`,
  )
  lines.push(`}`)
  const trampolineParams = callbackParams
    .flatMap((_, index) => [`const char* arg${index}`, `int64_t arg${index}_len`])
    .join(', ')
  lines.push(
    `static void trampoline_${prefix}(void* callback_context${trampolineParams ? `, ${trampolineParams}` : ''}, void (*complete)(void*, const char*, int64_t, const char*, int64_t), void* completion_context) {`,
  )
  lines.push(`    auto* state = static_cast<CallbackState_${prefix}*>(callback_context);`)
  lines.push(
    `    if (!state || state->released.load() || napi_acquire_threadsafe_function(state->tsfn) != napi_ok) { const char* error = "JavaScript callback is unavailable"; complete(completion_context, nullptr, 0, error, strlen(error)); return; }`,
  )
  lines.push(
    `    auto* data = new PromiseCallbackData_${prefix}(); data->complete = complete; data->completion_context = completion_context;`,
  )
  for (let i = 0; i < callbackParams.length; i++) {
    lines.push(
      `    data->arg${i}_len = static_cast<size_t>(arg${i}_len); data->arg${i} = arg${i} ? static_cast<char*>(malloc(data->arg${i}_len + 1)) : nullptr;`,
    )
    lines.push(
      `    if (arg${i} && !data->arg${i}) { const char* error = "Out of memory"; cleanup_promise_callback_data_${prefix}(data); complete(completion_context, nullptr, 0, error, strlen(error)); napi_release_threadsafe_function(state->tsfn, napi_tsfn_release); return; }`,
    )
    lines.push(
      `    if (arg${i}) { memcpy(data->arg${i}, arg${i}, data->arg${i}_len); data->arg${i}[data->arg${i}_len] = '\\0'; }`,
    )
  }
  lines.push(
    `    napi_status status = napi_call_threadsafe_function(state->tsfn, data, napi_tsfn_nonblocking);`,
  )
  lines.push(
    `    if (status != napi_ok) { const char* error = "Could not schedule JavaScript callback"; cleanup_promise_callback_data_${prefix}(data); complete(completion_context, nullptr, 0, error, strlen(error)); }`,
  )
  lines.push(`    napi_release_threadsafe_function(state->tsfn, napi_tsfn_release);`)
  lines.push(`}`)

  return lines.join('\n')
}

function generateCallbackTrampoline(fn: SwiftFunction, cbParam: SwiftParam): string {
  if (cbParam.promiseCallback) return generatePromiseCallbackTrampoline(fn, cbParam)
  const cb = parseCallbackType(cbParam.nativeType || cbParam.type)
  if (!cb) return ''

  const lines: string[] = []
  const prefix = fn.symbolName
  const callbackParams = cb.params

  lines.push(
    `struct CallbackState_${prefix} { napi_env env = nullptr; napi_threadsafe_function tsfn = nullptr; };`,
  )
  lines.push(`static std::mutex callbacks_mutex_${prefix};`)
  lines.push(`static std::unordered_set<CallbackState_${prefix}*> callbacks_${prefix};`)
  lines.push(`static void finalize_callback_${prefix}(napi_env, void* data, void*) {`)
  lines.push(`    auto* state = static_cast<CallbackState_${prefix}*>(data);`)
  lines.push(`    if (!state) return;`)
  lines.push(
    `    { std::lock_guard<std::mutex> lock(callbacks_mutex_${prefix}); callbacks_${prefix}.erase(state); }`,
  )
  lines.push(`    delete state;`)
  lines.push(`}`)
  lines.push(`static void cleanup_callbacks_${prefix}(void*) {`)
  lines.push(`    std::vector<CallbackState_${prefix}*> states;`)
  lines.push(
    `    { std::lock_guard<std::mutex> lock(callbacks_mutex_${prefix}); states.assign(callbacks_${prefix}.begin(), callbacks_${prefix}.end()); }`,
  )
  lines.push(
    `    for (auto* state : states) napi_release_threadsafe_function(state->tsfn, napi_tsfn_abort);`,
  )
  lines.push(`}`)
  lines.push(
    `static void unref_callback_delivery_${prefix}(napi_env env, CallbackState_${prefix}* state) {`,
  )
  lines.push(`    if (env && state) napi_unref_threadsafe_function(env, state->tsfn);`)
  lines.push(`}`)
  lines.push('')

  if (callbackParams.length > 0) {
    lines.push(`struct TrampolineData_${prefix} {`)
    for (let i = 0; i < callbackParams.length; i++) {
      const p = callbackParams[i]
      const category = callbackParamCategory(p.swiftType)
      if (category === 'string') {
        lines.push(`    char* arg${i};`)
        lines.push(`    size_t arg${i}_len;`)
      } else if (category === 'buffer') {
        lines.push(`    float* arg${i};`)
        lines.push(`    size_t arg${i}_len;`)
      } else {
        lines.push(`    ${cppType(p.swiftType)} arg${i};`)
      }
    }
    lines.push('};')
    lines.push('')

    lines.push(`static void cleanup_trampoline_data_${prefix}(TrampolineData_${prefix}* packed) {`)
    lines.push(`    if (!packed) return;`)
    for (let i = 0; i < callbackParams.length; i++) {
      const p = callbackParams[i]
      const category = callbackParamCategory(p.swiftType)
      if (category === 'string' || category === 'buffer') {
        lines.push(`    free(packed->arg${i});`)
      }
    }
    lines.push(`    delete packed;`)
    lines.push('}')
    lines.push('')
  }

  lines.push(
    `static void call_js_${prefix}(napi_env env, napi_value js_callback, void* context, void* data) {`,
  )
  lines.push(`    auto* state = static_cast<CallbackState_${prefix}*>(context);`)

  if (callbackParams.length === 0) {
    lines.push(`    if (env == nullptr) return;`)
    lines.push(`    napi_value global;`)
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_get_global(env, &global), "Failed to read global object")) { unref_callback_delivery_${prefix}(env, state); return; }`,
    )
    lines.push(
      `    swift_node_call_function_without_propagating_exception(env, global, js_callback, 0, nullptr);`,
    )
    lines.push(`    unref_callback_delivery_${prefix}(env, state);`)
  } else {
    lines.push(`    auto* packed = (TrampolineData_${prefix}*)data;`)
    lines.push(`    if (!packed) { unref_callback_delivery_${prefix}(env, state); return; }`)
    lines.push(`    if (env == nullptr) { cleanup_trampoline_data_${prefix}(packed); return; }`)
    lines.push(`    napi_value global;`)
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_get_global(env, &global), "Failed to read global object")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
    )
    lines.push(`    napi_value argv[${callbackParams.length}];`)

    for (let i = 0; i < callbackParams.length; i++) {
      const p = callbackParams[i]
      switch (callbackParamCategory(p.swiftType)) {
        case 'int32':
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_create_int32(env, packed->arg${i}, &argv[${i}]), "Failed to create callback argument")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
          )
          break
        case 'int64':
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_create_int64(env, packed->arg${i}, &argv[${i}]), "Failed to create callback argument")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
          )
          break
        case 'double':
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_create_double(env, packed->arg${i}, &argv[${i}]), "Failed to create callback argument")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
          )
          break
        case 'bool':
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_get_boolean(env, packed->arg${i}, &argv[${i}]), "Failed to create callback argument")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
          )
          break
        case 'string':
          if (isNullableType(p.swiftType)) {
            lines.push(`    if (!packed->arg${i}) {`)
            lines.push(
              `        if (!swift_node_napi_ok(env, napi_get_null(env, &argv[${i}]), "Failed to create callback argument")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
            )
            lines.push(`    } else {`)
            lines.push(
              `        if (!swift_node_napi_ok(env, swift_node_create_string(env, packed->arg${i}, packed->arg${i}_len, &argv[${i}]), "Failed to create callback argument")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
            )
            lines.push(`    }`)
          } else {
            lines.push(
              `    if (!swift_node_napi_ok(env, swift_node_create_string(env, packed->arg${i}, packed->arg${i}_len, &argv[${i}]), "Failed to create callback argument")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
            )
          }
          break
        case 'buffer':
          lines.push(`    void* buf_data_${i};`)
          lines.push(`    napi_value ab_${i};`)
          lines.push(`    size_t byte_len_${i} = packed->arg${i}_len * sizeof(float);`)
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_create_arraybuffer(env, byte_len_${i}, &buf_data_${i}, &ab_${i}), "Failed to create callback ArrayBuffer")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
          )
          lines.push(
            `    if (byte_len_${i} > 0) memcpy(buf_data_${i}, packed->arg${i}, byte_len_${i});`,
          )
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_create_typedarray(env, napi_float32_array, packed->arg${i}_len, ab_${i}, 0, &argv[${i}]), "Failed to create callback typed array")) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(env, state); return; }`,
          )
          break
      }
    }

    lines.push(
      `    swift_node_call_function_without_propagating_exception(env, global, js_callback, ${callbackParams.length}, argv);`,
    )
    lines.push(`    cleanup_trampoline_data_${prefix}(packed);`)
    lines.push(`    unref_callback_delivery_${prefix}(env, state);`)
  }
  lines.push('}')
  lines.push('')

  const trampolineParams = [
    'void* callback_context',
    ...callbackParams.map((p, i) => {
      const category = callbackParamCategory(p.swiftType)
      if (category === 'string') return `const char* arg${i}, int64_t arg${i}_len`
      if (category === 'buffer') return `const float* arg${i}, int32_t arg${i}_count`
      return `${cppTypeFromCategory(category)} arg${i}`
    }),
  ].join(', ')

  lines.push(`static void trampoline_${prefix}(${trampolineParams}) {`)
  lines.push(`    auto* state = static_cast<CallbackState_${prefix}*>(callback_context);`)
  lines.push(`    if (!state || napi_acquire_threadsafe_function(state->tsfn) != napi_ok) return;`)
  lines.push(
    `    if (napi_ref_threadsafe_function(state->env, state->tsfn) != napi_ok) { napi_release_threadsafe_function(state->tsfn, napi_tsfn_release); return; }`,
  )

  if (callbackParams.length === 0) {
    lines.push(
      `    napi_status call_status = napi_call_threadsafe_function(state->tsfn, nullptr, napi_tsfn_nonblocking);`,
    )
    lines.push(
      `    if (call_status != napi_ok) unref_callback_delivery_${prefix}(state->env, state);`,
    )
    lines.push(`    napi_release_threadsafe_function(state->tsfn, napi_tsfn_release);`)
  } else {
    lines.push(`    auto* packed = new TrampolineData_${prefix}();`)
    for (let i = 0; i < callbackParams.length; i++) {
      const p = callbackParams[i]
      const category = callbackParamCategory(p.swiftType)
      if (category === 'string') {
        lines.push(`    packed->arg${i}_len = static_cast<size_t>(arg${i}_len);`)
        lines.push(
          `    packed->arg${i} = arg${i} ? (char*)malloc(packed->arg${i}_len + 1) : nullptr;`,
        )
        lines.push(
          `    if (arg${i} && !packed->arg${i}) { cleanup_trampoline_data_${prefix}(packed); napi_release_threadsafe_function(state->tsfn, napi_tsfn_release); return; }`,
        )
        lines.push(
          `    if (arg${i}) { memcpy(packed->arg${i}, arg${i}, packed->arg${i}_len); packed->arg${i}[packed->arg${i}_len] = '\\0'; }`,
        )
      } else if (category === 'buffer') {
        lines.push(`    packed->arg${i}_len = (size_t)arg${i}_count;`)
        lines.push(`    packed->arg${i} = (float*)malloc(packed->arg${i}_len * sizeof(float));`)
        lines.push(
          `    if (packed->arg${i}_len > 0 && !packed->arg${i}) { cleanup_trampoline_data_${prefix}(packed); napi_release_threadsafe_function(state->tsfn, napi_tsfn_release); return; }`,
        )
        lines.push(
          `    if (packed->arg${i}_len > 0) memcpy(packed->arg${i}, arg${i}, packed->arg${i}_len * sizeof(float));`,
        )
      } else {
        lines.push(`    packed->arg${i} = arg${i};`)
      }
    }
    lines.push(
      `    napi_status call_status = napi_call_threadsafe_function(state->tsfn, packed, napi_tsfn_nonblocking);`,
    )
    lines.push(
      `    if (call_status != napi_ok) { cleanup_trampoline_data_${prefix}(packed); unref_callback_delivery_${prefix}(state->env, state); }`,
    )
    lines.push(`    napi_release_threadsafe_function(state->tsfn, napi_tsfn_release);`)
  }

  lines.push('}')

  return lines.join('\n')
}

function generateJsWrapper(
  fn: SwiftFunction,
  moduleName: string,
  structs: SwiftStruct[] = [],
): string {
  if (getCallbackParam(fn)) {
    return generateCallbackWrapper(fn)
  }

  if (fn.isAsync) {
    return generateAsyncWrapper(fn)
  }

  return generateSyncWrapper(fn, structs)
}

function generateSyncWrapper(fn: SwiftFunction, structs: SwiftStruct[] = []): string {
  const jsP = jsParams(fn)
  const hasError = hasErrorOutParam(fn)
  const retCat = classifySwiftType(fn.returnType)
  const cleanupInputs = jsP.some((p) => needsInputCleanup(p, structs))
  const lines: string[] = []

  lines.push(`static napi_value js_${fn.symbolName}(napi_env env, napi_callback_info info) {`)

  // Extract arguments
  if (jsP.length > 0) {
    lines.push(`    size_t argc = ${jsP.length};`)
    lines.push(`    napi_value argv[${jsP.length}];`)
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Failed to read callback info")) return nullptr;`,
    )
    lines.push(`    if (!swift_node_expect_argc(env, argc, ${jsP.length})) return nullptr;`)
    lines.push('')
    generateArgConversions(
      lines,
      jsP,
      structs,
      cleanupInputs ? 'swift_node_cleanup_args' : undefined,
    )
    lines.push('')
  } else {
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, nullptr, nullptr, nullptr, nullptr), "Failed to read callback info")) return nullptr;`,
    )
    lines.push('')
  }

  // Call Swift function
  const hasStringResultLength = fn.params.some((p) => p.bridgeStringResultLength)
  if (hasStringResultLength) lines.push('    int64_t result_len = 0;')
  const callArgs = fn.params
    .map((p) => {
      if (p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>')) return '&swift_error'
      if (p.bridgeStringLengthFor) return `${cppIdentifier(p.bridgeStringLengthFor)}_len`
      if (p.bridgeStringResultLength) return '&result_len'
      if (p.bridgeBorrowedBufferLengthFor)
        return `static_cast<int64_t>(${cppIdentifier(p.bridgeBorrowedBufferLengthFor)}_len)`
      return cppIdentifier(p.name)
    })
    .join(', ')

  if (hasError) lines.push('    const char* swift_error = nullptr;')

  // Handle struct return type
  const retStruct = findStruct(fn.returnType, structs)
  if (retCat === 'void') {
    lines.push(`    ${fn.symbolName}(${callArgs});`)
  } else if (retStruct) {
    lines.push(`    swift_node_${retStruct.name} result = ${fn.symbolName}(${callArgs});`)
  } else {
    lines.push(`    ${cppReturnType(fn.returnType)} result = ${fn.symbolName}(${callArgs});`)
  }

  // Free string input buffers and struct string fields
  if (cleanupInputs) {
    lines.push('    swift_node_cleanup_args();')
  } else {
    for (const p of jsP) {
      const name = cppIdentifier(p.name)
      if (classifySwiftType(p.type) === 'string') {
        lines.push(`    delete[] ${name};`)
      }
      const pStructFree = findStruct(p.type, structs)
      if (pStructFree && pStructFree.fields.some((f) => f.category === 'string')) {
        lines.push(`    ${pStructFree.name}_free_strings(${name});`)
      }
    }
  }

  if (hasError) {
    lines.push('')
    lines.push('    if (swift_error) {')
    if (retCat === 'string') lines.push('        free(const_cast<char*>(result));')
    lines.push('        return throw_swift_error(env, swift_error);')
    lines.push('    }')
  }

  // Convert return value to JS
  lines.push('')
  generateReturnConversion(
    lines,
    fn.returnType,
    retCat,
    structs,
    fn.returnTransport,
    hasStringResultLength ? 'result_len' : undefined,
  )

  lines.push('}')
  return lines.join('\n')
}

function generateAsyncWrapper(fn: SwiftFunction): string {
  const jsP = jsParams(fn)
  const retCat = classifySwiftType(fn.returnType)
  const hasError = hasErrorOutParam(fn)
  const hasStringResultLength = fn.params.some((p) => p.bridgeStringResultLength)
  const prefix = fn.symbolName
  const lines: string[] = []

  // Async data struct
  lines.push(`struct AsyncData_${prefix} {`)
  lines.push(`    napi_async_work work;`)
  lines.push(`    napi_deferred deferred;`)
  if (hasError) lines.push(`    const char* swift_error;`)
  for (const p of jsP) {
    const name = cppIdentifier(p.name)
    const cat = classifySwiftType(p.type)
    if (cat === 'string') {
      lines.push(`    char* ${name};`)
      lines.push(`    size_t ${name}_len;`)
    } else {
      lines.push(`    ${cppType(p.type)} ${name};`)
    }
  }
  if (hasStringResultLength) lines.push('    int64_t result_len;')
  if (retCat !== 'void') {
    lines.push(`    ${cppReturnType(fn.returnType)} result;`)
  }
  lines.push('};')
  lines.push('')

  // Execute callback (runs on libuv thread pool)
  lines.push(`static void execute_${prefix}(napi_env env, void* data) {`)
  lines.push(`    auto* ctx = (AsyncData_${prefix}*)data;`)
  const callArgs = fn.params
    .map((p) => {
      if (p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>')) return '&ctx->swift_error'
      if (p.bridgeStringLengthFor) return `ctx->${cppIdentifier(p.bridgeStringLengthFor)}_len`
      if (p.bridgeStringResultLength) return '&ctx->result_len'
      return `ctx->${cppIdentifier(p.name)}`
    })
    .join(', ')
  if (retCat === 'void') {
    lines.push(`    ${fn.symbolName}(${callArgs});`)
  } else {
    lines.push(`    ctx->result = ${fn.symbolName}(${callArgs});`)
  }
  lines.push('}')
  lines.push('')

  // Complete callback (runs on Node event loop thread)
  lines.push(`static void complete_${prefix}(napi_env env, napi_status status, void* data) {`)
  lines.push(`    auto* ctx = (AsyncData_${prefix}*)data;`)

  // Free input strings
  for (const p of jsP) {
    if (classifySwiftType(p.type) === 'string') {
      lines.push(`    free(ctx->${cppIdentifier(p.name)});`)
    }
  }

  if (hasError) {
    lines.push('    if (ctx->swift_error) {')
    lines.push('        napi_value message;')
    lines.push(
      '        bool message_ok = swift_node_napi_ok(env, swift_node_create_string(env, ctx->swift_error, &message), "Failed to create Swift error message");',
    )
    lines.push('        free(const_cast<char*>(ctx->swift_error));')
    lines.push('        if (message_ok) {')
    lines.push('            napi_value error;')
    lines.push(
      '            if (swift_node_napi_ok(env, napi_create_error(env, nullptr, message, &error), "Failed to create Swift error")) napi_reject_deferred(env, ctx->deferred, error);',
    )
    lines.push('        }')
    if (retCat === 'string') lines.push('        free(const_cast<char*>(ctx->result));')
    lines.push(`        napi_delete_async_work(env, ctx->work);`)
    lines.push('        delete ctx;')
    lines.push('        return;')
    lines.push('    }')
  }

  if (retCat === 'void') {
    lines.push('    napi_value undefined;')
    lines.push('    napi_get_undefined(env, &undefined);')
    lines.push('    napi_resolve_deferred(env, ctx->deferred, undefined);')
  } else {
    // Convert the result into js_result, recording success rather than
    // returning early — the cleanup below must run on every path, and a failed
    // conversion must reject (not strand) the promise.
    lines.push('    napi_value js_result;')
    lines.push('    bool result_ok;')
    switch (retCat) {
      case 'int32':
        lines.push(
          '    result_ok = swift_node_napi_ok(env, napi_create_int32(env, ctx->result, &js_result), "Failed to create integer return value");',
        )
        break
      case 'int64':
        lines.push(
          '    result_ok = swift_node_napi_ok(env, napi_create_int64(env, ctx->result, &js_result), "Failed to create integer return value");',
        )
        break
      case 'double':
        lines.push(
          '    result_ok = swift_node_napi_ok(env, napi_create_double(env, ctx->result, &js_result), "Failed to create number return value");',
        )
        break
      case 'bool':
        lines.push(
          '    result_ok = swift_node_napi_ok(env, napi_get_boolean(env, ctx->result, &js_result), "Failed to create boolean return value");',
        )
        break
      case 'string':
        if (fn.returnTransport === 'json') {
          lines.push('    result_ok = swift_node_json_parse(env, ctx->result, &js_result);')
          lines.push('    free(const_cast<char*>(ctx->result));')
          break
        }
        if (fn.returnTransport === 'data') {
          lines.push('    std::vector<uint8_t> swift_node_result_bytes;')
          lines.push(
            '    result_ok = swift_node_base64_decode(ctx->result, &swift_node_result_bytes) && swift_node_napi_ok(env, napi_create_buffer_copy(env, swift_node_result_bytes.size(), swift_node_result_bytes.data(), nullptr, &js_result), "Failed to create Data return buffer");',
          )
          lines.push('    free(const_cast<char*>(ctx->result));')
          break
        }
        if (fn.returnType.endsWith('?')) {
          lines.push('    if (!ctx->result) {')
          lines.push(
            '        result_ok = swift_node_napi_ok(env, napi_get_null(env, &js_result), "Failed to create null return value");',
          )
          lines.push('    } else {')
          lines.push(
            `        result_ok = swift_node_napi_ok(env, swift_node_create_string(env, ctx->result, ${hasStringResultLength ? 'static_cast<size_t>(ctx->result_len)' : 'strlen(ctx->result)'}, &js_result), "Failed to create string return value");`,
          )
          lines.push('        free(const_cast<char*>(ctx->result));')
          lines.push('    }')
        } else {
          lines.push(
            `    result_ok = swift_node_napi_ok(env, swift_node_create_string(env, ctx->result, ${hasStringResultLength ? 'static_cast<size_t>(ctx->result_len)' : 'strlen(ctx->result)'}, &js_result), "Failed to create string return value");`,
          )
          lines.push('    free(const_cast<char*>(ctx->result));')
        }
        break
    }
    lines.push('    if (result_ok) {')
    lines.push('        napi_resolve_deferred(env, ctx->deferred, js_result);')
    lines.push('    } else {')
    lines.push('        napi_value err;')
    lines.push('        if (napi_get_and_clear_last_exception(env, &err) == napi_ok) {')
    lines.push('            napi_reject_deferred(env, ctx->deferred, err);')
    lines.push('        }')
    lines.push('    }')
  }

  lines.push(`    napi_delete_async_work(env, ctx->work);`)
  lines.push('    delete ctx;')
  lines.push('}')
  lines.push('')

  // Cleanup helpers for the entry wrapper's failure paths. destroy_async frees
  // any copied string inputs and the context; reject_async additionally settles
  // an already-created Promise so it is never left pending.
  lines.push(`static void destroy_async_${prefix}(AsyncData_${prefix}* ctx) {`)
  for (const p of jsP) {
    if (classifySwiftType(p.type) === 'string') {
      lines.push(`    free(ctx->${cppIdentifier(p.name)});`)
    }
  }
  lines.push('    delete ctx;')
  lines.push('}')
  lines.push('')
  lines.push(
    `static napi_value reject_async_${prefix}(napi_env env, AsyncData_${prefix}* ctx, napi_value promise) {`,
  )
  lines.push('    napi_value err;')
  lines.push('    if (napi_get_and_clear_last_exception(env, &err) == napi_ok) {')
  lines.push('        napi_reject_deferred(env, ctx->deferred, err);')
  lines.push('    }')
  lines.push(`    destroy_async_${prefix}(ctx);`)
  lines.push('    return promise;')
  lines.push('}')
  lines.push('')

  // JS entry point — validates args, then creates Promise and queues work
  lines.push(`static napi_value js_${fn.symbolName}(napi_env env, napi_callback_info info) {`)

  if (jsP.length > 0) {
    lines.push(`    size_t argc = ${jsP.length};`)
    lines.push(`    napi_value argv[${jsP.length}];`)
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Failed to read callback info")) return nullptr;`,
    )
    lines.push(`    if (!swift_node_expect_argc(env, argc, ${jsP.length})) return nullptr;`)
    lines.push('')
  } else {
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, nullptr, nullptr, nullptr, nullptr), "Failed to read callback info")) return nullptr;`,
    )
    lines.push('')
  }

  // Allocate async data and validate + copy inputs BEFORE creating the Promise,
  // so an invalid argument throws synchronously without leaking ctx or leaving a
  // pending Promise. Every failure after this point frees ctx.
  lines.push(`    auto* ctx = new AsyncData_${prefix}{};`)
  if (hasError) lines.push('    ctx->swift_error = nullptr;')

  for (let i = 0; i < jsP.length; i++) {
    const p = jsP[i]
    const cat = classifySwiftType(p.type)
    const name = cppIdentifier(p.name)
    const fail = `{ destroy_async_${prefix}(ctx); return nullptr; }`
    if (p.transport === 'json') {
      generateOptionalJsonScalarValidation(lines, p, i, undefined, fail)
      lines.push(`    napi_value ${name}_json;`)
      lines.push(`    if (!swift_node_json_stringify(env, argv[${i}], &${name}_json)) ${fail}`)
      lines.push(`    size_t ${name}_len;`)
      lines.push(
        `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, ${name}_json, nullptr, 0, &${name}_len), "Failed to read JSON argument length")) ${fail}`,
      )
      lines.push(`    ctx->${name} = (char*)malloc(${name}_len + 1);`)
      lines.push(
        `    if (!ctx->${name}) { destroy_async_${prefix}(ctx); return swift_node_throw_type_error(env, "Out of memory"); }`,
      )
      lines.push(
        `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, ${name}_json, ctx->${name}, ${name}_len + 1, &${name}_len), "Failed to read JSON argument")) ${fail}`,
      )
      continue
    }
    if (p.transport === 'data') {
      lines.push(
        `    if (!swift_node_is_buffer_or_typedarray(env, argv[${i}], "Expected argument '${p.name}' to be a Uint8Array or Buffer")) ${fail}`,
      )
      lines.push(`    void* ${name}_data; size_t ${name}_len;`)
      lines.push(
        `    if (!swift_node_get_binary_data(env, argv[${i}], &${name}_data, &${name}_len)) ${fail}`,
      )
      lines.push(
        `    std::string ${name}_base64 = swift_node_base64_encode((const uint8_t*)${name}_data, ${name}_len);`,
      )
      lines.push(`    ctx->${name} = (char*)malloc(${name}_base64.size() + 1);`)
      lines.push(
        `    if (!ctx->${name}) { destroy_async_${prefix}(ctx); return swift_node_throw_type_error(env, "Out of memory"); }`,
      )
      lines.push(`    memcpy(ctx->${name}, ${name}_base64.c_str(), ${name}_base64.size() + 1);`)
      continue
    }
    switch (cat) {
      case 'int32':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
        )
        lines.push(
          `    if (!swift_node_get_int32(env, argv[${i}], &ctx->${cppIdentifier(p.name)}, "Failed to read integer argument")) ${fail}`,
        )
        break
      case 'int64':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
        )
        lines.push(
          `    if (!swift_node_get_int64(env, argv[${i}], &ctx->${cppIdentifier(p.name)}, "Failed to read integer argument")) ${fail}`,
        )
        break
      case 'double':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
        )
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_double(env, argv[${i}], &ctx->${name}), "Failed to read number argument")) ${fail}`,
        )
        break
      case 'bool':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_boolean, "Expected argument '${p.name}' to be a boolean")) ${fail}`,
        )
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_bool(env, argv[${i}], &ctx->${name}), "Failed to read boolean argument")) ${fail}`,
        )
        break
      case 'string':
        if (p.type.endsWith('?')) {
          lines.push(`    napi_valuetype ${name}_type;`)
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_typeof(env, argv[${i}], &${name}_type), "Failed to inspect argument type")) ${fail}`,
          )
          lines.push(`    if (${name}_type != napi_null) {`)
          lines.push(
            `        if (${name}_type != napi_string) { destroy_async_${prefix}(ctx); return swift_node_throw_type_error(env, "Expected argument '${p.name}' to be a string or null"); }`,
          )
          lines.push(`        size_t ${name}_len;`)
          lines.push(
            `        if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], nullptr, 0, &${name}_len), "Failed to read string argument length")) ${fail}`,
          )
          lines.push(`        ctx->${name} = (char*)malloc(${name}_len + 1);`)
          lines.push(
            `        if (!ctx->${name}) { destroy_async_${prefix}(ctx); return swift_node_throw_type_error(env, "Out of memory"); }`,
          )
          lines.push(
            `        if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], ctx->${name}, ${name}_len + 1, &${name}_len), "Failed to read string argument")) ${fail}`,
          )
          lines.push(`        ctx->${name}_len = ${name}_len;`)
          lines.push(`    }`)
          break
        }
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_string, "Expected argument '${p.name}' to be a string")) ${fail}`,
        )
        lines.push(`    size_t ${name}_len;`)
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], nullptr, 0, &${name}_len), "Failed to read string argument length")) ${fail}`,
        )
        lines.push(`    ctx->${name} = (char*)malloc(${name}_len + 1);`)
        lines.push(
          `    if (!ctx->${name}) { destroy_async_${prefix}(ctx); return swift_node_throw_type_error(env, "Out of memory"); }`,
        )
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], ctx->${name}, ${name}_len + 1, &${name}_len), "Failed to read string argument")) ${fail}`,
        )
        lines.push(`    ctx->${name}_len = ${name}_len;`)
        break
    }
  }

  lines.push('')
  lines.push('    napi_value promise;')
  lines.push('    napi_deferred deferred;')
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_promise(env, &deferred, &promise), "Failed to create promise")) { destroy_async_${prefix}(ctx); return nullptr; }`,
  )
  lines.push('    ctx->deferred = deferred;')
  lines.push('')
  lines.push('    napi_value resource_name;')
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_string_utf8(env, "swift_node_async", NAPI_AUTO_LENGTH, &resource_name), "Failed to create async resource name")) return reject_async_${prefix}(env, ctx, promise);`,
  )
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_async_work(env, nullptr, resource_name, execute_${prefix}, complete_${prefix}, ctx, &ctx->work), "Failed to create async work")) return reject_async_${prefix}(env, ctx, promise);`,
  )
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_queue_async_work(env, ctx->work), "Failed to queue async work")) { napi_delete_async_work(env, ctx->work); return reject_async_${prefix}(env, ctx, promise); }`,
  )
  lines.push('')
  lines.push('    return promise;')
  lines.push('}')

  return lines.join('\n')
}

function generateCallbackWrapper(fn: SwiftFunction): string {
  const jsP = jsParams(fn)
  const retCat = classifySwiftType(fn.returnType)
  const hasError = fn.params.some((p) =>
    p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>'),
  )
  const hasStringResultLength = fn.params.some((p) => p.bridgeStringResultLength)
  const prefix = fn.symbolName
  const nonCbParams = jsP.filter((p) => !isCallbackType(p.type))
  const stringParams = nonCbParams.filter((p) => classifySwiftType(p.type) === 'string')
  const lines: string[] = []

  // Always use the generated call_js for this specific function
  const callJsFn = `call_js_${prefix}`

  lines.push(`static napi_value js_${fn.symbolName}(napi_env env, napi_callback_info info) {`)
  lines.push(`    size_t argc = ${jsP.length};`)
  lines.push(`    napi_value argv[${jsP.length}];`)
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Failed to read callback info")) return nullptr;`,
  )
  lines.push(`    if (!swift_node_expect_argc(env, argc, ${jsP.length})) return nullptr;`)
  lines.push('')

  // Hoist string inputs and a flag tracking whether THIS call created the
  // threadsafe function, so a later argument failing validation can free the
  // inputs and abort a tsfn we created — without aborting a callback still
  // registered by a previous call.
  for (const p of stringParams) {
    const name = cppIdentifier(p.name)
    lines.push(`    char* ${name} = nullptr;`)
    lines.push(`    size_t ${name}_len = 0;`)
  }
  lines.push(`    CallbackState_${prefix}* callback_state = nullptr;`)
  lines.push(`    bool tsfn_created = false;`)
  lines.push(`    auto cleanup_args = [&]() {`)
  for (const p of stringParams) {
    lines.push(`        delete[] ${cppIdentifier(p.name)};`)
  }
  lines.push(`        if (tsfn_created) {`)
  lines.push(`            napi_release_threadsafe_function(callback_state->tsfn, napi_tsfn_abort);`)
  lines.push(`            callback_state = nullptr;`)
  lines.push(`        }`)
  lines.push(`    };`)
  lines.push('')

  const fail = '{ cleanup_args(); return nullptr; }'

  // Convert arguments
  for (let i = 0; i < jsP.length; i++) {
    const p = jsP[i]
    if (isCallbackType(p.type)) {
      // Create threadsafe function from JS callback
      lines.push(
        `    if (!swift_node_expect_type(env, argv[${i}], napi_function, "Expected argument '${p.name}' to be a function")) ${fail}`,
      )
      lines.push(`    napi_value resource_name;`)
      lines.push(
        `    if (!swift_node_napi_ok(env, napi_create_string_utf8(env, "swift_node_cb_${prefix}", NAPI_AUTO_LENGTH, &resource_name), "Failed to create callback resource name")) ${fail}`,
      )
      lines.push(`    callback_state = new CallbackState_${prefix}();`)
      lines.push(`    callback_state->env = env;`)
      lines.push(
        `    if (!swift_node_napi_ok(env, napi_create_threadsafe_function(env, argv[${i}], nullptr, resource_name, 0, 1, callback_state, finalize_callback_${prefix}, callback_state, ${callJsFn}, &callback_state->tsfn), "Failed to create threadsafe callback")) { delete callback_state; callback_state = nullptr; cleanup_args(); return nullptr; }`,
      )
      lines.push(`    tsfn_created = true;`)
      lines.push(
        `    if (!swift_node_napi_ok(env, napi_unref_threadsafe_function(env, callback_state->tsfn), "Failed to unref threadsafe callback")) ${fail}`,
      )
    } else {
      const cat = classifySwiftType(p.type)
      switch (cat) {
        case 'int32': {
          const name = cppIdentifier(p.name)
          lines.push(
            `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
          )
          lines.push(`    int32_t ${name};`)
          lines.push(
            `    if (!swift_node_get_int32(env, argv[${i}], &${name}, "Failed to read integer argument")) ${fail}`,
          )
          break
        }
        case 'int64': {
          const name = cppIdentifier(p.name)
          lines.push(
            `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
          )
          lines.push(`    int64_t ${name};`)
          lines.push(
            `    if (!swift_node_get_int64(env, argv[${i}], &${name}, "Failed to read integer argument")) ${fail}`,
          )
          break
        }
        case 'double': {
          const name = cppIdentifier(p.name)
          lines.push(
            `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
          )
          lines.push(`    double ${name};`)
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_get_value_double(env, argv[${i}], &${name}), "Failed to read number argument")) ${fail}`,
          )
          break
        }
        case 'bool': {
          const name = cppIdentifier(p.name)
          lines.push(
            `    if (!swift_node_expect_type(env, argv[${i}], napi_boolean, "Expected argument '${p.name}' to be a boolean")) ${fail}`,
          )
          lines.push(`    bool ${name};`)
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_get_value_bool(env, argv[${i}], &${name}), "Failed to read boolean argument")) ${fail}`,
          )
          break
        }
        case 'string': {
          const name = cppIdentifier(p.name)
          if (p.type.endsWith('?')) {
            lines.push(`    napi_valuetype ${name}_type;`)
            lines.push(
              `    if (!swift_node_napi_ok(env, napi_typeof(env, argv[${i}], &${name}_type), "Failed to inspect argument type")) ${fail}`,
            )
            lines.push(`    if (${name}_type != napi_null) {`)
            lines.push(
              `        if (${name}_type != napi_string) { cleanup_args(); return swift_node_throw_type_error(env, "Expected argument '${p.name}' to be a string or null"); }`,
            )
            lines.push(
              `        if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], nullptr, 0, &${name}_len), "Failed to read string argument length")) ${fail}`,
            )
            lines.push(`        ${name} = new char[${name}_len + 1];`)
            lines.push(
              `        if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], ${name}, ${name}_len + 1, &${name}_len), "Failed to read string argument")) ${fail}`,
            )
            lines.push(`    }`)
            break
          }
          lines.push(
            `    if (!swift_node_expect_type(env, argv[${i}], napi_string, "Expected argument '${p.name}' to be a string")) ${fail}`,
          )
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], nullptr, 0, &${name}_len), "Failed to read string argument length")) ${fail}`,
          )
          lines.push(`    ${name} = new char[${name}_len + 1];`)
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], ${name}, ${name}_len + 1, &${name}_len), "Failed to read string argument")) ${fail}`,
          )
          break
        }
      }
    }
  }

  lines.push('')
  lines.push(
    `    { std::lock_guard<std::mutex> lock(callbacks_mutex_${prefix}); callbacks_${prefix}.insert(callback_state); }`,
  )
  lines.push(`    tsfn_created = false;`)
  lines.push('')

  // Call Swift function, passing trampoline instead of callback
  if (hasStringResultLength) lines.push('    int64_t result_len = 0;')
  if (hasError) lines.push('    const char* swift_error = nullptr;')
  const callArgs = fn.params
    .map((p) => {
      if (p.promiseCallbackRelease) return `release_callback_${prefix}`
      if (isCallbackType(p.type)) return `trampoline_${prefix}`
      if (p.callbackContext) return 'callback_state'
      if (p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>')) return '&swift_error'
      if (p.bridgeStringLengthFor) return `${cppIdentifier(p.bridgeStringLengthFor)}_len`
      if (p.bridgeStringResultLength) return '&result_len'
      return cppIdentifier(p.name)
    })
    .join(', ')

  if (retCat === 'void') {
    lines.push(`    ${fn.symbolName}(${callArgs});`)
  } else {
    lines.push(`    ${cppReturnType(fn.returnType)} result = ${fn.symbolName}(${callArgs});`)
  }

  // Free string input buffers
  for (const p of stringParams) {
    lines.push(`    delete[] ${cppIdentifier(p.name)};`)
  }

  if (hasError) {
    lines.push('    if (swift_error) {')
    if (retCat === 'string') lines.push('        free(const_cast<char*>(result));')
    lines.push('        return throw_swift_error(env, swift_error);')
    lines.push('    }')
  }

  lines.push('')
  generateReturnConversion(
    lines,
    fn.returnType,
    retCat,
    [],
    undefined,
    hasStringResultLength ? 'result_len' : undefined,
  )

  lines.push('}')
  return lines.join('\n')
}

// --- Shared helpers ---

function structHasStringFields(s: SwiftStruct | undefined): boolean {
  return !!s && s.fields.some((f) => f.category === 'string')
}

function needsInputCleanup(p: SwiftParam, structs: SwiftStruct[]): boolean {
  return (
    classifySwiftType(p.type) === 'string' || structHasStringFields(findStruct(p.type, structs))
  )
}

function declareArgLocal(lines: string[], p: SwiftParam, structs: SwiftStruct[]): void {
  const name = cppIdentifier(p.name)
  if (p.transport === 'borrowed') {
    lines.push(`    void* ${name} = nullptr;`)
    lines.push(`    size_t ${name}_len = 0;`)
    return
  }
  const structDef = findStruct(p.type, structs)
  if (structDef) {
    lines.push(`    swift_node_${structDef.name} ${name}{};`)
    lines.push(`    bool ${name}_ok = false;`)
    return
  }

  switch (classifySwiftType(p.type)) {
    case 'int32':
      lines.push(`    int32_t ${name};`)
      break
    case 'int64':
      lines.push(`    int64_t ${name};`)
      break
    case 'double':
      lines.push(`    double ${name};`)
      break
    case 'bool':
      lines.push(`    bool ${name};`)
      break
    case 'string':
      lines.push(`    char* ${name} = nullptr;`)
      break
  }
}

function generateInputCleanup(
  lines: string[],
  params: SwiftParam[],
  structs: SwiftStruct[],
  cleanupName: string,
): void {
  for (const p of params) {
    declareArgLocal(lines, p, structs)
  }
  lines.push(`    auto ${cleanupName} = [&]() {`)
  for (const p of params) {
    const name = cppIdentifier(p.name)
    if (classifySwiftType(p.type) === 'string') {
      lines.push(`        delete[] ${name};`)
    }
    const structDef = findStruct(p.type, structs)
    if (structHasStringFields(structDef)) {
      lines.push(`        if (${name}_ok) ${structDef!.name}_free_strings(${name});`)
    }
  }
  lines.push('    };')
}

function failureReturn(cleanupName?: string): string {
  return cleanupName ? `{ ${cleanupName}(); return nullptr; }` : 'return nullptr;'
}

function typeErrorReturn(msg: string, cleanupName?: string): string {
  const throwExpr = `swift_node_throw_type_error(env, ${JSON.stringify(msg)})`
  return cleanupName ? `{ ${cleanupName}(); return ${throwExpr}; }` : `return ${throwExpr};`
}

/**
 * Optional scalar values use the JSON transport because C does not have a
 * portable Optional ABI. Validate values that JSON would otherwise coerce
 * before serializing them: JSON.stringify turns NaN/Infinity into null and a
 * JS Number beyond the safe-integer range has already lost its Int precision.
 */
function generateOptionalJsonScalarValidation(
  lines: string[],
  param: SwiftParam,
  argumentIndex: number,
  cleanupName?: string,
  failExpression?: string,
): void {
  if (param.transport !== 'json') return
  const nativeType = (param.nativeType || '').replace(/\s+/g, '')
  if (!nativeType.endsWith('?')) return

  const base = nativeType.slice(0, -1)
  const category =
    base === 'Int32'
      ? 'int32'
      : base === 'Int' || base === 'Int64'
        ? 'int64'
        : base === 'Double' || base === 'Float'
          ? 'double'
          : null
  if (!category) return

  const name = cppIdentifier(param.name)
  const fail = failExpression || failureReturn(cleanupName)
  lines.push(`    napi_valuetype ${name}_type;`)
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_typeof(env, argv[${argumentIndex}], &${name}_type), "Failed to inspect argument type")) ${fail}`,
  )
  lines.push(`    if (${name}_type != napi_null) {`)
  lines.push(
    `        if (!swift_node_expect_type(env, argv[${argumentIndex}], napi_number, "Expected argument '${param.name}' to be a number or null")) ${fail}`,
  )
  if (category === 'int32') {
    lines.push(`        int32_t ${name}_validated;`)
    lines.push(
      `        if (!swift_node_get_int32(env, argv[${argumentIndex}], &${name}_validated, "Failed to read integer argument")) ${fail}`,
    )
  } else if (category === 'int64') {
    lines.push(`        int64_t ${name}_validated;`)
    lines.push(
      `        if (!swift_node_get_int64(env, argv[${argumentIndex}], &${name}_validated, "Failed to read integer argument")) ${fail}`,
    )
  } else {
    lines.push(`        double ${name}_validated;`)
    lines.push(
      `        if (!swift_node_napi_ok(env, napi_get_value_double(env, argv[${argumentIndex}], &${name}_validated), "Failed to read number argument")) ${fail}`,
    )
    lines.push(
      `        if (!std::isfinite(${name}_validated)) { napi_throw_range_error(env, nullptr, "Expected a finite number"); ${fail} }`,
    )
  }
  lines.push('    }')
}

function generateArgConversions(
  lines: string[],
  params: SwiftParam[],
  structs: SwiftStruct[] = [],
  cleanupName?: string,
): void {
  if (cleanupName) {
    generateInputCleanup(lines, params, structs, cleanupName)
  }

  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    const name = cppIdentifier(p.name)
    const fail = failureReturn(cleanupName)

    // Check for struct type first
    const structDef = findStruct(p.type, structs)
    if (structDef) {
      if (!cleanupName) {
        lines.push(`    bool ${name}_ok = false;`)
        lines.push(
          `    swift_node_${structDef.name} ${name} = ${structDef.name}_from_js(env, argv[${i}], &${name}_ok);`,
        )
      } else {
        lines.push(`    ${name} = ${structDef.name}_from_js(env, argv[${i}], &${name}_ok);`)
      }
      lines.push(`    if (!${name}_ok) ${fail}`)
      continue
    }

    const cat = classifySwiftType(p.type)
    if (p.transport === 'json') {
      generateOptionalJsonScalarValidation(lines, p, i, cleanupName)
      lines.push(`    napi_value ${name}_json;`)
      lines.push(`    if (!swift_node_json_stringify(env, argv[${i}], &${name}_json)) ${fail}`)
      lines.push(`    size_t ${name}_len;`)
      lines.push(
        `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, ${name}_json, nullptr, 0, &${name}_len), "Failed to read JSON argument length")) ${fail}`,
      )
      if (cleanupName) lines.push(`    ${name} = new char[${name}_len + 1];`)
      else lines.push(`    char* ${name} = new char[${name}_len + 1];`)
      lines.push(
        `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, ${name}_json, ${name}, ${name}_len + 1, &${name}_len), "Failed to read JSON argument")) ${fail}`,
      )
      continue
    }
    if (p.transport === 'data') {
      lines.push(
        `    if (!swift_node_is_buffer_or_typedarray(env, argv[${i}], "Expected argument '${p.name}' to be a Uint8Array or Buffer")) ${fail}`,
      )
      lines.push(`    void* ${name}_data; size_t ${name}_len;`)
      lines.push(
        `    if (!swift_node_get_binary_data(env, argv[${i}], &${name}_data, &${name}_len)) ${fail}`,
      )
      lines.push(
        `    std::string ${name}_base64 = swift_node_base64_encode((const uint8_t*)${name}_data, ${name}_len);`,
      )
      if (cleanupName) lines.push(`    ${name} = new char[${name}_base64.size() + 1];`)
      else lines.push(`    char* ${name} = new char[${name}_base64.size() + 1];`)
      lines.push(`    memcpy(${name}, ${name}_base64.c_str(), ${name}_base64.size() + 1);`)
      continue
    }
    if (p.transport === 'borrowed') {
      if (!cleanupName) {
        lines.push(`    void* ${name} = nullptr;`)
        lines.push(`    size_t ${name}_len = 0;`)
      }
      lines.push(
        `    if (!swift_node_is_buffer_or_typedarray(env, argv[${i}], "Expected argument '${p.name}' to be a Uint8Array or Buffer")) ${fail}`,
      )
      lines.push(
        `    if (!swift_node_get_borrowed_binary_data(env, argv[${i}], &${name}, &${name}_len)) ${fail}`,
      )
      lines.push(
        `    if (${name}_len > static_cast<size_t>(std::numeric_limits<int64_t>::max())) { napi_throw_range_error(env, nullptr, "Borrowed buffer is too large"); ${fail} }`,
      )
      continue
    }
    switch (cat) {
      case 'int32':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
        )
        if (!cleanupName) lines.push(`    int32_t ${name};`)
        lines.push(
          `    if (!swift_node_get_int32(env, argv[${i}], &${name}, "Failed to read integer argument")) ${fail}`,
        )
        break
      case 'int64':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
        )
        if (!cleanupName) lines.push(`    int64_t ${name};`)
        lines.push(
          `    if (!swift_node_get_int64(env, argv[${i}], &${name}, "Failed to read integer argument")) ${fail}`,
        )
        break
      case 'double':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_number, "Expected argument '${p.name}' to be a number")) ${fail}`,
        )
        if (!cleanupName) lines.push(`    double ${name};`)
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_double(env, argv[${i}], &${name}), "Failed to read number argument")) ${fail}`,
        )
        break
      case 'bool':
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_boolean, "Expected argument '${p.name}' to be a boolean")) ${fail}`,
        )
        if (!cleanupName) lines.push(`    bool ${name};`)
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_bool(env, argv[${i}], &${name}), "Failed to read boolean argument")) ${fail}`,
        )
        break
      case 'string':
        if (p.type.endsWith('?')) {
          lines.push(`    napi_valuetype ${name}_type;`)
          lines.push(
            `    if (!swift_node_napi_ok(env, napi_typeof(env, argv[${i}], &${name}_type), "Failed to inspect argument type")) ${fail}`,
          )
          if (!cleanupName) lines.push(`    char* ${name} = nullptr;`)
          lines.push(`    size_t ${name}_len = 0;`)
          lines.push(`    if (${name}_type != napi_null) {`)
          lines.push(
            `        if (${name}_type != napi_string) ${typeErrorReturn(`Expected argument '${p.name}' to be a string or null`, cleanupName)}`,
          )
          lines.push(
            `        if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], nullptr, 0, &${name}_len), "Failed to read string argument length")) ${fail}`,
          )
          lines.push(`        ${name} = new char[${name}_len + 1];`)
          lines.push(
            `        if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], ${name}, ${name}_len + 1, &${name}_len), "Failed to read string argument")) ${fail}`,
          )
          lines.push(`    }`)
          break
        }
        lines.push(
          `    if (!swift_node_expect_type(env, argv[${i}], napi_string, "Expected argument '${p.name}' to be a string")) ${fail}`,
        )
        lines.push(`    size_t ${name}_len;`)
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], nullptr, 0, &${name}_len), "Failed to read string argument length")) ${fail}`,
        )
        if (cleanupName) {
          lines.push(`    ${name} = new char[${name}_len + 1];`)
        } else {
          lines.push(`    char* ${name} = new char[${name}_len + 1];`)
        }
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[${i}], ${name}, ${name}_len + 1, &${name}_len), "Failed to read string argument")) ${fail}`,
        )
        break
    }
  }
}

function generateReturnConversion(
  lines: string[],
  returnType: string,
  retCat: SwiftTypeCategory,
  structs: SwiftStruct[] = [],
  transport?: BridgeTransport,
  stringLength?: string,
): void {
  if (transport === 'json') {
    lines.push('    AutoFreeStr guard(result);')
    lines.push('    napi_value js_result;')
    lines.push('    if (!swift_node_json_parse(env, result, &js_result)) return nullptr;')
    lines.push('    return js_result;')
    return
  }
  if (transport === 'data') {
    lines.push('    AutoFreeStr guard(result);')
    lines.push('    std::vector<uint8_t> swift_node_result_bytes;')
    lines.push(
      '    if (!swift_node_base64_decode(result, &swift_node_result_bytes)) return swift_node_throw_type_error(env, "Native Data return is not valid base64");',
    )
    lines.push('    napi_value js_result;')
    lines.push(
      '    if (!swift_node_napi_ok(env, napi_create_buffer_copy(env, swift_node_result_bytes.size(), swift_node_result_bytes.data(), nullptr, &js_result), "Failed to create Data return buffer")) return nullptr;',
    )
    lines.push('    return js_result;')
    return
  }
  // Check for struct return type
  const structDef = findStruct(returnType, structs)
  if (structDef) {
    if (structDef.fields.some((f) => f.category === 'string')) {
      lines.push(`    napi_value js_result = ${structDef.name}_to_js(env, result);`)
      lines.push(`    ${structDef.name}_free_strings(result);`)
      lines.push(`    return js_result;`)
    } else {
      lines.push(`    return ${structDef.name}_to_js(env, result);`)
    }
    return
  }

  switch (retCat) {
    case 'int32':
      lines.push('    napi_value js_result;')
      lines.push(
        '    if (!swift_node_napi_ok(env, napi_create_int32(env, result, &js_result), "Failed to create integer return value")) return nullptr;',
      )
      lines.push('    return js_result;')
      break
    case 'int64':
      lines.push('    napi_value js_result;')
      lines.push(
        '    if (!swift_node_napi_ok(env, napi_create_int64(env, result, &js_result), "Failed to create integer return value")) return nullptr;',
      )
      lines.push('    return js_result;')
      break
    case 'double':
      lines.push('    napi_value js_result;')
      lines.push(
        '    if (!swift_node_napi_ok(env, napi_create_double(env, result, &js_result), "Failed to create number return value")) return nullptr;',
      )
      lines.push('    return js_result;')
      break
    case 'bool':
      lines.push('    napi_value js_result;')
      lines.push(
        '    if (!swift_node_napi_ok(env, napi_get_boolean(env, result, &js_result), "Failed to create boolean return value")) return nullptr;',
      )
      lines.push('    return js_result;')
      break
    case 'string':
      if (returnType.endsWith('?')) {
        lines.push('    if (!result) {')
        lines.push('        napi_value js_null;')
        lines.push(
          '        if (!swift_node_napi_ok(env, napi_get_null(env, &js_null), "Failed to create null return value")) return nullptr;',
        )
        lines.push('        return js_null;')
        lines.push('    }')
      }
      lines.push('    AutoFreeStr guard(result);')
      lines.push('    napi_value js_result;')
      lines.push(
        `    if (!swift_node_napi_ok(env, swift_node_create_string(env, result, ${stringLength ? `static_cast<size_t>(${stringLength})` : 'strlen(result)'}, &js_result), "Failed to create string return value")) return nullptr;`,
      )
      lines.push('    return js_result;')
      break
    case 'void':
      lines.push('    napi_value js_undefined;')
      lines.push(
        '    if (!swift_node_napi_ok(env, napi_get_undefined(env, &js_undefined), "Failed to create undefined return value")) return nullptr;',
      )
      lines.push('    return js_undefined;')
      break
  }
}

// --- Main generation ---

// Generate C++ helper: JS object → C struct conversion
function generateStructFromJs(s: SwiftStruct): string {
  const lines: string[] = []
  lines.push(
    `static swift_node_${s.name} ${s.name}_from_js(napi_env env, napi_value obj, bool* ok) {`,
  )
  lines.push(`    swift_node_${s.name} result{};`)
  lines.push(`    *ok = false;`)
  const stringFields = s.fields.filter((f) => f.category === 'string')
  if (stringFields.length > 0) {
    lines.push(`    auto fail = [&]() {`)
    for (const f of stringFields) {
      const fieldName = cppIdentifier(f.name)
      lines.push(`        free((void*)result.${fieldName});`)
      lines.push(`        result.${fieldName} = nullptr;`)
    }
    lines.push(`        return result;`)
    lines.push(`    };`)
  }
  const failReturn = stringFields.length > 0 ? 'return fail();' : 'return result;'
  lines.push(
    `    if (!swift_node_expect_type(env, obj, napi_object, "Expected struct argument '${s.name}' to be an object")) ${failReturn}`,
  )
  lines.push(`    napi_value prop;`)

  for (const f of s.fields) {
    const fieldName = cppIdentifier(f.name)
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_get_named_property(env, obj, "${f.name}", &prop), "Failed to read struct property '${f.name}'")) ${failReturn}`,
    )
    switch (f.category) {
      case 'int32':
        lines.push(
          `    if (!swift_node_expect_type(env, prop, napi_number, "Expected struct property '${f.name}' to be a number")) ${failReturn}`,
        )
        lines.push(
          `    if (!swift_node_get_int32(env, prop, &result.${fieldName}, "Failed to read struct property '${f.name}'")) ${failReturn}`,
        )
        break
      case 'int64':
        lines.push(
          `    if (!swift_node_expect_type(env, prop, napi_number, "Expected struct property '${f.name}' to be a number")) ${failReturn}`,
        )
        lines.push(
          `    if (!swift_node_get_int64(env, prop, &result.${fieldName}, "Failed to read struct property '${f.name}'")) ${failReturn}`,
        )
        break
      case 'double':
        lines.push(
          `    if (!swift_node_expect_type(env, prop, napi_number, "Expected struct property '${f.name}' to be a number")) ${failReturn}`,
        )
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_double(env, prop, &result.${fieldName}), "Failed to read struct property '${f.name}'")) ${failReturn}`,
        )
        break
      case 'bool':
        lines.push(
          `    if (!swift_node_expect_type(env, prop, napi_boolean, "Expected struct property '${f.name}' to be a boolean")) ${failReturn}`,
        )
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_bool(env, prop, &result.${fieldName}), "Failed to read struct property '${f.name}'")) ${failReturn}`,
        )
        break
      case 'string':
        lines.push(
          `    if (!swift_node_expect_type(env, prop, napi_string, "Expected struct property '${f.name}' to be a string")) ${failReturn}`,
        )
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, prop, nullptr, 0, &result.${fieldName}_len), "Failed to read struct string length '${f.name}'")) ${failReturn}`,
        )
        lines.push(`    char* ${fieldName}_buf = (char*)malloc(result.${fieldName}_len + 1);`)
        lines.push(`    if (!${fieldName}_buf) {`)
        lines.push(`        swift_node_throw_type_error(env, "Out of memory");`)
        lines.push(`        ${failReturn}`)
        lines.push(`    }`)
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, prop, ${fieldName}_buf, result.${fieldName}_len + 1, &result.${fieldName}_len), "Failed to read struct string '${f.name}'")) {`,
        )
        lines.push(`        free(${fieldName}_buf);`)
        lines.push(`        ${failReturn}`)
        lines.push(`    }`)
        lines.push(`    result.${fieldName} = ${fieldName}_buf;`)
        break
    }
  }

  lines.push(`    *ok = true;`)
  lines.push(`    return result;`)
  lines.push(`}`)
  return lines.join('\n')
}

// Generate C++ helper: C struct → JS object conversion
function generateStructToJs(s: SwiftStruct): string {
  const lines: string[] = []
  lines.push(`static napi_value ${s.name}_to_js(napi_env env, swift_node_${s.name} s) {`)
  lines.push(`    napi_value obj;`)
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_object(env, &obj), "Failed to create object return value")) return nullptr;`,
  )
  lines.push(`    napi_value prop;`)

  for (const f of s.fields) {
    const fieldName = cppIdentifier(f.name)
    switch (f.category) {
      case 'int32':
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_create_int32(env, s.${fieldName}, &prop), "Failed to create struct property '${f.name}'")) return nullptr;`,
        )
        break
      case 'int64':
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_create_int64(env, s.${fieldName}, &prop), "Failed to create struct property '${f.name}'")) return nullptr;`,
        )
        break
      case 'double':
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_create_double(env, s.${fieldName}, &prop), "Failed to create struct property '${f.name}'")) return nullptr;`,
        )
        break
      case 'bool':
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_get_boolean(env, s.${fieldName}, &prop), "Failed to create struct property '${f.name}'")) return nullptr;`,
        )
        break
      case 'string':
        lines.push(
          `    if (!swift_node_napi_ok(env, napi_create_string_utf8(env, s.${fieldName}, s.${fieldName}_len, &prop), "Failed to create struct property '${f.name}'")) return nullptr;`,
        )
        break
    }
    lines.push(
      `    if (!swift_node_napi_ok(env, napi_set_named_property(env, obj, "${f.name}", prop), "Failed to set struct property '${f.name}'")) return nullptr;`,
    )
  }

  lines.push(`    return obj;`)
  lines.push(`}`)
  return lines.join('\n')
}

// Free string fields in a C struct
function generateStructFree(s: SwiftStruct): string {
  const stringFields = s.fields.filter((f) => f.category === 'string')
  if (stringFields.length === 0) return ''

  const lines: string[] = []
  lines.push(`static void ${s.name}_free_strings(swift_node_${s.name}& s) {`)
  for (const f of stringFields) {
    const fieldName = cppIdentifier(f.name)
    lines.push(`    free((void*)s.${fieldName});`)
    lines.push(`    s.${fieldName} = nullptr;`)
  }
  lines.push(`}`)
  return lines.join('\n')
}

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

function streamElementUsesStringLength(type: string, transport?: BridgeTransport): boolean {
  return transport !== 'json' && classifyNativeSwiftType(type) === 'string'
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

function generateStreamSubscriptionCpp(fn: SwiftFunction, structs: SwiftStruct[]): string {
  const stream = fn.stream!
  const prefix = fn.symbolName
  const params = fn.params
  const sourceParams = jsParams(fn)
  const usesJsonTransport = stream.transport === 'json'
  const valueCategory = classifyNativeSwiftType(stream.elementType)
  const valueType = usesJsonTransport ? 'const char*' : cppTypeFromCategory(valueCategory)
  const valueHasLength = streamElementUsesStringLength(stream.elementType, stream.transport)
  const lines: string[] = []

  lines.push(
    `enum StreamMessageKind_${prefix} { stream_message_value_${prefix}, stream_message_error_${prefix}, stream_message_complete_${prefix} };`,
  )
  lines.push(`struct StreamMessage_${prefix} {`)
  lines.push(`    StreamMessageKind_${prefix} kind;`)
  if (usesJsonTransport || valueCategory === 'string') lines.push('    char* value;')
  else lines.push(`    ${valueType} value;`)
  if (valueHasLength) lines.push('    size_t value_len;')
  lines.push('    char* error;')
  lines.push('};')
  lines.push('')
  lines.push(`struct StreamState_${prefix} {`)
  lines.push('    int64_t subscription_id;')
  lines.push('    std::atomic<bool> closed{false};')
  lines.push('    std::atomic<bool> cancelled{false};')
  lines.push('    napi_threadsafe_function tsfn = nullptr;')
  lines.push('    napi_ref on_value = nullptr;')
  lines.push('    napi_ref on_error = nullptr;')
  lines.push('    napi_ref on_complete = nullptr;')
  lines.push('};')
  lines.push(`struct StreamHandle_${prefix} { std::shared_ptr<StreamState_${prefix}> state; };`)
  lines.push(`static std::atomic<int64_t> next_stream_id_${prefix}{1};`)
  lines.push(`static std::mutex streams_mutex_${prefix};`)
  lines.push(
    `static std::unordered_map<int64_t, std::shared_ptr<StreamState_${prefix}>> streams_${prefix};`,
  )
  lines.push('')
  lines.push(`static void cleanup_stream_message_${prefix}(StreamMessage_${prefix}* message) {`)
  lines.push('    if (!message) return;')
  if (usesJsonTransport || valueCategory === 'string') lines.push('    free(message->value);')
  lines.push('    free(message->error);')
  lines.push('    delete message;')
  lines.push('}')
  lines.push('')
  lines.push(
    `static void cleanup_stream_refs_${prefix}(napi_env env, const std::shared_ptr<StreamState_${prefix}>& state) {`,
  )
  lines.push('    if (!env) return;')
  lines.push(
    '    if (state->on_value) { napi_delete_reference(env, state->on_value); state->on_value = nullptr; }',
  )
  lines.push(
    '    if (state->on_error) { napi_delete_reference(env, state->on_error); state->on_error = nullptr; }',
  )
  lines.push(
    '    if (state->on_complete) { napi_delete_reference(env, state->on_complete); state->on_complete = nullptr; }',
  )
  lines.push('}')
  lines.push('')
  lines.push(`static void finalize_stream_tsfn_${prefix}(napi_env env, void* data, void*) {`)
  lines.push(`    auto* owner = static_cast<std::shared_ptr<StreamState_${prefix}>*>(data);`)
  lines.push(`    if (owner) { cleanup_stream_refs_${prefix}(env, *owner); delete owner; }`)
  lines.push('}')
  lines.push('')
  lines.push(
    `static void invoke_stream_handler_${prefix}(napi_env env, napi_ref handler, size_t argc, napi_value* argv) {`,
  )
  lines.push('    if (!handler) return;')
  lines.push('    napi_value fn;')
  lines.push('    if (napi_get_reference_value(env, handler, &fn) != napi_ok) return;')
  lines.push('    napi_value global;')
  lines.push('    if (napi_get_global(env, &global) != napi_ok) return;')
  lines.push('    napi_status status = napi_call_function(env, global, fn, argc, argv, nullptr);')
  lines.push(
    '    if (status != napi_ok) { napi_value ignored; napi_get_and_clear_last_exception(env, &ignored); }',
  )
  lines.push('}')
  lines.push('')
  lines.push(
    `static void call_js_stream_${prefix}(napi_env env, napi_value, void* context, void* data) {`,
  )
  lines.push(`    auto* owner = static_cast<std::shared_ptr<StreamState_${prefix}>*>(context);`)
  lines.push(`    auto* message = static_cast<StreamMessage_${prefix}*>(data);`)
  lines.push(`    if (!message) return;`)
  lines.push(`    if (!env || !owner) { cleanup_stream_message_${prefix}(message); return; }`)
  lines.push('    const auto& state = *owner;')
  lines.push(
    `    if (message->kind == stream_message_value_${prefix} && state->cancelled.load()) { cleanup_stream_message_${prefix}(message); return; }`,
  )
  lines.push(`    if (message->kind == stream_message_value_${prefix}) {`)
  lines.push('        napi_value argument;')
  if (usesJsonTransport) {
    lines.push(
      '        if (!swift_node_json_parse(env, message->value, &argument)) { cleanup_stream_message_' +
        prefix +
        '(message); return; }',
    )
  } else if (valueCategory === 'string') {
    if (isNullableType(stream.elementType)) {
      lines.push('        if (message->value) {')
      lines.push(
        `            if (!swift_node_napi_ok(env, swift_node_create_string(env, message->value, ${valueHasLength ? 'message->value_len' : 'strlen(message->value)'}, &argument), "Failed to create stream value")) { cleanup_stream_message_${prefix}(message); return; }`,
      )
      lines.push(
        '        } else if (!swift_node_napi_ok(env, napi_get_null(env, &argument), "Failed to create null stream value")) { cleanup_stream_message_' +
          prefix +
          '(message); return; }',
      )
    } else {
      lines.push(
        `        if (!swift_node_napi_ok(env, swift_node_create_string(env, message->value, ${valueHasLength ? 'message->value_len' : 'strlen(message->value)'}, &argument), "Failed to create stream value")) { cleanup_stream_message_${prefix}(message); return; }`,
      )
    }
  } else if (valueCategory === 'int32') {
    lines.push(
      '        if (!swift_node_napi_ok(env, napi_create_int32(env, message->value, &argument), "Failed to create stream value")) { cleanup_stream_message_' +
        prefix +
        '(message); return; }',
    )
  } else if (valueCategory === 'int64') {
    lines.push(
      '        if (!swift_node_napi_ok(env, napi_create_int64(env, message->value, &argument), "Failed to create stream value")) { cleanup_stream_message_' +
        prefix +
        '(message); return; }',
    )
  } else if (valueCategory === 'double') {
    lines.push(
      '        if (!swift_node_napi_ok(env, napi_create_double(env, message->value, &argument), "Failed to create stream value")) { cleanup_stream_message_' +
        prefix +
        '(message); return; }',
    )
  } else if (valueCategory === 'bool') {
    lines.push(
      '        if (!swift_node_napi_ok(env, napi_get_boolean(env, message->value, &argument), "Failed to create stream value")) { cleanup_stream_message_' +
        prefix +
        '(message); return; }',
    )
  }
  lines.push(`        invoke_stream_handler_${prefix}(env, state->on_value, 1, &argument);`)
  lines.push(`    } else if (message->kind == stream_message_error_${prefix}) {`)
  lines.push('        napi_value text;')
  lines.push('        napi_value error;')
  lines.push(
    '        if (swift_node_napi_ok(env, swift_node_create_string(env, message->error ? message->error : "Stream failed", &text), "Failed to create stream error") && swift_node_napi_ok(env, napi_create_error(env, nullptr, text, &error), "Failed to create stream error")) {',
  )
  lines.push(`            invoke_stream_handler_${prefix}(env, state->on_error, 1, &error);`)
  lines.push('        }')
  lines.push('    } else {')
  lines.push(`        invoke_stream_handler_${prefix}(env, state->on_complete, 0, nullptr);`)
  lines.push('    }')
  lines.push(`    cleanup_stream_message_${prefix}(message);`)
  lines.push('}')
  lines.push('')
  lines.push(
    `static void cancel_stream_${prefix}(const std::shared_ptr<StreamState_${prefix}>& state) {`,
  )
  lines.push('    if (!state || state->closed.exchange(true)) return;')
  lines.push('    state->cancelled.store(true);')
  lines.push(`    ${prefix}_cancel(state->subscription_id);`)
  lines.push('    if (state->tsfn) napi_release_threadsafe_function(state->tsfn, napi_tsfn_abort);')
  lines.push('}')
  lines.push('')
  lines.push(
    `static void stream_value_${prefix}(int64_t subscription_id, ${valueType} value${valueHasLength ? ', int64_t value_len' : ''}) {`,
  )
  lines.push(`    std::shared_ptr<StreamState_${prefix}> state;`)
  lines.push('    napi_status acquire_status = napi_generic_failure;')
  lines.push(
    `    { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); auto found = streams_${prefix}.find(subscription_id); if (found != streams_${prefix}.end() && !found->second->closed.load()) { state = found->second; acquire_status = napi_acquire_threadsafe_function(state->tsfn); } }`,
  )
  lines.push('    if (!state || acquire_status != napi_ok) return;')
  lines.push(`    auto* message = new StreamMessage_${prefix}{};`)
  lines.push(`    message->kind = stream_message_value_${prefix};`)
  if (usesJsonTransport || valueCategory === 'string') {
    if (valueHasLength) {
      lines.push('    message->value_len = value ? static_cast<size_t>(value_len) : 0;')
      lines.push('    message->value = value ? (char*)malloc(message->value_len + 1) : nullptr;')
      lines.push(
        '    if (value && !message->value) { cleanup_stream_message_' +
          prefix +
          '(message); napi_release_threadsafe_function(state->tsfn, napi_tsfn_release); return; }',
      )
      lines.push(
        "    if (value) { memcpy(message->value, value, message->value_len); message->value[message->value_len] = '\\0'; }",
      )
    } else {
      lines.push('    message->value = value ? strdup(value) : nullptr;')
    }
  } else {
    lines.push('    message->value = value;')
  }
  lines.push(
    '    napi_status status = napi_call_threadsafe_function(state->tsfn, message, napi_tsfn_nonblocking);',
  )
  lines.push(`    if (status != napi_ok) cleanup_stream_message_${prefix}(message);`)
  lines.push('    napi_release_threadsafe_function(state->tsfn, napi_tsfn_release);')
  lines.push('}')
  lines.push('')
  lines.push(`static void stream_complete_${prefix}(int64_t subscription_id, const char* error) {`)
  lines.push(`    std::shared_ptr<StreamState_${prefix}> state;`)
  lines.push(
    `    { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); auto found = streams_${prefix}.find(subscription_id); if (found == streams_${prefix}.end()) return; state = found->second; streams_${prefix}.erase(found); }`,
  )
  lines.push('    state->closed.store(true);')
  lines.push(`    auto* message = new StreamMessage_${prefix}{};`)
  lines.push(
    `    message->kind = error ? stream_message_error_${prefix} : stream_message_complete_${prefix};`,
  )
  lines.push('    message->error = error ? strdup(error) : nullptr;')
  lines.push(
    '    napi_status status = napi_call_threadsafe_function(state->tsfn, message, napi_tsfn_nonblocking);',
  )
  lines.push(`    if (status != napi_ok) cleanup_stream_message_${prefix}(message);`)
  lines.push('    napi_release_threadsafe_function(state->tsfn, napi_tsfn_release);')
  lines.push('}')
  lines.push('')
  lines.push(`static void finalize_stream_handle_${prefix}(napi_env, void* data, void*) {`)
  lines.push(`    auto* handle = static_cast<StreamHandle_${prefix}*>(data);`)
  lines.push(
    `    if (handle) { { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); streams_${prefix}.erase(handle->state->subscription_id); } cancel_stream_${prefix}(handle->state); delete handle; }`,
  )
  lines.push('}')
  lines.push('')
  lines.push(
    `static napi_value js_cancel_stream_${prefix}(napi_env env, napi_callback_info info) {`,
  )
  lines.push('    napi_value this_arg;')
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, nullptr), "Failed to read stream subscription")) return nullptr;',
  )
  lines.push(`    StreamHandle_${prefix}* handle = nullptr;`)
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_unwrap(env, this_arg, (void**)&handle), "Invalid stream subscription")) return nullptr;',
  )
  lines.push(
    `    if (handle) { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); streams_${prefix}.erase(handle->state->subscription_id); cancel_stream_${prefix}(handle->state); }`,
  )
  lines.push('    napi_value undefined;')
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_get_undefined(env, &undefined), "Failed to create undefined")) return nullptr;',
  )
  lines.push('    return undefined;')
  lines.push('}')
  lines.push('')
  lines.push(
    `static napi_value js_stream_closed_${prefix}(napi_env env, napi_callback_info info) {`,
  )
  lines.push('    napi_value this_arg;')
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, nullptr), "Failed to read stream subscription")) return nullptr;',
  )
  lines.push(`    StreamHandle_${prefix}* handle = nullptr;`)
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_unwrap(env, this_arg, (void**)&handle), "Invalid stream subscription")) return nullptr;',
  )
  lines.push('    napi_value result;')
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_get_boolean(env, !handle || handle->state->closed.load(), &result), "Failed to create closed state")) return nullptr;',
  )
  lines.push('    return result;')
  lines.push('}')
  lines.push('')

  const sourceCount = sourceParams.length
  lines.push(`static napi_value js_${prefix}(napi_env env, napi_callback_info info) {`)
  lines.push(`    size_t argc = ${sourceCount + 3};`)
  lines.push(`    napi_value argv[${sourceCount + 3}];`)
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Failed to read callback info")) return nullptr;',
  )
  lines.push(`    if (!swift_node_expect_argc(env, argc, ${sourceCount + 1})) return nullptr;`)
  lines.push('')
  generateArgConversions(lines, sourceParams, structs, 'cleanup_args')
  lines.push('')
  lines.push(
    `    if (!swift_node_expect_type(env, argv[${sourceCount}], napi_function, "Expected stream onValue callback to be a function")) { cleanup_args(); return nullptr; }`,
  )
  lines.push(`    auto state = std::make_shared<StreamState_${prefix}>();`)
  lines.push(`    state->subscription_id = next_stream_id_${prefix}.fetch_add(1);`)
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_reference(env, argv[${sourceCount}], 1, &state->on_value), "Failed to retain stream callback")) { cleanup_args(); return nullptr; }`,
  )
  for (const optional of [
    { name: 'on_error', index: sourceCount + 1, label: 'onError' },
    { name: 'on_complete', index: sourceCount + 2, label: 'onComplete' },
  ]) {
    lines.push(`    if (argc > ${optional.index}) {`)
    lines.push(`        napi_valuetype ${optional.name}_type;`)
    lines.push(
      `        if (!swift_node_napi_ok(env, napi_typeof(env, argv[${optional.index}], &${optional.name}_type), "Failed to inspect ${optional.label} callback")) { cleanup_stream_refs_${prefix}(env, state); cleanup_args(); return nullptr; }`,
    )
    lines.push(`        if (${optional.name}_type != napi_undefined) {`)
    lines.push(
      `            if (!swift_node_expect_type(env, argv[${optional.index}], napi_function, "Expected stream ${optional.label} callback to be a function")) { cleanup_stream_refs_${prefix}(env, state); cleanup_args(); return nullptr; }`,
    )
    lines.push(
      `            if (!swift_node_napi_ok(env, napi_create_reference(env, argv[${optional.index}], 1, &state->${optional.name}), "Failed to retain stream ${optional.label} callback")) { cleanup_stream_refs_${prefix}(env, state); cleanup_args(); return nullptr; }`,
    )
    lines.push('        }')
    lines.push('    }')
  }
  lines.push(`    auto* tsfn_context = new std::shared_ptr<StreamState_${prefix}>(state);`)
  lines.push('    napi_value resource_name;')
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_string_utf8(env, "swift_node_stream_${prefix}", NAPI_AUTO_LENGTH, &resource_name), "Failed to create stream resource name")) { delete tsfn_context; cleanup_stream_refs_${prefix}(env, state); cleanup_args(); return nullptr; }`,
  )
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_threadsafe_function(env, argv[${sourceCount}], nullptr, resource_name, 0, 1, tsfn_context, finalize_stream_tsfn_${prefix}, tsfn_context, call_js_stream_${prefix}, &state->tsfn), "Failed to create stream callback")) { delete tsfn_context; cleanup_stream_refs_${prefix}(env, state); cleanup_args(); return nullptr; }`,
  )
  lines.push(
    `    { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); streams_${prefix}.emplace(state->subscription_id, state); }`,
  )
  const callArgs = params
    .map((p) =>
      p.bridgeStringLengthFor
        ? `${cppIdentifier(p.bridgeStringLengthFor)}_len`
        : cppIdentifier(p.name),
    )
    .join(', ')
  lines.push(
    `    ${prefix}(${callArgs}${callArgs ? ', ' : ''}state->subscription_id, stream_value_${prefix}, stream_complete_${prefix});`,
  )
  lines.push('    cleanup_args();')
  lines.push('    napi_value subscription;')
  lines.push(
    '    if (!swift_node_napi_ok(env, napi_create_object(env, &subscription), "Failed to create stream subscription")) {',
  )
  lines.push(
    `        { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); streams_${prefix}.erase(state->subscription_id); }`,
  )
  lines.push(`        cancel_stream_${prefix}(state);`)
  lines.push('        return nullptr;')
  lines.push('    }')
  lines.push(`    auto* handle = new StreamHandle_${prefix}{ state };`)
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_wrap(env, subscription, handle, finalize_stream_handle_${prefix}, nullptr, nullptr), "Failed to wrap stream subscription")) { delete handle; { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); streams_${prefix}.erase(state->subscription_id); } cancel_stream_${prefix}(state); return nullptr; }`,
  )
  lines.push('    napi_value cancel;')
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, js_cancel_stream_${prefix}, nullptr, &cancel), "Failed to create stream cancel method") || !swift_node_napi_ok(env, napi_set_named_property(env, subscription, "cancel", cancel), "Failed to set stream cancel method")) { { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); streams_${prefix}.erase(state->subscription_id); } cancel_stream_${prefix}(state); return nullptr; }`,
  )
  lines.push(
    `    napi_property_descriptor closed = { "closed", nullptr, nullptr, js_stream_closed_${prefix}, nullptr, nullptr, napi_default, nullptr };`,
  )
  lines.push(
    `    if (!swift_node_napi_ok(env, napi_define_properties(env, subscription, 1, &closed), "Failed to define stream closed property")) { { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); streams_${prefix}.erase(state->subscription_id); } cancel_stream_${prefix}(state); return nullptr; }`,
  )
  lines.push('    napi_value global; napi_value symbol; napi_value dispose;')
  lines.push(
    '    if (swift_node_napi_ok(env, napi_get_global(env, &global), "Failed to read global object") && swift_node_napi_ok(env, napi_get_named_property(env, global, "Symbol", &symbol), "Failed to read Symbol") && swift_node_napi_ok(env, napi_get_named_property(env, symbol, "dispose", &dispose), "Failed to read Symbol.dispose")) { napi_set_property(env, subscription, dispose, cancel); }',
  )
  lines.push('    return subscription;')
  lines.push('}')
  lines.push('')
  lines.push(`static void cleanup_streams_${prefix}(void*) {`)
  lines.push(`    std::vector<std::shared_ptr<StreamState_${prefix}>> states;`)
  lines.push(
    `    { std::lock_guard<std::mutex> lock(streams_mutex_${prefix}); for (auto& entry : streams_${prefix}) states.push_back(entry.second); streams_${prefix}.clear(); }`,
  )
  lines.push(`    for (const auto& state : states) cancel_stream_${prefix}(state);`)
  lines.push('}')
  return lines.join('\n')
}

export function generateAddonCpp(
  functions: SwiftFunction[],
  moduleName: string,
  structs: SwiftStruct[] = [],
): string {
  const lines: string[] = [
    '// Generated by swift-node — do not edit',
    `#include "bridge.h"`,
    `#include "swift-node-runtime.h"`,
    '#include <cstdlib>',
    '#include <cstring>',
    '#include <string>',
    '#include <vector>',
    '#include <atomic>',
    '#include <memory>',
    '#include <mutex>',
    '#include <unordered_map>',
    '#include <unordered_set>',
    '',
  ]

  // Struct conversion helpers
  for (const s of structs) {
    lines.push(generateStructFromJs(s))
    lines.push('')
    lines.push(generateStructToJs(s))
    lines.push('')
    const freeFn = generateStructFree(s)
    if (freeFn) {
      lines.push(freeFn)
      lines.push('')
    }
  }

  for (const fn of functions) {
    if (!fn.stream) continue
    lines.push(generateStreamSubscriptionCpp(fn, structs))
    lines.push('')
  }

  const callbackFns = functions.filter((fn) => getCallbackParam(fn))

  // Generate callback trampolines
  for (const fn of callbackFns) {
    const cbParam = getCallbackParam(fn)!
    lines.push(generateCallbackTrampoline(fn, cbParam))
    lines.push('')
  }

  // Function wrappers
  for (const fn of functions) {
    if (fn.stream) {
      lines.push(`// Stream wrapper for ${fn.symbolName} was generated above.`)
    } else {
      lines.push(generateJsWrapper(fn, moduleName, structs))
    }
    lines.push('')
  }

  // Module init
  lines.push('static napi_value init(napi_env env, napi_value exports) {')
  lines.push('    napi_value fn;')

  for (const fn of functions) {
    const name = jsName(fn.symbolName, moduleName)
    lines.push('')
    lines.push(
      `    napi_create_function(env, "${name}", NAPI_AUTO_LENGTH, js_${fn.symbolName}, nullptr, &fn);`,
    )
    lines.push(`    napi_set_named_property(env, exports, "${name}", fn);`)
    if (fn.stream)
      lines.push(`    napi_add_env_cleanup_hook(env, cleanup_streams_${fn.symbolName}, nullptr);`)
    if (getCallbackParam(fn))
      lines.push(`    napi_add_env_cleanup_hook(env, cleanup_callbacks_${fn.symbolName}, nullptr);`)
  }

  lines.push('')
  lines.push('    return exports;')
  lines.push('}')
  lines.push('')
  lines.push(`NAPI_MODULE(NODE_GYP_MODULE_NAME, init)`)

  return lines.join('\n')
}

// --- TypeScript definition generation ---

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
function generatedAddonResolverLines(): string[] {
  return [
    `function resolveAddonPath(dir, moduleName) {`,
    `  const isMusl = process.platform === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime`,
    `  const target = process.platform + '-' + process.arch + (isMusl ? '-musl' : '')`,
    `  const binaryName = moduleName + '.' + target + '.node'`,
    `  const binaryPath = path.join(dir, ...(process.platform === 'darwin' ? [] : [target]), binaryName)`,
    `  if (existsSync(binaryPath)) return binaryPath`,
    '',
    `  throw new Error(`,
    `    'No .node binary found for ' + target + '.\\n' +`,
    `    'Checked:\\n' +`,
    `    '  ' + binaryPath + '\\n' +`,
    `    "Run 'swift-node build' for this platform and architecture."`,
    `  )`,
    `}`,
  ]
}

// Generate dist_swift-node/index.mjs — ESM entry point. Pure JS (no TS syntax) so
// Node can load it without a TypeScript loader. Types come from index.d.ts.
// .mjs extension ensures ESM parsing regardless of package "type" field.
export function generateEntryMjs(functions: SwiftFunction[], moduleName: string): string {
  const lines = [
    '// Generated by swift-node — do not edit',
    '',
    `import { createRequire } from 'node:module'`,
    `import { fileURLToPath } from 'node:url'`,
    `import path from 'node:path'`,
    '',
    `const require = createRequire(import.meta.url)`,
    `const __dirname = path.dirname(fileURLToPath(import.meta.url))`,
    `const { existsSync } = require('node:fs')`,
    '',
    ...generatedAddonResolverLines(),
    '',
    `const native = require(resolveAddonPath(__dirname, ${JSON.stringify(moduleName)}))`,
    '',
  ]
  for (const [index, fn] of functions.entries()) {
    const name = jsName(fn.symbolName, moduleName)
    lines.push(`const __swift_node_${index} = native[${JSON.stringify(name)}]`)
  }
  if (functions.length > 0) {
    lines.push('')
  }
  for (const [index, fn] of functions.entries()) {
    const name = jsName(fn.symbolName, moduleName)
    lines.push(`export { __swift_node_${index} as ${name} }`)
  }
  return lines.join('\n')
}

// Generate dist_swift-node/index.cjs — CJS entry point for require() consumers.
export function generateEntryCjs(functions: SwiftFunction[], moduleName: string): string {
  const lines = [
    '// Generated by swift-node — do not edit',
    `const path = require('node:path')`,
    `const { existsSync } = require('node:fs')`,
    '',
    ...generatedAddonResolverLines(),
    '',
    `const native = require(resolveAddonPath(__dirname, ${JSON.stringify(moduleName)}))`,
    '',
    `module.exports = {`,
  ]
  for (const fn of functions) {
    const name = jsName(fn.symbolName, moduleName)
    lines.push(`  ${JSON.stringify(name)}: native[${JSON.stringify(name)}],`)
  }
  lines.push('}')
  return lines.join('\n')
}

// Generate the TypeScript source entry created by `swift-node init`. Package
// exports point straight at dist_swift-node; this file is the convenient source
// entry for a project's own TypeScript code.
export function generateSourceEntryTs(): string {
  return "export * from '../dist_swift-node/index.mjs'\n"
}
