import {
  type BridgeTransport,
  type SwiftFunction,
  type SwiftParam,
  type SwiftStruct,
  classifySwiftType,
  type SwiftTypeCategory,
  isCallbackType,
  parseCallbackType,
  classifyNativeSwiftType,
} from '../parser.js'

import {
  cppIdentifier,
  cppReturnType,
  cppType,
  cppTypeFromCategory,
  findStruct,
  isNullableType,
  jsName,
  jsParams,
  streamElementUsesStringLength,
} from './shared.js'

// --- C++ addon generation ---

function callbackParamCategory(type: string): SwiftTypeCategory {
  const generated = classifySwiftType(type)
  return generated === 'unknown' ? classifyNativeSwiftType(type) : generated
}

function hasErrorOutParam(fn: SwiftFunction): boolean {
  return fn.params.some((p) => p.type.includes('UnsafeMutablePointer<UnsafePointer<CChar>?>'))
}

function getCallbackParam(fn: SwiftFunction): SwiftParam | null {
  return fn.params.find((p) => isCallbackType(p.type)) || null
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
      lines.push(generateJsWrapper(fn, structs))
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
