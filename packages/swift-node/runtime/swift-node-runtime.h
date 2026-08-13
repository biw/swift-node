#ifndef SWIFT_NODE_RUNTIME_H
#define SWIFT_NODE_RUNTIME_H

#include <cstdlib>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#include <node_api.h>

// RAII wrapper for strdup'd strings from Swift.
// Ensures free() is called even if napi calls throw.
struct AutoFreeStr {
    const char* ptr;
    AutoFreeStr(const char* p) : ptr(p) {}
    ~AutoFreeStr() { if (ptr) free(const_cast<char*>(ptr)); }
    AutoFreeStr(const AutoFreeStr&) = delete;
    AutoFreeStr& operator=(const AutoFreeStr&) = delete;
};

// Throw a JS error from a Swift error string, then free it.
static inline napi_value throw_swift_error(napi_env env, const char* msg) {
    AutoFreeStr guard(msg);
    napi_throw_error(env, nullptr, msg);
    return nullptr;
}

static inline napi_value swift_node_throw_type_error(napi_env env, const char* msg) {
    napi_throw_type_error(env, nullptr, msg);
    return nullptr;
}

static inline bool swift_node_napi_ok(napi_env env, napi_status status, const char* fallback_msg) {
    if (status == napi_ok) return true;
    if (status != napi_pending_exception) {
        const napi_extended_error_info* info = nullptr;
        napi_get_last_error_info(env, &info);
        const char* msg = (info && info->error_message) ? info->error_message : fallback_msg;
        napi_throw_error(env, nullptr, msg);
    }
    return false;
}

// Thread-safe function callbacks have no JavaScript caller to receive an
// exception. Clear a callback exception after delivery so it neither leaks
// into a later Node-API call nor triggers Node's uncaught-callback warning.
static inline void swift_node_call_function_without_propagating_exception(
    napi_env env,
    napi_value receiver,
    napi_value callback,
    size_t argc,
    napi_value* argv) {
    if (napi_call_function(env, receiver, callback, argc, argv, nullptr) == napi_pending_exception) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
    }
}

static inline bool swift_node_expect_argc(napi_env env, size_t actual, size_t expected) {
    if (actual >= expected) return true;
    napi_throw_type_error(env, nullptr, "Not enough arguments");
    return false;
}

static inline bool swift_node_expect_type(napi_env env, napi_value value, napi_valuetype expected, const char* msg) {
    napi_valuetype actual;
    if (!swift_node_napi_ok(env, napi_typeof(env, value, &actual), msg)) return false;
    if (actual == expected) return true;
    napi_throw_type_error(env, nullptr, msg);
    return false;
}

// JavaScript Numbers must be finite integers that can be represented exactly
// before crossing an Int/Int64 boundary. Node-API's numeric getters otherwise
// truncate fractions and silently round values outside Number's safe range.
static inline bool swift_node_get_int64(napi_env env, napi_value value, int64_t* result, const char* msg) {
    double number;
    if (!swift_node_napi_ok(env, napi_get_value_double(env, value, &number), msg)) return false;
    if (!std::isfinite(number) || std::trunc(number) != number ||
        number < -9007199254740991.0 || number > 9007199254740991.0) {
        napi_throw_range_error(env, nullptr, "Expected a finite safe integer");
        return false;
    }
    *result = static_cast<int64_t>(number);
    return true;
}

static inline bool swift_node_get_int32(napi_env env, napi_value value, int32_t* result, const char* msg) {
    double number;
    if (!swift_node_napi_ok(env, napi_get_value_double(env, value, &number), msg)) return false;
    if (!std::isfinite(number) || std::trunc(number) != number ||
        number < static_cast<double>(std::numeric_limits<int32_t>::min()) ||
        number > static_cast<double>(std::numeric_limits<int32_t>::max())) {
        napi_throw_range_error(env, nullptr, "Expected a finite 32-bit integer");
        return false;
    }
    *result = static_cast<int32_t>(number);
    return true;
}

// Create a JS string from a NUL-terminated C string using an explicit length.
// napi_create_string_utf8 with NAPI_AUTO_LENGTH fatally aborts inside V8 when the
// string exceeds the maximum string length; passing the length makes oversized
// strings fail gracefully (napi_generic_failure) so callers can throw or reject.
static inline napi_status swift_node_create_string(napi_env env, const char* str, size_t length, napi_value* result) {
    if (str == nullptr) return napi_invalid_arg;
    return napi_create_string_utf8(env, str, length, result);
}

static inline napi_status swift_node_create_string(napi_env env, const char* str, napi_value* result) {
    if (str == nullptr) return napi_invalid_arg;
    return swift_node_create_string(env, str, strlen(str), result);
}

static inline bool swift_node_json_stringify(napi_env env, napi_value value, napi_value* result) {
    napi_value global;
    napi_value json;
    napi_value stringify;
    if (!swift_node_napi_ok(env, napi_get_global(env, &global), "Failed to read global object")) return false;
    if (!swift_node_napi_ok(env, napi_get_named_property(env, global, "JSON", &json), "Failed to read JSON")) return false;
    if (!swift_node_napi_ok(env, napi_get_named_property(env, json, "stringify", &stringify), "Failed to read JSON.stringify")) return false;
    if (!swift_node_napi_ok(env, napi_call_function(env, json, stringify, 1, &value, result), "JSON.stringify failed")) return false;
    napi_valuetype type;
    if (!swift_node_napi_ok(env, napi_typeof(env, *result, &type), "Failed to inspect JSON result")) return false;
    if (type == napi_string) return true;
    napi_throw_type_error(env, nullptr, "Value cannot be represented as JSON");
    return false;
}

static inline bool swift_node_json_parse(napi_env env, const char* json_text, napi_value* result) {
    napi_value global;
    napi_value json;
    napi_value parse;
    napi_value source;
    if (!swift_node_napi_ok(env, napi_get_global(env, &global), "Failed to read global object")) return false;
    if (!swift_node_napi_ok(env, napi_get_named_property(env, global, "JSON", &json), "Failed to read JSON")) return false;
    if (!swift_node_napi_ok(env, napi_get_named_property(env, json, "parse", &parse), "Failed to read JSON.parse")) return false;
    if (!swift_node_napi_ok(env, swift_node_create_string(env, json_text, &source), "Failed to create JSON string")) return false;
    return swift_node_napi_ok(env, napi_call_function(env, json, parse, 1, &source, result), "Native result was not valid JSON");
}

static inline bool swift_node_is_buffer_or_typedarray(napi_env env, napi_value value, const char* message) {
    bool is_dataview = false;
    if (!swift_node_napi_ok(env, napi_is_dataview(env, value, &is_dataview), message)) return false;
    if (is_dataview) {
        napi_throw_type_error(env, nullptr, message);
        return false;
    }

    napi_typedarray_type type;
    size_t length;
    void* data;
    napi_value arraybuffer;
    size_t byte_offset;
    napi_status status = napi_get_typedarray_info(env, value, &type, &length, &data, &arraybuffer, &byte_offset);
    if (status == napi_ok && type == napi_uint8_array) return true;
    if (status == napi_ok) {
        swift_node_throw_type_error(env, message);
        return false;
    }
    if (status != napi_invalid_arg && !swift_node_napi_ok(env, status, message)) return false;

    // Buffer is a Uint8Array in supported Node versions, but retain this
    // fallback for runtimes that do not expose it through typedarray_info.
    bool is_buffer = false;
    if (!swift_node_napi_ok(env, napi_is_buffer(env, value, &is_buffer), message)) return false;
    if (is_buffer) return true;
    napi_throw_type_error(env, nullptr, message);
    return false;
}

static inline bool swift_node_get_binary_data(napi_env env, napi_value value, void** data, size_t* length) {
    bool is_dataview = false;
    if (!swift_node_napi_ok(env, napi_is_dataview(env, value, &is_dataview), "Failed to inspect binary argument")) return false;
    if (is_dataview) {
        napi_throw_type_error(env, nullptr, "Expected a Uint8Array or Buffer");
        return false;
    }

    napi_typedarray_type type;
    napi_value arraybuffer;
    size_t byte_offset;
    napi_status status = napi_get_typedarray_info(env, value, &type, length, data, &arraybuffer, &byte_offset);
    if (status == napi_ok) {
        if (type == napi_uint8_array) return true;
        napi_throw_type_error(env, nullptr, "Expected a Uint8Array or Buffer");
        return false;
    }
    if (status != napi_invalid_arg && !swift_node_napi_ok(env, status, "Failed to read Uint8Array argument")) return false;

    bool is_buffer = false;
    if (!swift_node_napi_ok(env, napi_is_buffer(env, value, &is_buffer), "Failed to inspect binary argument")) return false;
    if (is_buffer) return swift_node_napi_ok(env, napi_get_buffer_info(env, value, data, length), "Failed to read Buffer argument");

    napi_throw_type_error(env, nullptr, "Expected a Uint8Array or Buffer");
    return false;
}

// Borrowed Swift views may be read only while the Node-API callback is active.
// SharedArrayBuffers can be modified concurrently by another worker, so they
// cannot provide the stable, single-threaded view this transport promises.
static inline bool swift_node_require_non_shared_binary_backing(napi_env env, napi_value arraybuffer) {
    // Node-API v8 does not expose an is-SharedArrayBuffer helper, but typed
    // arrays are backed only by ArrayBuffer or SharedArrayBuffer. A shared
    // backing store is deliberately not an ArrayBuffer here.
    bool is_arraybuffer = false;
    if (!swift_node_napi_ok(env, napi_is_arraybuffer(env, arraybuffer, &is_arraybuffer), "Failed to inspect binary backing store")) return false;
    if (is_arraybuffer) return true;

    napi_throw_type_error(env, nullptr, "Expected a Uint8Array or Buffer backed by a non-shared ArrayBuffer");
    return false;
}

static inline bool swift_node_get_borrowed_binary_data(napi_env env, napi_value value, void** data, size_t* length) {
    bool is_dataview = false;
    if (!swift_node_napi_ok(env, napi_is_dataview(env, value, &is_dataview), "Failed to inspect binary argument")) return false;
    if (is_dataview) {
        napi_throw_type_error(env, nullptr, "Expected a Uint8Array or Buffer backed by a non-shared ArrayBuffer");
        return false;
    }

    napi_typedarray_type type;
    napi_value arraybuffer;
    size_t byte_offset;
    napi_status status = napi_get_typedarray_info(env, value, &type, length, data, &arraybuffer, &byte_offset);
    if (status == napi_ok) {
        if (type != napi_uint8_array) {
            napi_throw_type_error(env, nullptr, "Expected a Uint8Array or Buffer backed by a non-shared ArrayBuffer");
            return false;
        }
        return swift_node_require_non_shared_binary_backing(env, arraybuffer);
    }
    if (status != napi_invalid_arg && !swift_node_napi_ok(env, status, "Failed to read Uint8Array argument")) return false;

    // Node 24 Buffers are Uint8Arrays, so the typed-array path above supplies
    // their authoritative backing store. Reject a hypothetical older fallback
    // instead of reading an overridable JavaScript `.buffer` property.
    napi_throw_type_error(env, nullptr, "Expected a Uint8Array or Buffer backed by a non-shared ArrayBuffer");
    return false;
}

static inline std::string swift_node_base64_encode(const uint8_t* bytes, size_t length) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    output.reserve(((length + 2) / 3) * 4);
    for (size_t i = 0; i < length; i += 3) {
        const uint32_t a = bytes[i];
        const uint32_t b = i + 1 < length ? bytes[i + 1] : 0;
        const uint32_t c = i + 2 < length ? bytes[i + 2] : 0;
        const uint32_t group = (a << 16) | (b << 8) | c;
        output.push_back(alphabet[(group >> 18) & 0x3f]);
        output.push_back(alphabet[(group >> 12) & 0x3f]);
        output.push_back(i + 1 < length ? alphabet[(group >> 6) & 0x3f] : '=');
        output.push_back(i + 2 < length ? alphabet[group & 0x3f] : '=');
    }
    return output;
}

static inline int swift_node_base64_value(char value) {
    if (value >= 'A' && value <= 'Z') return value - 'A';
    if (value >= 'a' && value <= 'z') return value - 'a' + 26;
    if (value >= '0' && value <= '9') return value - '0' + 52;
    if (value == '+') return 62;
    if (value == '/') return 63;
    return -1;
}

static inline bool swift_node_base64_decode(const char* text, std::vector<uint8_t>* output) {
    output->clear();
    const size_t length = strlen(text);
    if (length % 4 != 0) return false;
    output->reserve((length / 4) * 3);
    for (size_t i = 0; i < length; i += 4) {
        const int a = swift_node_base64_value(text[i]);
        const int b = swift_node_base64_value(text[i + 1]);
        const int c = text[i + 2] == '=' ? -2 : swift_node_base64_value(text[i + 2]);
        const int d = text[i + 3] == '=' ? -2 : swift_node_base64_value(text[i + 3]);
        if (a < 0 || b < 0 || c == -1 || d == -1 || (c == -2 && d != -2) || ((c == -2 || d == -2) && i + 4 != length)) return false;
        const uint32_t group = (uint32_t(a) << 18) | (uint32_t(b) << 12) | (uint32_t(c < 0 ? 0 : c) << 6) | uint32_t(d < 0 ? 0 : d);
        output->push_back((group >> 16) & 0xff);
        if (c != -2) output->push_back((group >> 8) & 0xff);
        if (d != -2) output->push_back(group & 0xff);
    }
    return true;
}

#endif
