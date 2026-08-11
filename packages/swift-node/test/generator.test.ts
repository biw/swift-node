import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, it, expect } from 'vite-plus/test'
import {
  generateBridgeH,
  generateAddonCpp,
  generateDts,
  generateDtsCjs,
  generateStructsHeader,
  generateWrappersSwift,
  exportedToSwiftFunctions,
  generateEntryMjs,
  generateEntryCjs,
  generateSourceEntryTs,
} from '../src/generator'
import { nativeTargetId } from '../src/prebuild'
import type { SwiftFunction, SwiftStruct, ExportedFunction } from '../src/parser'

// --- Test fixtures ---

const greetFn: SwiftFunction = {
  symbolName: 'Hello_greet',
  params: [{ name: 'name', type: 'UnsafePointer<CChar>' }],
  returnType: 'UnsafePointer<CChar>',
  isAsync: false,
}

const addFn: SwiftFunction = {
  symbolName: 'Math_add',
  params: [
    { name: 'a', type: 'Int32' },
    { name: 'b', type: 'Int32' },
  ],
  returnType: 'Int32',
  isAsync: false,
}

const add64Fn: SwiftFunction = {
  symbolName: 'Math_add64',
  params: [
    { name: 'a', type: 'Int' },
    { name: 'b', type: 'Int' },
  ],
  returnType: 'Int',
  isAsync: false,
}

const divideFn: SwiftFunction = {
  symbolName: 'Math_divide',
  params: [
    { name: 'a', type: 'Double' },
    { name: 'b', type: 'Double' },
    { name: 'outError', type: 'UnsafeMutablePointer<UnsafePointer<CChar>?>' },
  ],
  returnType: 'Double',
  isAsync: false,
}

const nullableGetFn: SwiftFunction = {
  symbolName: 'Store_get',
  params: [{ name: 'key', type: 'UnsafePointer<CChar>' }],
  returnType: 'UnsafeMutablePointer<CChar>?',
  isAsync: false,
}

const voidFn: SwiftFunction = {
  symbolName: 'Mod_stop',
  params: [],
  returnType: 'Void',
  isAsync: false,
}

const callbackFn: SwiftFunction = {
  symbolName: 'monitor_start',
  params: [{ name: 'callback', type: '@escaping @convention(c) (UnsafePointer<CChar>) -> Void' }],
  returnType: 'Void',
  isAsync: false,
}

const stopFn: SwiftFunction = {
  symbolName: 'monitor_stop',
  params: [],
  returnType: 'Void',
  isAsync: false,
}

const asyncFn: SwiftFunction = {
  symbolName: 'Mod_slow',
  params: [{ name: 'x', type: 'Int32' }],
  returnType: 'Int32',
  isAsync: true,
}

const nodeRequire = createRequire(import.meta.url)

function withGeneratedAddonProject(callback: (projectDir: string) => void): void {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-generated-resolver-'))
  mkdirSync(path.join(projectDir, 'dist_swift-node'))
  try {
    callback(projectDir)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
}

interface GeneratedRuntimeProcess {
  platform: string
  arch: string
  report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } }
}

function loadGeneratedCjsEntry(
  projectDir: string,
  moduleName: string,
  generatedProcess: GeneratedRuntimeProcess = process,
): string {
  let loadedPath = ''
  const requireGenerated = (request: string): unknown => {
    if (request === 'node:path' || request === 'node:fs') return nodeRequire(request)
    if (request.endsWith('.node')) {
      loadedPath = request
      return { Math_add: () => 3 }
    }
    throw new Error(`Unexpected generated require: ${request}`)
  }

  const generatedModule = { exports: {} }
  runInNewContext(generateEntryCjs([addFn], moduleName), {
    __dirname: path.join(projectDir, 'dist_swift-node'),
    exports: generatedModule.exports,
    module: generatedModule,
    process: generatedProcess,
    require: requireGenerated,
  })
  return loadedPath
}

function generatedTargetBinaryPath(projectDir: string, moduleName: string): string {
  return path.join(
    projectDir,
    'dist_swift-node',
    ...(process.platform === 'darwin' ? [] : [nativeTargetId()]),
    `${moduleName}.${nativeTargetId()}.node`,
  )
}

// Extract a single generated C++ function body — from its signature to the first
// column-0 closing brace — so cleanup paths can be asserted in isolation.
function extractFnBody(cpp: string, signature: string): string {
  const start = cpp.indexOf(signature)
  if (start < 0) throw new Error(`function not found: ${signature}`)
  const end = cpp.indexOf('\n}', start)
  return cpp.slice(start, end < 0 ? undefined : end + 2)
}

const pointStruct: SwiftStruct = {
  name: 'Point',
  fields: [
    { name: 'x', type: 'Double', category: 'double' },
    { name: 'y', type: 'Double', category: 'double' },
  ],
}

const profileStruct: SwiftStruct = {
  name: 'Profile',
  fields: [
    { name: 'id', type: 'Int', category: 'int64' },
    { name: 'name', type: 'String', category: 'string' },
  ],
}

const floatVectorStruct: SwiftStruct = {
  name: 'FloatVector',
  fields: [{ name: 'x', type: 'Float', category: 'double' }],
}

const resultStruct: SwiftStruct = {
  name: 'DistanceResult',
  fields: [
    { name: 'distance', type: 'Double', category: 'double' },
    { name: 'midX', type: 'Double', category: 'double' },
    { name: 'midY', type: 'Double', category: 'double' },
  ],
}

const structFn: SwiftFunction = {
  symbolName: 'Geo_distance',
  params: [
    { name: 'a', type: 'swift_node_Point' },
    { name: 'b', type: 'swift_node_Point' },
  ],
  returnType: 'swift_node_DistanceResult',
  isAsync: false,
}

const profileFn: SwiftFunction = {
  symbolName: 'Profiles_rename',
  params: [{ name: 'profile', type: 'swift_node_Profile' }],
  returnType: 'swift_node_Profile',
  isAsync: false,
}

// --- Bridge header tests ---

describe('generateBridgeH', () => {
  it('generates header with extern C block', () => {
    const h = generateBridgeH([addFn], 'test')
    expect(h).toContain('#ifndef TEST_BRIDGE_H')
    expect(h).toContain('extern "C"')
    expect(h).toContain('int32_t Math_add(int32_t a, int32_t b);')
  })

  it('maps string params to const char*', () => {
    const h = generateBridgeH([greetFn], 'test')
    expect(h).toContain('const char* Hello_greet(const char* name);')
  })

  it('maps error out params', () => {
    const h = generateBridgeH([divideFn], 'test')
    expect(h).toContain('double Math_divide(double a, double b, const char** out_error);')
  })

  it('maps nullable mutable pointer return to char*', () => {
    const h = generateBridgeH([nullableGetFn], 'test')
    expect(h).toContain('char* Store_get(const char* key);')
  })

  it('maps callback params to function pointers', () => {
    const h = generateBridgeH([callbackFn], 'test')
    expect(h).toContain('void (*callback)(const char*)')
  })

  it('includes struct typedefs when structs provided', () => {
    const h = generateBridgeH([structFn], 'test', [pointStruct, resultStruct])
    expect(h).toContain('typedef struct {')
    expect(h).toContain('double x;')
    expect(h).toContain('} swift_node_Point;')
    expect(h).toContain('} swift_node_DistanceResult;')
  })

  it('maps Int and String struct fields', () => {
    const h = generateBridgeH([], 'test', [profileStruct])
    expect(h).toContain('int64_t id;')
    expect(h).toContain('const char* name;')
    expect(h).toContain('size_t name_len;')
  })

  it('maps struct params and return types', () => {
    const h = generateBridgeH([structFn], 'test', [pointStruct, resultStruct])
    expect(h).toContain(
      'swift_node_DistanceResult Geo_distance(swift_node_Point a, swift_node_Point b);',
    )
  })

  it('does not emit C++ keyword parameter names into the bridge header', () => {
    const fn: SwiftFunction = {
      symbolName: 'models_measure',
      params: [
        { name: 'double', type: 'Double' },
        { name: 'float', type: 'Double' },
      ],
      returnType: 'Void',
      isAsync: false,
    }

    const header = generateBridgeH([fn], 'models')
    expect(header).not.toContain('double double')
    expect(header).not.toContain('double float')
  })
})

// --- Structs header tests ---

describe('generateStructsHeader', () => {
  it('generates standalone header with struct typedefs', () => {
    const h = generateStructsHeader([pointStruct])
    expect(h).toContain('#ifndef SWIFT_NODE_STRUCTS_H')
    expect(h).toContain('typedef struct {')
    expect(h).toContain('double x;')
    expect(h).toContain('double y;')
    expect(h).toContain('} swift_node_Point;')
  })

  it('handles multiple structs', () => {
    const h = generateStructsHeader([pointStruct, resultStruct])
    expect(h).toContain('swift_node_Point;')
    expect(h).toContain('swift_node_DistanceResult;')
  })
})

// --- C++ addon tests ---

describe('generateAddonCpp', () => {
  it('generates an independently-owned stream registry and cancellation handle', () => {
    const streamFn: SwiftFunction = {
      symbolName: 'models_tokens',
      params: [{ name: 'prompt', type: 'UnsafePointer<CChar>' }],
      returnType: 'Void',
      isAsync: false,
      stream: { elementType: 'String', isThrowing: true },
    }
    const cpp = generateAddonCpp([streamFn], 'models')
    const dts = generateDts([streamFn], 'models')

    expect(cpp).toContain('std::unordered_map<int64_t, std::shared_ptr<StreamState_models_tokens>>')
    expect(cpp).toContain('models_tokens_cancel(state->subscription_id)')
    expect(cpp).toContain('napi_add_env_cleanup_hook(env, cleanup_streams_models_tokens, nullptr)')
    expect(cpp).toContain('Symbol.dispose')
    expect(dts).toContain('export interface SwiftNodeSubscription')
    expect(dts).toContain('onError?: (error: Error) => void')
    expect(dts).toContain('=> SwiftNodeSubscription')
  })

  it('serializes structured stream events through JSON', () => {
    const exported: ExportedFunction = {
      name: 'events',
      params: [],
      returnType: 'AsyncStream<ModelEvent>',
      throws: false,
      isAsync: false,
      isStream: true,
      line: 1,
    }
    const [stream] = exportedToSwiftFunctions([exported], 'models', [], ['ModelEvent'])
    const wrappers = generateWrappersSwift([exported], 'models', [], ['ModelEvent'])
    const cpp = generateAddonCpp([stream], 'models')

    expect(stream.stream?.transport).toBe('json')
    expect(wrappers).toContain('JSONEncoder().encode(value)')
    expect(cpp).toContain('swift_node_json_parse(env, message->value, &argument)')
  })

  it('generates compilable C++ with includes', () => {
    const cpp = generateAddonCpp([addFn], 'test')
    expect(cpp).toContain('#include "bridge.h"')
    expect(cpp).toContain('#include "swift-node-runtime.h"')
    expect(cpp).toContain('NAPI_MODULE(NODE_GYP_MODULE_NAME, init)')
  })

  it('generates wrapper function for scalar types', () => {
    const cpp = generateAddonCpp([addFn], 'test')
    expect(cpp).toContain('static napi_value js_Math_add')
    expect(cpp).toContain('swift_node_get_int32')
    expect(cpp).toContain('Math_add(a, b)')
    expect(cpp).toContain('napi_create_int32')
  })

  it('generates 64-bit wrappers for Int', () => {
    const cpp = generateAddonCpp([add64Fn], 'test')
    expect(cpp).toContain('swift_node_get_int64')
    expect(cpp).toContain('Math_add64(a, b)')
    expect(cpp).toContain('napi_create_int64')
  })

  it('generates string extraction for string params', () => {
    const cpp = generateAddonCpp([greetFn], 'test')
    expect(cpp).toContain('napi_get_value_string_utf8')
    expect(cpp).toContain('Hello_greet(name)')
    expect(cpp).toContain('AutoFreeStr guard(result)')
  })

  it('passes borrowed bytes directly to the C bridge without a base64 copy', () => {
    const exported: ExportedFunction = {
      name: 'describeBytes',
      params: [{ label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' }],
      returnType: 'String',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const [fn] = exportedToSwiftFunctions([exported], 'test')
    const header = generateBridgeH([fn], 'test')
    const body = extractFnBody(
      generateAddonCpp([fn], 'test'),
      'static napi_value js_test_describeBytes',
    )

    expect(header).toContain(
      'char* test_describeBytes(const void* bytes, int64_t bytesLen, int64_t* outResultLen, const char** out_error);',
    )
    expect(body).toContain('swift_node_get_binary_data(env, argv[0], &bytes, &bytes_len)')
    expect(body).toContain('Borrowed buffer is too large')
    expect(body).toContain(
      'test_describeBytes(bytes, static_cast<int64_t>(bytes_len), &result_len, &swift_error)',
    )
    expect(body).not.toContain('swift_node_base64_encode')
    expect(body).not.toContain('_base64')
  })

  it('generates null check for nullable string returns', () => {
    const cpp = generateAddonCpp([nullableGetFn], 'test')
    expect(cpp).toContain('if (!result)')
    expect(cpp).toContain('napi_get_null')
    expect(cpp).toContain('AutoFreeStr guard(result)')
  })

  it('generates void return correctly', () => {
    const cpp = generateAddonCpp([voidFn], 'test')
    expect(cpp).toContain('return nullptr;')
    expect(cpp).not.toContain('result')
  })

  it('generates error handling for error out params', () => {
    const cpp = generateAddonCpp([divideFn], 'test')
    expect(cpp).toContain('const char* swift_error = nullptr')
    expect(cpp).toContain('&swift_error')
    expect(cpp).toContain('throw_swift_error(env, swift_error)')
  })

  it('registers functions with stripped module prefix', () => {
    const fn = {
      symbolName: 'test_add',
      params: addFn.params,
      returnType: addFn.returnType,
      isAsync: false,
    }
    const cpp = generateAddonCpp([fn], 'test')
    expect(cpp).toContain('"add"')
  })

  it('uses full symbol name when module prefix not found', () => {
    const cpp = generateAddonCpp([addFn], 'other')
    expect(cpp).toContain('"Math_add"')
  })

  // Callback tests
  it('generates a per-invocation threadsafe function for callbacks', () => {
    const cpp = generateAddonCpp([callbackFn, stopFn], 'monitor')
    expect(cpp).toContain(
      'struct CallbackState_monitor_start { napi_env env = nullptr; napi_threadsafe_function tsfn = nullptr; };',
    )
    expect(cpp).toContain('static void finalize_callback_monitor_start')
    expect(cpp).toContain('trampoline_monitor_start')
    expect(cpp).toContain('napi_create_threadsafe_function')
    expect(cpp).toContain('napi_unref_threadsafe_function(env, callback_state->tsfn)')
    expect(cpp).toContain('napi_ref_threadsafe_function(state->env, state->tsfn)')
    expect(cpp).toContain('unref_callback_delivery_monitor_start(env, state)')
  })

  it('generates a trampoline that copies string data with its byte length', () => {
    const cpp = generateAddonCpp([callbackFn, stopFn], 'monitor')
    expect(cpp).toContain('packed->arg0_len = static_cast<size_t>(arg0_len)')
    expect(cpp).toContain('memcpy(packed->arg0, arg0, packed->arg0_len)')
    expect(cpp).toContain('napi_call_threadsafe_function')
  })

  it('does not infer a callback relationship between separate exports', () => {
    const cpp = generateAddonCpp([callbackFn, stopFn], 'monitor')
    const stopBody = extractFnBody(cpp, 'static napi_value js_monitor_stop')
    expect(stopBody).toContain('monitor_stop()')
    expect(stopBody).not.toContain('tsfn_monitor_start')
  })

  // Like the sync wrapper, the callback wrapper must free string inputs and
  // release a threadsafe function it created when a later argument fails
  // validation.
  const cbStringFn: SwiftFunction = {
    symbolName: 'mon_watch',
    params: [
      { name: 'prefix', type: 'UnsafePointer<CChar>' },
      { name: 'callback', type: '@escaping @convention(c) (UnsafePointer<CChar>) -> Void' },
    ],
    returnType: 'Void',
    isAsync: false,
  }
  const cbTrailingFn: SwiftFunction = {
    symbolName: 'mon_start',
    params: [
      { name: 'callback', type: '@escaping @convention(c) (UnsafePointer<CChar>) -> Void' },
      { name: 'count', type: 'Int32' },
    ],
    returnType: 'Void',
    isAsync: false,
  }

  it('callback wrapper frees string inputs on an early return', () => {
    const body = extractFnBody(
      generateAddonCpp([cbStringFn], 'mon'),
      'static napi_value js_mon_watch',
    )
    expect(body).toContain('auto cleanup_args = [&]()')
    expect(body).toContain('delete[] prefix')
    expect(body).toContain('cleanup_args(); return nullptr;')
  })

  it('callback wrapper aborts only a tsfn it created on an early return', () => {
    const body = extractFnBody(
      generateAddonCpp([cbTrailingFn], 'mon'),
      'static napi_value js_mon_start',
    )
    // A flag ensures only this invocation's threadsafe function is aborted.
    expect(body).toContain('bool tsfn_created = false')
    expect(body).toContain('tsfn_created = true')
    expect(body).toMatch(
      /if \(tsfn_created\) \{[\s\S]*?napi_release_threadsafe_function\(callback_state->tsfn, napi_tsfn_abort\)/,
    )
    // The argument after the callback frees/aborts on failure instead of leaking.
    expect(body).toContain('cleanup_args(); return nullptr;')
  })

  it('registers a callback state only after trailing arguments validate', () => {
    const body = extractFnBody(
      generateAddonCpp([cbTrailingFn], 'mon'),
      'static napi_value js_mon_start',
    )
    const trailingArgValidated = body.indexOf('swift_node_get_int32(env, argv[1], &count')
    const callbackRegistered = body.indexOf('callbacks_mon_start.insert(callback_state)')

    expect(trailingArgValidated).toBeGreaterThan(-1)
    expect(callbackRegistered).toBeGreaterThan(-1)
    expect(trailingArgValidated).toBeLessThan(callbackRegistered)
  })

  // Async tests
  it('generates async data struct', () => {
    const cpp = generateAddonCpp([asyncFn], 'test')
    expect(cpp).toContain('struct AsyncData_Mod_slow')
    expect(cpp).toContain('napi_async_work work')
    expect(cpp).toContain('napi_deferred deferred')
    expect(cpp).toContain(
      'swift_node_get_int32(env, argv[0], &ctx->x, "Failed to read integer argument")',
    )
  })

  it('generates execute callback for async', () => {
    const cpp = generateAddonCpp([asyncFn], 'test')
    expect(cpp).toContain('static void execute_Mod_slow')
    expect(cpp).toContain('ctx->result = Mod_slow(ctx->x)')
  })

  it('generates complete callback that resolves promise', () => {
    const cpp = generateAddonCpp([asyncFn], 'test')
    expect(cpp).toContain('static void complete_Mod_slow')
    expect(cpp).toContain('napi_resolve_deferred')
    expect(cpp).toContain('napi_delete_async_work')
  })

  it('generates promise creation in JS entry', () => {
    const cpp = generateAddonCpp([asyncFn], 'test')
    expect(cpp).toContain('napi_create_promise')
    expect(cpp).toContain('napi_queue_async_work')
    expect(cpp).toContain('return promise')
  })

  // The async complete callback must settle the promise and release the async
  // work handle + context on every path, including when converting the result
  // to a JS value fails (e.g. an oversized string return). A bare `return;` in a
  // conversion branch would leak ctx + work and leave the promise pending forever.
  const asyncReturnCases: Array<{ label: string; returnType: string }> = [
    { label: 'int32', returnType: 'Int32' },
    { label: 'int64', returnType: 'Int' },
    { label: 'double', returnType: 'Double' },
    { label: 'bool', returnType: 'Bool' },
    { label: 'string', returnType: 'UnsafeMutablePointer<CChar>' },
    { label: 'optional string', returnType: 'UnsafeMutablePointer<CChar>?' },
  ]

  for (const { label, returnType } of asyncReturnCases) {
    it(`async complete callback settles and cleans up on conversion failure (${label})`, () => {
      const fn: SwiftFunction = {
        symbolName: 'Mod_op',
        params: [{ name: 'x', type: 'Int32' }],
        returnType,
        isAsync: true,
      }
      const body = extractFnBody(generateAddonCpp([fn], 'test'), 'static void complete_Mod_op')
      // No early return may bypass the settlement / cleanup below.
      expect(body).not.toMatch(/\breturn;/)
      // A failed conversion rejects the promise instead of leaving it pending.
      expect(body).toContain('napi_get_and_clear_last_exception')
      expect(body).toContain('napi_reject_deferred')
      // The async work handle and context are always released.
      expect(body).toContain('napi_delete_async_work(env, ctx->work)')
      expect(body).toContain('delete ctx')
    })
  }

  it('async complete callback still resolves the promise on success', () => {
    const body = extractFnBody(generateAddonCpp([asyncFn], 'test'), 'static void complete_Mod_slow')
    expect(body).toContain('napi_resolve_deferred(env, ctx->deferred, js_result)')
    expect(body).not.toMatch(/\breturn;/)
  })

  // Creating a JS string from a C string with NAPI_AUTO_LENGTH fatally aborts V8
  // when the string exceeds the maximum length. The generator passes an explicit
  // length (swift_node_create_string) so oversized strings fail gracefully and
  // become a thrown error / rejected promise instead of crashing the process.
  it('sync string return uses an explicit length', () => {
    const cpp = generateAddonCpp([greetFn], 'test')
    expect(cpp).toContain('swift_node_create_string(env, result, strlen(result), &js_result)')
    expect(cpp).not.toContain('napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH')
  })

  it('async string return uses an explicit length', () => {
    const fn: SwiftFunction = {
      symbolName: 'Mod_fetch',
      params: [],
      returnType: 'UnsafeMutablePointer<CChar>',
      isAsync: true,
    }
    const cpp = generateAddonCpp([fn], 'test')
    expect(cpp).toContain(
      'swift_node_create_string(env, ctx->result, strlen(ctx->result), &js_result)',
    )
    expect(cpp).not.toContain('napi_create_string_utf8(env, ctx->result, NAPI_AUTO_LENGTH')
  })

  it('callback string arguments use an explicit length', () => {
    const cpp = generateAddonCpp([callbackFn, stopFn], 'monitor')
    expect(cpp).toContain('swift_node_create_string(env, packed->arg0, packed->arg0_len, &argv[0])')
    expect(cpp).not.toContain('napi_create_string_utf8(env, packed->arg0, NAPI_AUTO_LENGTH')
  })

  it('callback trampoline frees packed string data on failed delivery or JS conversion', () => {
    const fn: SwiftFunction = {
      symbolName: 'mon_event',
      params: [
        {
          name: 'callback',
          type: '@escaping @convention(c) (UnsafePointer<CChar>, Int32) -> Void',
        },
      ],
      returnType: 'Void',
      isAsync: false,
    }
    const cpp = generateAddonCpp([fn], 'mon')
    const callJs = extractFnBody(cpp, 'static void call_js_mon_event')
    const trampoline = extractFnBody(cpp, 'static void trampoline_mon_event')

    expect(cpp).toContain('static void cleanup_trampoline_data_mon_event')
    expect(callJs).toContain('cleanup_trampoline_data_mon_event(packed); return;')
    expect(callJs).toContain('cleanup_trampoline_data_mon_event(packed);')
    expect(trampoline).toContain('cleanup_trampoline_data_mon_event(packed);')
    expect(trampoline).not.toContain('if (call_status != napi_ok) delete packed')
  })

  it('callback trampoline supports nullable string callback arguments', () => {
    const fn: SwiftFunction = {
      symbolName: 'mon_optional',
      params: [
        { name: 'callback', type: '@escaping @convention(c) (UnsafePointer<CChar>?) -> Void' },
      ],
      returnType: 'Void',
      isAsync: false,
    }
    const cpp = generateAddonCpp([fn], 'mon')
    expect(cpp).toContain('packed->arg0 = arg0 ? (char*)malloc(packed->arg0_len + 1) : nullptr')
    expect(cpp).toContain('if (arg0 && !packed->arg0) {')
    expect(cpp).toContain('napi_get_null(env, &argv[0])')
  })

  it('callback wrapper accepts nullable string inputs around a callback', () => {
    const fn: SwiftFunction = {
      symbolName: 'mon_watch',
      params: [
        { name: 'tag', type: 'UnsafePointer<CChar>?' },
        { name: 'callback', type: '@escaping @convention(c) (UnsafePointer<CChar>) -> Void' },
      ],
      returnType: 'Void',
      isAsync: false,
    }
    const body = extractFnBody(generateAddonCpp([fn], 'mon'), 'static napi_value js_mon_watch')
    expect(body).toContain('napi_valuetype tag_type')
    expect(body).toContain('tag_type != napi_null')
    expect(body).toContain("Expected argument 'tag' to be a string or null")
  })

  it('keeps NAPI_AUTO_LENGTH for fixed-size internal resource names', () => {
    const fn: SwiftFunction = {
      symbolName: 'Mod_fetch',
      params: [],
      returnType: 'UnsafeMutablePointer<CChar>',
      isAsync: true,
    }
    const cpp = generateAddonCpp([fn], 'test')
    expect(cpp).toContain('napi_create_string_utf8(env, "swift_node_async", NAPI_AUTO_LENGTH')
  })

  // The async entry wrapper used to allocate ctx and the Promise before
  // validating arguments, so an invalid argument leaked ctx (and any malloc'd
  // string inputs) and orphaned the Promise. Arguments are now validated first
  // and every failure path frees ctx.
  it('async entry validates arguments before committing a Promise', () => {
    const fn: SwiftFunction = {
      symbolName: 'Mod_load',
      params: [{ name: 'path', type: 'UnsafePointer<CChar>' }],
      returnType: 'Int32',
      isAsync: true,
    }
    const entry = extractFnBody(generateAddonCpp([fn], 'test'), 'static napi_value js_Mod_load')
    expect(entry.indexOf('swift_node_expect_type')).toBeLessThan(
      entry.indexOf('napi_create_promise'),
    )
    expect(entry).toContain('destroy_async_Mod_load(ctx); return nullptr;')
  })

  it('async wrapper generates a cleanup helper that frees string inputs', () => {
    const fn: SwiftFunction = {
      symbolName: 'Mod_load',
      params: [{ name: 'path', type: 'UnsafePointer<CChar>' }],
      returnType: 'Int32',
      isAsync: true,
    }
    const destroy = extractFnBody(
      generateAddonCpp([fn], 'test'),
      'static void destroy_async_Mod_load',
    )
    expect(destroy).toContain('free(ctx->path)')
    expect(destroy).toContain('delete ctx')
  })

  it('async entry accepts nullable string parameters', () => {
    const fn: SwiftFunction = {
      symbolName: 'Mod_find',
      params: [{ name: 'key', type: 'UnsafePointer<CChar>?' }],
      returnType: 'Int32',
      isAsync: true,
    }
    const entry = extractFnBody(generateAddonCpp([fn], 'test'), 'static napi_value js_Mod_find')
    expect(entry).toContain('napi_valuetype key_type')
    expect(entry).toContain('key_type != napi_null')
    expect(entry).toContain("Expected argument 'key' to be a string or null")
  })

  it('sync wrapper cleanup runs on conversion failure after string inputs', () => {
    const fn: SwiftFunction = {
      symbolName: 'Mod_repeat',
      params: [
        { name: 'value', type: 'UnsafePointer<CChar>' },
        { name: 'count', type: 'Int' },
      ],
      returnType: 'Int',
      isAsync: false,
    }
    const body = extractFnBody(generateAddonCpp([fn], 'test'), 'static napi_value js_Mod_repeat')
    expect(body).toContain('auto swift_node_cleanup_args = [&]()')
    expect(body).toContain('delete[] value')
    expect(body).toContain("Expected argument 'count' to be a number")
    expect(body).toContain('swift_node_cleanup_args(); return nullptr;')
  })

  // Struct tests
  it('generates struct conversion helpers', () => {
    const cpp = generateAddonCpp([structFn], 'test', [pointStruct, resultStruct])
    expect(cpp).toContain('Point_from_js')
    expect(cpp).toContain('Point_to_js')
    expect(cpp).toContain('DistanceResult_from_js')
    expect(cpp).toContain('DistanceResult_to_js')
  })

  it('from_js reads object properties', () => {
    const cpp = generateAddonCpp([structFn], 'test', [pointStruct])
    expect(cpp).toContain('napi_get_named_property(env, obj, "x", &prop)')
    expect(cpp).toContain('napi_get_value_double(env, prop, &result.x)')
  })

  it('to_js creates object with properties', () => {
    const cpp = generateAddonCpp([structFn], 'test', [pointStruct])
    expect(cpp).toContain('napi_create_object(env, &obj)')
    expect(cpp).toContain('napi_create_double(env, s.x, &prop)')
    expect(cpp).toContain('napi_set_named_property(env, obj, "x", prop)')
  })

  it('uses struct converters in wrapper function', () => {
    const cpp = generateAddonCpp([structFn], 'test', [pointStruct, resultStruct])
    expect(cpp).toContain('Point_from_js(env, argv[0], &a_ok)')
    expect(cpp).toContain('DistanceResult_to_js(env, result)')
  })

  it('converts Int and String struct fields through Node-API', () => {
    const cpp = generateAddonCpp([profileFn], 'test', [profileStruct])
    expect(cpp).toContain('swift_node_get_int64(env, prop, &result.id')
    expect(cpp).toContain('napi_get_value_string_utf8(env, prop, nullptr, 0, &result.name_len)')
    expect(cpp).toContain('char* name_buf = (char*)malloc(result.name_len + 1)')
    expect(cpp).toContain('free((void*)result.name)')
    expect(cpp).not.toContain('delete[] result.name')
    expect(cpp).toContain('napi_create_int64(env, s.id, &prop)')
    expect(cpp).toContain('napi_create_string_utf8(env, s.name, s.name_len, &prop)')
    expect(cpp).toContain('Profile_free_strings(result)')
  })
})

// --- TypeScript definition tests ---

describe('generateDts', () => {
  it('uses JavaScript-friendly types for JSON and Data transports', () => {
    const fn: SwiftFunction = {
      symbolName: 'test_process',
      params: [
        { name: 'items', type: 'UnsafePointer<CChar>', nativeType: '[String]', transport: 'json' },
        { name: 'bytes', type: 'UnsafePointer<CChar>', nativeType: 'Data', transport: 'data' },
      ],
      returnType: 'UnsafeMutablePointer<CChar>',
      nativeReturnType: '[String: Int]',
      returnTransport: 'json',
      isAsync: true,
    }
    const dts = generateDts([fn], 'test')
    expect(dts).toContain('items: string[]')
    expect(dts).toContain('bytes: Uint8Array')
    expect(dts).toContain('Promise<Record<string, number>>')
    expect(dts).toContain('export { __swift_node_0 as process }')
  })

  it('uses Uint8Array for borrowed byte inputs without exposing its ABI length', () => {
    const exported: ExportedFunction = {
      name: 'byteLength',
      params: [{ label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' }],
      returnType: 'Int',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const [fn] = exportedToSwiftFunctions([exported], 'test')
    const dts = generateDts([fn], 'test')

    expect(dts).toContain('bytes: Uint8Array')
    expect(dts).not.toContain('bytesLen')
  })

  it.each(['[String?]', 'Array<String?>'])(
    'parenthesizes nullable JSON array element types for %s',
    (nativeType) => {
      const fn: SwiftFunction = {
        symbolName: 'test_optionalItems',
        params: [{ name: 'items', type: 'UnsafePointer<CChar>', nativeType, transport: 'json' }],
        returnType: 'Void',
        isAsync: false,
      }

      const dts = generateDts([fn], 'test')
      expect(dts).toContain('items: (string | null)[]')
      expect(dts).toContain('export { __swift_node_0 as optionalItems }')
    },
  )

  it('preserves nested arrays of dictionaries in JSON transport declarations', () => {
    const fn: SwiftFunction = {
      symbolName: 'test_group',
      params: [
        {
          name: 'groups',
          type: 'UnsafePointer<CChar>',
          nativeType: 'Array<Dictionary<String, String>>',
          transport: 'json',
        },
      ],
      returnType: 'UnsafeMutablePointer<CChar>',
      nativeReturnType: '[[String: Int]]',
      returnTransport: 'json',
      isAsync: false,
    }

    const dts = generateDts([fn], 'test')
    expect(dts).toContain('groups: Record<string, string>[]')
    expect(dts).toContain('=> Record<string, number>[]')
    expect(dts).toContain('export { __swift_node_0 as group }')
  })

  it('uses base64 JSON shapes for Data nested in stream collection values', () => {
    const fn: SwiftFunction = {
      symbolName: 'test_dataStream',
      params: [],
      returnType: 'Void',
      nativeReturnType: 'Void',
      isAsync: false,
      stream: { elementType: '[Data]', isThrowing: false, transport: 'json' },
    }

    const dts = generateDts([fn], 'test')
    expect(dts).toContain('onValue: (value: string[]) => void')
  })

  it('emits Codable model declarations through JSON transport', () => {
    const exported: ExportedFunction = {
      name: 'respond',
      params: [{ label: '_', name: 'request', type: 'Profile' }],
      returnType: 'Profile',
      throws: true,
      isAsync: false,
      line: 1,
    }
    const [fn] = exportedToSwiftFunctions([exported], 'models', [profileStruct], ['Profile'])

    const dts = generateDts([fn], 'models', [profileStruct])
    expect(dts).toContain('declare const __swift_node_0: (request: unknown) => unknown')
    expect(dts).toContain('export { __swift_node_0 as respond }')
  })

  it('generates named TypeScript exports', () => {
    const dts = generateDts([addFn, greetFn], 'test')
    expect(dts).toContain('declare const __swift_node_0: (a: number, b: number) => number')
    expect(dts).toContain('export { __swift_node_0 as Math_add }')
    expect(dts).toContain('export { __swift_node_1 as Hello_greet }')
    expect(dts).not.toContain('NativeBindings')
    expect(dts).not.toContain('export default')
  })

  it('excludes error out params from TS signature', () => {
    const dts = generateDts([divideFn], 'test')
    expect(dts).toContain('(a: number, b: number) => number')
    expect(dts).not.toContain('outError')
  })

  it('generates nullable return type', () => {
    const dts = generateDts([nullableGetFn], 'test')
    expect(dts).toContain('string | null')
  })

  it('generates void return type', () => {
    const dts = generateDts([voidFn], 'test')
    expect(dts).toContain('() => void')
  })

  it('wraps async return in Promise', () => {
    const dts = generateDts([asyncFn], 'test')
    expect(dts).toContain('(x: number) => Promise<number>')
  })

  it('generates callback param type', () => {
    const dts = generateDts([callbackFn], 'test')
    expect(dts).toContain('callback: (arg0: string) => void')
  })

  it('generates nullable string callback param type', () => {
    const fn: SwiftFunction = {
      symbolName: 'test_on_change',
      params: [
        { name: 'callback', type: '@escaping @convention(c) (UnsafePointer<CChar>?) -> Void' },
      ],
      returnType: 'Void',
      isAsync: false,
    }
    const dts = generateDts([fn], 'test')
    expect(dts).toContain('callback: (arg0: string | null) => void')
  })

  it('generates numeric callback param types for Int64 callbacks', () => {
    const fn: SwiftFunction = {
      symbolName: 'test_on_count',
      params: [{ name: 'callback', type: '@escaping @convention(c) (Int) -> Void' }],
      returnType: 'Void',
      isAsync: false,
    }
    const dts = generateDts([fn], 'test')
    expect(dts).toContain('callback: (arg0: number) => void')
  })

  it('generates struct interfaces', () => {
    const dts = generateDts([structFn], 'test', [pointStruct, resultStruct])
    expect(dts).toContain('export interface Point')
    expect(dts).toContain('x: number')
    expect(dts).toContain('y: number')
    expect(dts).toContain('export interface DistanceResult')
  })

  it('types Int and String struct fields', () => {
    const dts = generateDts([], 'test', [profileStruct])
    expect(dts).toContain('id: number')
    expect(dts).toContain('name: string')
  })

  it('uses struct names as param/return types', () => {
    // structFn uses swift_node_Point params — the dts should map back to Point interface
    const fn: SwiftFunction = {
      symbolName: 'test_distance',
      params: [
        { name: 'a', type: 'swift_node_Point' },
        { name: 'b', type: 'swift_node_Point' },
      ],
      returnType: 'swift_node_DistanceResult',
      isAsync: false,
    }
    const dts = generateDts([fn], 'test', [pointStruct, resultStruct])
    expect(dts).toContain('(a: Point, b: Point) => DistanceResult')
  })

  it('supports named exports whose names are JavaScript reserved words', () => {
    const fn: SwiftFunction = {
      symbolName: 'test_delete',
      params: [{ name: 'key', type: 'UnsafePointer<CChar>' }],
      returnType: 'Bool',
      isAsync: false,
    }
    const dts = generateDts([fn], 'test')
    expect(dts).toContain('declare const __swift_node_0: (key: string) => boolean')
    expect(dts).toContain('export { __swift_node_0 as delete }')
  })
})

describe('generateDtsCjs', () => {
  it('generates CommonJS declarations for require consumers', () => {
    const dts = generateDtsCjs([addFn, greetFn], 'test')
    expect(dts).toContain('declare namespace native')
    expect(dts).toContain('interface NativeBindings')
    expect(dts).toContain('add(a: number, b: number): number')
    expect(dts).toContain('greet(name: string): string')
    expect(dts).toContain('declare const native: native.NativeBindings')
    expect(dts).toContain('export = native')
    expect(dts).not.toContain('export default native')
  })

  it('keeps struct types in scope for CommonJS declarations', () => {
    const dts = generateDtsCjs([structFn], 'test', [pointStruct, resultStruct])
    expect(dts).toContain('declare namespace native')
    expect(dts).toContain('interface Point')
    expect(dts).toContain('distance(a: Point, b: Point): DistanceResult')
    expect(dts).toContain('declare const native: native.NativeBindings')
    expect(dts).toContain('export = native')
  })

  it('uses base64 JSON shapes for CommonJS stream collection values', () => {
    const fn: SwiftFunction = {
      symbolName: 'test_dataStream',
      params: [],
      returnType: 'Void',
      nativeReturnType: 'Void',
      isAsync: false,
      stream: { elementType: '[Data]', isThrowing: false, transport: 'json' },
    }

    const dts = generateDtsCjs([fn], 'test')
    expect(dts).toContain('dataStream(onValue: (value: string[]) => void')
  })
})

// --- Export wrapper generation tests ---

const exportGetFn: ExportedFunction = {
  name: 'get',
  params: [{ label: '_', name: 'key', type: 'String' }],
  returnType: 'String?',
  throws: false,
  isAsync: false,
  line: 1,
}

const exportSetFn: ExportedFunction = {
  name: 'set',
  params: [
    { label: '_', name: 'key', type: 'String' },
    { label: '_', name: 'value', type: 'String' },
  ],
  returnType: 'Bool',
  throws: false,
  isAsync: false,
  line: 5,
}

const exportThrowingFn: ExportedFunction = {
  name: 'divide',
  params: [
    { label: '_', name: 'a', type: 'Double' },
    { label: '_', name: 'b', type: 'Double' },
  ],
  returnType: 'Double',
  throws: true,
  isAsync: false,
  line: 10,
}

const exportVoidFn: ExportedFunction = {
  name: 'stop',
  params: [],
  returnType: 'Void',
  throws: false,
  isAsync: false,
  line: 15,
}

const exportIntFn: ExportedFunction = {
  name: 'add',
  params: [
    { label: '_', name: 'a', type: 'Int' },
    { label: '_', name: 'b', type: 'Int' },
  ],
  returnType: 'Int',
  throws: false,
  isAsync: false,
  line: 20,
}

const exportLabeledFn: ExportedFunction = {
  name: 'store',
  params: [
    { label: 'key', name: 'k', type: 'String' },
    { label: 'value', name: 'v', type: 'String' },
  ],
  returnType: 'Bool',
  throws: false,
  isAsync: false,
  line: 25,
}

describe('generateWrappersSwift', () => {
  it('bridges Codable values through JSON and exposes an error channel', () => {
    const fn: ExportedFunction = {
      name: 'respond',
      params: [{ label: '_', name: 'request', type: 'Request' }],
      returnType: 'Response',
      throws: true,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models', [], ['Request', 'Response'])
    expect(output).toContain('_ request: UnsafePointer<CChar>')
    expect(output).toContain('JSONDecoder().decode(Request.self')
    expect(output).toContain('JSONEncoder().encode(result)')
    expect(output).toContain('out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>')
  })

  it('bridges direct JSON arrays and dictionaries through the error channel', () => {
    const fn: ExportedFunction = {
      name: 'compact',
      params: [
        { label: '_', name: 'items', type: '[String?]' },
        { label: '_', name: 'metadata', type: 'Dictionary<String, Int>' },
      ],
      returnType: '[String]',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models')

    expect(output).toContain('JSONDecoder().decode([String?].self')
    expect(output).toContain('JSONDecoder().decode(Dictionary<String, Int>.self')
    expect(output).toContain('JSONEncoder().encode(result)')
    expect(output).toContain('out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>')
  })

  it('bridges Data through a source-level async wrapper', () => {
    const fn: ExportedFunction = {
      name: 'reverse',
      params: [{ label: '_', name: 'input', type: 'Data' }],
      returnType: 'Data',
      throws: false,
      isAsync: true,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models')

    expect(output).toContain('Data(base64Encoded: String(cString: input))')
    expect(output).toContain('asyncResult = await reverse(swift_input)')
    expect(output).toContain('result.base64EncodedString()')
  })

  it('constructs a synchronous UnsafeRawBufferPointer view without decoding base64', () => {
    const fn: ExportedFunction = {
      name: 'byteLength',
      params: [{ label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' }],
      returnType: 'Int',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models')

    expect(output).toContain(
      'public func _sn_models_byteLength(_ bytes: UnsafeRawPointer?, _ bytesLen: Int, _ out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int {',
    )
    expect(output).toContain(
      'let swift_bytes = UnsafeRawBufferPointer(start: bytes, count: bytesLen)',
    )
    expect(output).not.toContain('Data(base64Encoded: String(cString: bytes))')
  })

  it('uses Codable JSON transport when a matching native struct is available', () => {
    const fn: ExportedFunction = {
      name: 'respond',
      params: [{ label: '_', name: 'request', type: 'Profile' }],
      returnType: 'Profile',
      throws: true,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models', [profileStruct], ['Profile'])

    expect(output).toContain(
      'public func _sn_models_respond(_ request: UnsafePointer<CChar>, _ out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> UnsafeMutablePointer<CChar> {',
    )
    expect(output).toContain('JSONEncoder().encode(result)')
    expect(output).not.toContain('swift_node_Profile')
  })

  it.each([
    {
      label: 'JSON',
      type: '[String]',
      failurePath: [
        '    let swift_value: [String]',
        '    do {',
        '        swift_value = try JSONDecoder().decode([String].self, from: Data(String(cString: value).utf8))',
        '    } catch {',
        '        out_error.pointee = UnsafeMutablePointer(mutating: strdup("swift-node could not encode or decode a bridged value")!)',
        '        return',
        '    }',
      ].join('\n'),
    },
    {
      label: 'Data',
      type: 'Data',
      failurePath: [
        '    guard let swift_value = Data(base64Encoded: String(cString: value)) else {',
        '        out_error.pointee = UnsafeMutablePointer(mutating: strdup("swift-node could not encode or decode a bridged value")!)',
        '        return',
        '    }',
      ].join('\n'),
    },
  ])('exits a Void wrapper when $label argument decoding fails', ({ type, failurePath }) => {
    const fn: ExportedFunction = {
      name: 'save',
      params: [{ label: '_', name: 'value', type }],
      returnType: 'Void',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models')

    expect(output).toContain(failurePath)
  })

  it('returns a dummy ABI struct when JSON argument decoding fails', () => {
    const fn: ExportedFunction = {
      name: 'decodeProfile',
      params: [{ label: '_', name: 'items', type: '[String]' }],
      returnType: 'Profile',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models', [profileStruct])

    expect(output).toContain(
      [
        '    let swift_items: [String]',
        '    do {',
        '        swift_items = try JSONDecoder().decode([String].self, from: Data(String(cString: items).utf8))',
        '    } catch {',
        '        out_error.pointee = UnsafeMutablePointer(mutating: strdup("swift-node could not encode or decode a bridged value")!)',
        '        return swift_node_Profile()',
        '    }',
      ].join('\n'),
    )
  })

  it('returns a dummy ABI struct when a throwing export fails', () => {
    const fn: ExportedFunction = {
      name: 'findProfile',
      params: [],
      returnType: 'Profile',
      throws: true,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models', [profileStruct])

    expect(output).toContain(
      [
        '    } catch {',
        '        out_error.pointee = UnsafeMutablePointer(mutating: strdup(error.localizedDescription)!)',
        '        return swift_node_Profile()',
        '    }',
      ].join('\n'),
    )
  })

  it('waits for a source-level async throwing export off the Node event loop', () => {
    const fn: ExportedFunction = {
      name: 'respond',
      params: [{ label: '_', name: 'prompt', type: 'String' }],
      returnType: 'String',
      throws: true,
      isAsync: true,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models')
    expect(output).toContain('let semaphore = DispatchSemaphore(value: 0)')
    expect(output).toContain('asyncResult = try await respond(')
    expect(output).toContain('out_error.pointee')
  })

  it('runs MainActor exports synchronously on Node’s main thread', () => {
    const fn: ExportedFunction = {
      name: 'updateTitle',
      params: [{ label: '_', name: 'title', type: 'String' }],
      returnType: 'String',
      throws: false,
      isAsync: false,
      actorIsolation: 'MainActor',
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models')
    const [bridge] = exportedToSwiftFunctions([fn], 'models')

    expect(output).toContain('MainActor.assumeIsolated { updateTitle(swift_title) }')
    expect(bridge.isAsync).toBe(false)
  })

  it('runs custom global-actor exports through the async bridge', () => {
    const fn: ExportedFunction = {
      name: 'updateTitle',
      params: [{ label: '_', name: 'title', type: 'String' }],
      returnType: 'String',
      throws: false,
      isAsync: false,
      actorIsolation: 'DatabaseActor',
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models')
    const [bridge] = exportedToSwiftFunctions([fn], 'models')

    expect(output).toContain('Task { @DatabaseActor in')
    expect(output).toContain('asyncResult = updateTitle(swift_title)')
    expect(bridge.isAsync).toBe(true)
  })

  it('generates @_cdecl wrapper for string function', () => {
    const output = generateWrappersSwift([exportGetFn], 'secure_storage')
    expect(output).toContain('@_cdecl("secure_storage_get")')
    expect(output).toContain('public func _sn_secure_storage_get')
    expect(output).toContain('UnsafePointer<CChar>')
    expect(output).toContain('UnsafeMutablePointer<CChar>?')
    expect(output).toContain('swiftNodeDecodeUTF8(key, keyLen)')
    expect(output).toContain('swiftNodeCopyUTF8(result)!')
  })

  it('generates wrapper for nullable string return', () => {
    const output = generateWrappersSwift([exportGetFn], 'mod')
    expect(output).toContain('guard let result = result else { return nil }')
  })

  it('generates wrapper for Bool return', () => {
    const output = generateWrappersSwift([exportSetFn], 'mod')
    expect(output).toContain('@_cdecl("mod_set")')
    expect(output).toContain('-> Bool')
    expect(output).toContain('return result')
  })

  it('generates wrapper with error out param for throws', () => {
    const output = generateWrappersSwift([exportThrowingFn], 'math')
    expect(output).toContain('@_cdecl("math_divide")')
    expect(output).toContain('out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>')
    expect(output).toContain('do {')
    expect(output).toContain('try divide(')
    expect(output).toContain('} catch {')
    expect(output).toContain('strdup(error.localizedDescription)')
    expect(output).toContain('return 0')
  })

  it('generates wrapper for void function', () => {
    const output = generateWrappersSwift([exportVoidFn], 'mod')
    expect(output).toContain('@_cdecl("mod_stop")')
    expect(output).toContain('public func _sn_mod_stop() {')
    expect(output).toContain('stop()')
  })

  it('generates wrapper for Int (64-bit) params', () => {
    const output = generateWrappersSwift([exportIntFn], 'math')
    expect(output).toContain('@_cdecl("math_add")')
    // Int stays as Int in @_cdecl (it's C-compatible on macOS)
    expect(output).toContain('_ a: Int')
    expect(output).toContain('_ b: Int')
  })

  it('preserves Int64 and converts Float values at the C ABI boundary', () => {
    const int64Fn: ExportedFunction = {
      name: 'incrementInt64',
      params: [{ label: '_', name: 'value', type: 'Int64' }],
      returnType: 'Int64',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const floatFn: ExportedFunction = {
      name: 'scaleFloat',
      params: [{ label: '_', name: 'value', type: 'Float' }],
      returnType: 'Float',
      throws: false,
      isAsync: false,
      line: 2,
    }
    const output = generateWrappersSwift([int64Fn, floatFn], 'mod')
    const [int64Bridge, floatBridge] = exportedToSwiftFunctions([int64Fn, floatFn], 'mod')

    expect(output).toContain('public func _sn_mod_incrementInt64(_ value: Int64) -> Int64')
    expect(output).toContain('public func _sn_mod_scaleFloat(_ value: Double) -> Double')
    expect(output).toContain('let swift_value = Float(value)')
    expect(output).toContain('return Double(result)')
    expect(int64Bridge).toMatchObject({
      params: [{ name: 'value', type: 'Int64' }],
      returnType: 'Int64',
    })
    expect(floatBridge).toMatchObject({
      params: [{ name: 'value', type: 'Double' }],
      returnType: 'Double',
    })
  })

  it('generates correct error return for throws + non-optional String', () => {
    const fn: ExportedFunction = {
      name: 'uppercase',
      params: [{ label: '_', name: 'input', type: 'String' }],
      returnType: 'String',
      throws: true,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'mod')
    const wrapper = output.slice(output.indexOf('@_cdecl("mod_uppercase")'))
    // Non-optional String can't return nil on error — must return a dummy allocated string
    expect(output).toContain('return UnsafeMutablePointer(mutating: strdup("")!)')
    expect(wrapper).not.toContain('return nil')
  })

  it('generates nil error return for throws + optional String', () => {
    const fn: ExportedFunction = {
      name: 'find',
      params: [{ label: '_', name: 'key', type: 'String' }],
      returnType: 'String?',
      throws: true,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'mod')
    expect(output).toContain('return nil')
  })

  it('generates wrapper with labeled arguments', () => {
    const output = generateWrappersSwift([exportLabeledFn], 'mod')
    expect(output).toContain('store(key: swift_k, value: swift_v)')
  })

  it('bridges multi-argument callbacks with String without leaking strdup buffers', () => {
    const fn: ExportedFunction = {
      name: 'watch',
      params: [{ label: '_', name: 'onEvent', type: '@escaping (String, Int) -> Void' }],
      returnType: 'Void',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'mod')
    expect(output).toContain('let swift_onEvent: (String, Int) -> Void = { cbArg0, cbArg1 in')
    expect(output).toContain('cbArg0.withCString { cStr0 in')
    expect(output).toContain('onEvent(onEventContext, cStr0, cbArg0.utf8.count, cbArg1)')
    expect(output).not.toContain('strdup(cbArg0)')
  })

  it('bridges optional String callback arguments as null-safe C pointers', () => {
    const fn: ExportedFunction = {
      name: 'watch',
      params: [{ label: '_', name: 'onEvent', type: '@escaping (String?) -> Void' }],
      returnType: 'Void',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'mod')
    expect(output).toContain('let swift_onEvent: (String?) -> Void = { cbArg0 in')
    expect(output).toContain('if let cbArg0 = cbArg0 {')
    expect(output).toContain('cbArg0.withCString { cStr0 in')
    expect(output).toContain('onEvent(onEventContext, cStr0, cbArg0.utf8.count)')
    expect(output).toContain('} else {')
    expect(output).toContain('onEvent(onEventContext, nil, 0)')
  })

  it('includes file header comment', () => {
    const output = generateWrappersSwift([exportVoidFn], 'mod')
    expect(output).toContain('Generated by swift-node')
    expect(output).toContain('do not edit')
    expect(output).toContain('import Foundation')
  })

  it('returns empty string when no exports', () => {
    expect(generateWrappersSwift([], 'mod')).toBe('')
  })

  it('generates multiple wrappers', () => {
    const output = generateWrappersSwift([exportGetFn, exportSetFn], 'mod')
    expect(output).toContain('@_cdecl("mod_get")')
    expect(output).toContain('@_cdecl("mod_set")')
  })
})

describe('exportedToSwiftFunctions', () => {
  it('uses JSON C strings for annotated Codable values', () => {
    const fn: ExportedFunction = {
      name: 'respond',
      params: [{ label: '_', name: 'request', type: 'Request' }],
      returnType: 'Response',
      throws: true,
      isAsync: false,
      line: 1,
    }
    const [cdecl] = exportedToSwiftFunctions([fn], 'models', [], ['Request', 'Response'])
    expect(cdecl.params[0]).toMatchObject({
      type: 'UnsafePointer<CChar>',
      nativeType: 'Request',
      transport: 'json',
    })
    expect(cdecl.returnType).toBe('UnsafeMutablePointer<CChar>')
    expect(cdecl.returnTransport).toBe('json')
  })

  it('uses JSON and binary transports for direct structured native async values', () => {
    const fn: ExportedFunction = {
      name: 'transform',
      params: [
        { label: '_', name: 'items', type: '[String?]' },
        { label: '_', name: 'counts', type: 'Dictionary<String, Int>' },
        { label: '_', name: 'input', type: 'Data' },
      ],
      returnType: 'Data',
      throws: false,
      isAsync: true,
      line: 1,
    }
    const [cdecl] = exportedToSwiftFunctions([fn], 'models')

    expect(cdecl.params).toEqual([
      { name: 'items', type: 'UnsafePointer<CChar>', nativeType: '[String?]', transport: 'json' },
      {
        name: 'counts',
        type: 'UnsafePointer<CChar>',
        nativeType: 'Dictionary<String, Int>',
        transport: 'json',
      },
      { name: 'input', type: 'UnsafePointer<CChar>', nativeType: 'Data', transport: 'data' },
      { name: 'outError', type: 'UnsafeMutablePointer<UnsafePointer<CChar>?>' },
    ])
    expect(cdecl.returnType).toBe('UnsafeMutablePointer<CChar>')
    expect(cdecl.nativeReturnType).toBe('Data')
    expect(cdecl.returnTransport).toBe('data')
    expect(cdecl.isAsync).toBe(true)
  })

  it('uses a raw pointer and generated length only for borrowed byte inputs', () => {
    const fn: ExportedFunction = {
      name: 'byteLength',
      params: [{ label: '_', name: 'bytes', type: 'UnsafeRawBufferPointer' }],
      returnType: 'Int',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const [cdecl] = exportedToSwiftFunctions([fn], 'models')

    expect(cdecl.params).toEqual([
      {
        name: 'bytes',
        type: 'UnsafeRawPointer?',
        nativeType: 'UnsafeRawBufferPointer',
        transport: 'borrowed',
      },
      { name: 'bytesLen', type: 'Int', bridgeBorrowedBufferLengthFor: 'bytes' },
      { name: 'outError', type: 'UnsafeMutablePointer<UnsafePointer<CChar>?>' },
    ])
  })

  it('converts exported function to SwiftFunction with C-compatible types', () => {
    const fns = exportedToSwiftFunctions([exportGetFn], 'secure_storage')
    expect(fns).toHaveLength(1)
    expect(fns[0].symbolName).toBe('secure_storage_get')
    expect(fns[0].params[0].type).toBe('UnsafePointer<CChar>')
    expect(fns[0].returnType).toBe('UnsafeMutablePointer<CChar>?')
  })

  it('adds error out param for throwing functions', () => {
    const fns = exportedToSwiftFunctions([exportThrowingFn], 'math')
    expect(fns).toHaveLength(1)
    const lastParam = fns[0].params[fns[0].params.length - 1]
    expect(lastParam.type).toContain('UnsafeMutablePointer<UnsafePointer<CChar>?>')
  })

  it('preserves isAsync flag', () => {
    const asyncFn: ExportedFunction = { ...exportGetFn, isAsync: true }
    const fns = exportedToSwiftFunctions([asyncFn], 'mod')
    expect(fns[0].isAsync).toBe(true)
  })

  it('maps Int to Int (64-bit C-compatible)', () => {
    const fns = exportedToSwiftFunctions([exportIntFn], 'math')
    expect(fns[0].params[0].type).toBe('Int')
    expect(fns[0].returnType).toBe('Int')
  })

  it('maps struct params to C struct types', () => {
    const fn: ExportedFunction = {
      name: 'distance',
      params: [
        { label: '_', name: 'a', type: 'Point' },
        { label: '_', name: 'b', type: 'Point' },
      ],
      returnType: 'DistanceResult',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const fns = exportedToSwiftFunctions([fn], 'math', [pointStruct, resultStruct])
    expect(fns[0].params[0].type).toBe('swift_node_Point')
    expect(fns[0].params[1].type).toBe('swift_node_Point')
    expect(fns[0].returnType).toBe('swift_node_DistanceResult')
  })
})

describe('generateWrappersSwift with structs', () => {
  it('generates wrapper that accepts C struct and constructs Swift struct', () => {
    const fn: ExportedFunction = {
      name: 'distance',
      params: [
        { label: '_', name: 'a', type: 'Point' },
        { label: '_', name: 'b', type: 'Point' },
      ],
      returnType: 'DistanceResult',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'math', [pointStruct, resultStruct])
    expect(output).toContain('@_cdecl("math_distance")')
    expect(output).toContain('swift_node_Point')
    expect(output).toContain('Point(x: a.x, y: a.y)')
    expect(output).toContain('swift_node_DistanceResult')
    expect(output).toContain('cResult.distance = result.distance')
  })

  it('converts native String and Int struct fields in Swift wrappers', () => {
    const fn: ExportedFunction = {
      name: 'rename',
      params: [{ label: '_', name: 'profile', type: 'Profile' }],
      returnType: 'Profile',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'profiles', [profileStruct])
    expect(output).toContain(
      'Profile(id: Int(profile.id), name: swiftNodeDecodeUTF8(profile.name, profile.name_len))',
    )
    expect(output).toContain('cResult.id = Int64(result.id)')
    expect(output).toContain('cResult.name = UnsafePointer(swiftNodeCopyUTF8(result.name)!)')
    expect(output).toContain('cResult.name_len = result.name.utf8.count')
  })

  it('converts C double struct fields before initializing Swift Float fields', () => {
    const fn: ExportedFunction = {
      name: 'echoFloatVector',
      params: [{ label: '_', name: 'vector', type: 'FloatVector' }],
      returnType: 'FloatVector',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models', [floatVectorStruct])

    expect(output).toContain('FloatVector(x: Float(vector.x))')
  })

  it('converts Swift Float struct fields before returning C doubles', () => {
    const fn: ExportedFunction = {
      name: 'echoFloatVector',
      params: [{ label: '_', name: 'vector', type: 'FloatVector' }],
      returnType: 'FloatVector',
      throws: false,
      isAsync: false,
      line: 1,
    }
    const output = generateWrappersSwift([fn], 'models', [floatVectorStruct])

    expect(output).toContain('cResult.x = Double(result.x)')
  })
})

describe('end-to-end: export annotation pipeline', () => {
  it('generates consistent output across all stages for a mixed export source', () => {
    // Simulate what the CLI does: parse exports → generate wrappers → convert to cdecl → generate C++/bridge/dts
    const exportedFns: ExportedFunction[] = [
      {
        name: 'greet',
        params: [{ label: '_', name: 'name', type: 'String' }],
        returnType: 'String',
        throws: false,
        isAsync: false,
        line: 2,
      },
      {
        name: 'add',
        params: [
          { label: '_', name: 'a', type: 'Int' },
          { label: '_', name: 'b', type: 'Int' },
        ],
        returnType: 'Int',
        throws: false,
        isAsync: false,
        line: 7,
      },
      {
        name: 'divide',
        params: [
          { label: '_', name: 'a', type: 'Double' },
          { label: '_', name: 'b', type: 'Double' },
        ],
        returnType: 'Double',
        throws: true,
        isAsync: false,
        line: 12,
      },
    ]

    // Stage 1: Generate wrappers.swift
    const wrappersSwift = generateWrappersSwift(exportedFns, 'test_mod')
    expect(wrappersSwift).toContain('@_cdecl("test_mod_greet")')
    expect(wrappersSwift).toContain('@_cdecl("test_mod_add")')
    expect(wrappersSwift).toContain('@_cdecl("test_mod_divide")')
    expect(wrappersSwift).toContain('swiftNodeDecodeUTF8(name, nameLen)')
    expect(wrappersSwift).toContain('swiftNodeCopyUTF8(result)!')
    expect(wrappersSwift).toContain('out_error')
    expect(wrappersSwift).toContain('do {')

    // Stage 2: Convert to SwiftFunction[] for the C++ generator
    const cdeclFns = exportedToSwiftFunctions(exportedFns, 'test_mod')
    expect(cdeclFns).toHaveLength(3)
    expect(cdeclFns[0].symbolName).toBe('test_mod_greet')
    expect(cdeclFns[0].params[0].type).toBe('UnsafePointer<CChar>')
    expect(cdeclFns[1].symbolName).toBe('test_mod_add')
    expect(cdeclFns[1].params[0].type).toBe('Int') // 64-bit
    expect(cdeclFns[2].symbolName).toBe('test_mod_divide')
    // divide has error out param added
    expect(cdeclFns[2].params.length).toBe(3)

    // Stage 3: Generate C++ from the cdecl representations
    const cpp = generateAddonCpp(cdeclFns, 'test_mod')
    expect(cpp).toContain('js_test_mod_greet')
    expect(cpp).toContain('js_test_mod_add')
    expect(cpp).toContain('js_test_mod_divide')
    expect(cpp).toContain('swift_node_create_string')
    expect(cpp).toContain('swift_error')

    // Stage 4: Generate bridge header
    const bridge = generateBridgeH(cdeclFns, 'test_mod')
    expect(bridge).toContain('test_mod_greet')
    expect(bridge).toContain('test_mod_add')
    expect(bridge).toContain('test_mod_divide')

    // Stage 5: Generate TypeScript definitions
    const dts = generateDts(cdeclFns, 'test_mod')
    expect(dts).toContain('(name: string) => string')
    expect(dts).toContain('(a: number, b: number) => number')
    // divide has error param excluded from TS
    expect(dts).toContain('export { __swift_node_2 as divide }')
  })

  it('handles async + export through the full pipeline', () => {
    const asyncExport: ExportedFunction = {
      name: 'processImage',
      params: [{ label: '_', name: 'data', type: 'String' }],
      returnType: 'String',
      throws: false,
      isAsync: true,
      line: 1,
    }

    const cdeclFns = exportedToSwiftFunctions([asyncExport], 'mod')
    expect(cdeclFns[0].isAsync).toBe(true)

    const cpp = generateAddonCpp(cdeclFns, 'mod')
    expect(cpp).toContain('napi_create_promise')
    expect(cpp).toContain('napi_create_async_work')

    const dts = generateDts(cdeclFns, 'mod')
    expect(dts).toContain('(data: string) => Promise<string>')
  })
})

describe('generateEntryMjs', () => {
  it('generates a pure JS ESM entry point that loads the addon', () => {
    const entry = generateEntryMjs([addFn, greetFn], 'my_addon')
    expect(entry).toContain("import { createRequire } from 'node:module'")
    expect(entry).toContain("import { fileURLToPath } from 'node:url'")
    expect(entry).toContain('const require = createRequire(import.meta.url)')
    expect(entry).toContain('const __dirname = path.dirname(fileURLToPath(import.meta.url))')
    expect(entry).not.toContain('loadLocalAddon')
    expect(entry).not.toContain('findNodeBinary')
    expect(entry).not.toContain('readdirSync')
    expect(entry).toContain('function resolveAddonPath(dir, moduleName)')
    expect(entry).toContain("moduleName + '.' + target + '.node'")
    expect(entry).not.toContain("moduleName + '.node'")
    expect(entry).toContain('const native = require(resolveAddonPath(__dirname, "my_addon"))')
    expect(entry).toContain('const __swift_node_0 = native["Math_add"]')
    expect(entry).toContain('export { __swift_node_0 as Math_add }')
    expect(entry).toContain('export { __swift_node_1 as Hello_greet }')
    expect(entry).not.toContain('export default')
  })

  it('does not contain TypeScript syntax', () => {
    const entry = generateEntryMjs([addFn], 'my_addon')
    expect(entry).not.toContain('import type')
    expect(entry).not.toContain('<NativeBindings>')
    expect(entry).not.toContain(': string')
  })

  it('exports reserved names through a safe binding', () => {
    const fn: SwiftFunction = {
      symbolName: 'my_addon_delete',
      params: [],
      returnType: 'Bool',
      isAsync: false,
    }
    const entry = generateEntryMjs([fn], 'my_addon')
    expect(entry).toContain('const __swift_node_0 = native["delete"]')
    expect(entry).toContain('export { __swift_node_0 as delete }')
  })

  it('resolves binaries from the generated runtime directory', () => {
    const entry = generateEntryMjs([addFn], 'my_addon')
    expect(entry).toContain('resolveAddonPath(__dirname, "my_addon")')
  })

  it('includes do-not-edit header', () => {
    const entry = generateEntryMjs([addFn], 'my_addon')
    expect(entry).toContain('Generated by swift-node')
  })
})

describe('generateEntryCjs', () => {
  it('generates a CJS entry point with require()', () => {
    const entry = generateEntryCjs([addFn, greetFn], 'my_addon')
    expect(entry).toContain("require('node:path')")
    expect(entry).not.toContain('loadLocalAddon')
    expect(entry).not.toContain('findNodeBinary')
    expect(entry).not.toContain('readdirSync')
    expect(entry).toContain('function resolveAddonPath(dir, moduleName)')
    expect(entry).toContain("moduleName + '.' + target + '.node'")
    expect(entry).not.toContain("moduleName + '.node'")
    expect(entry).toContain('const native = require(resolveAddonPath(__dirname, "my_addon"))')
    expect(entry).toContain('module.exports = {')
    expect(entry).toContain('"Math_add": native["Math_add"]')
    expect(entry).toContain('"Hello_greet": native["Hello_greet"]')
  })

  it('resolves binaries from the generated runtime directory', () => {
    const entry = generateEntryCjs([addFn], 'my_addon')
    expect(entry).toContain('resolveAddonPath(__dirname, "my_addon")')
  })
})

describe('generated addon resolver', () => {
  it('uses one resolver implementation for ESM and CommonJS entrypoints', () => {
    const resolver = (entry: string) =>
      entry.slice(entry.indexOf('function resolveAddonPath'), entry.indexOf('const native'))
    expect(resolver(generateEntryMjs([addFn], 'my_addon'))).toBe(
      resolver(generateEntryCjs([addFn], 'my_addon')),
    )
  })

  it('loads only the exact target-qualified binary', () => {
    withGeneratedAddonProject((projectDir) => {
      const generatedDir = path.join(projectDir, 'dist_swift-node')
      mkdirSync(generatedDir, { recursive: true })
      writeFileSync(path.join(generatedDir, 'my_addon.node'), '')
      writeFileSync(path.join(generatedDir, 'my_addon.other-arch.node'), '')
      const namedTargetBinary = generatedTargetBinaryPath(projectDir, 'my_addon')
      mkdirSync(path.dirname(namedTargetBinary), { recursive: true })
      writeFileSync(namedTargetBinary, '')

      expect(loadGeneratedCjsEntry(projectDir, 'my_addon')).toBe(namedTargetBinary)
    })
  })

  it('rejects every other binary name', () => {
    withGeneratedAddonProject((projectDir) => {
      const generatedDir = path.join(projectDir, 'dist_swift-node')
      mkdirSync(generatedDir, { recursive: true })
      writeFileSync(path.join(generatedDir, 'my_addon.node'), '')
      writeFileSync(path.join(generatedDir, 'my_addon.other-arch.node'), '')

      expect(() => loadGeneratedCjsEntry(projectDir, 'my_addon')).toThrow('No .node binary found')
    })
  })

  it('reports the exact expected path and recovery action when no binary is available', () => {
    withGeneratedAddonProject((projectDir) => {
      let error: unknown
      try {
        loadGeneratedCjsEntry(projectDir, 'my_addon')
      } catch (caught) {
        error = caught
      }

      expect(String(error)).toContain(
        `No .node binary found for ${process.platform}-${process.arch}.`,
      )
      expect(String(error)).toContain(`  ${generatedTargetBinaryPath(projectDir, 'my_addon')}`)
      expect(String(error)).toContain("Run 'swift-node build' for this platform and architecture.")
    })
  })

  it('does not load a glibc prebuild on musl Linux', () => {
    withGeneratedAddonProject((projectDir) => {
      const muslProcess = {
        platform: 'linux',
        arch: 'x64',
        report: { getReport: () => ({ header: {} }) },
      }

      expect(() => loadGeneratedCjsEntry(projectDir, 'my_addon', muslProcess)).toThrow(
        'No .node binary found for linux-x64-musl.',
      )
    })
  })
})

describe('generated local entry point', () => {
  it('re-exports the generated runtime from the source entry point', () => {
    expect(generateSourceEntryTs()).toBe("export * from '../dist_swift-node/index.mjs'\n")
  })
})
