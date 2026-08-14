import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { compileCpp, link, type CompilerConfig } from '../src/compiler'
import { nativeTargetId } from '../src/prebuild'

interface RuntimeErrorFixture {
  throwPayload(payload: string): never
  rejectPayload(payload: string): Promise<never>
  throwMissingPayload(): never
  rejectMissingPayload(): Promise<never>
  freedPayloads(): number
}

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime')

const fixtureSource = String.raw`
#include <atomic>
#include <cstdlib>
#include <node_api.h>

static std::atomic<int> freed_payloads{0};

static void track_free(void* pointer) {
    if (pointer) freed_payloads.fetch_add(1);
    std::free(pointer);
}

#define free track_free
#include "swift-node-runtime.h"
#undef free

static char* read_payload(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    if (!swift_node_napi_ok(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "Failed to read callback info")) return nullptr;
    if (!swift_node_expect_argc(env, argc, 1)) return nullptr;
    if (!swift_node_expect_type(env, argv[0], napi_string, "Expected an error payload string")) return nullptr;

    size_t length = 0;
    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length), "Failed to read error payload length")) return nullptr;
    char* payload = static_cast<char*>(std::malloc(length + 1));
    if (!payload) {
        napi_throw_error(env, nullptr, "Failed to allocate error payload");
        return nullptr;
    }
    if (!swift_node_napi_ok(env, napi_get_value_string_utf8(env, argv[0], payload, length + 1, &length), "Failed to read error payload")) {
        std::free(payload);
        return nullptr;
    }
    return payload;
}

static napi_value throw_payload(napi_env env, napi_callback_info info) {
    char* payload = read_payload(env, info);
    if (!payload) return nullptr;
    return throw_swift_error(env, payload);
}

static napi_value reject_payload(napi_env env, napi_callback_info info) {
    char* payload = read_payload(env, info);
    if (!payload) return nullptr;

    napi_deferred deferred;
    napi_value promise;
    if (!swift_node_napi_ok(env, napi_create_promise(env, &deferred, &promise), "Failed to create Promise")) {
        std::free(payload);
        return nullptr;
    }
    swift_node_reject_swift_error(env, deferred, payload);
    return promise;
}

static napi_value throw_missing_payload(napi_env env, napi_callback_info) {
    return throw_swift_error(env, nullptr);
}

static napi_value reject_missing_payload(napi_env env, napi_callback_info) {
    napi_deferred deferred;
    napi_value promise;
    if (!swift_node_napi_ok(env, napi_create_promise(env, &deferred, &promise), "Failed to create Promise")) return nullptr;
    swift_node_reject_swift_error(env, deferred, nullptr);
    return promise;
}

static napi_value freed_payload_count(napi_env env, napi_callback_info) {
    napi_value result;
    if (!swift_node_napi_ok(env, napi_create_int32(env, freed_payloads.load(), &result), "Failed to create payload free count")) return nullptr;
    return result;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        { "throwPayload", nullptr, throw_payload, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "rejectPayload", nullptr, reject_payload, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "throwMissingPayload", nullptr, throw_missing_payload, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "rejectMissingPayload", nullptr, reject_missing_payload, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "freedPayloads", nullptr, freed_payload_count, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return nullptr;
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
`

const captureThrown = (operation: () => never): Error => {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }
  throw new Error('Expected the native operation to throw')
}

const captureRejected = async (operation: () => Promise<never>): Promise<Error> => {
  try {
    await operation()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }
  throw new Error('Expected the native operation to reject')
}

const expectUnstructuredError = (error: Error): void => {
  expect(Object.hasOwn(error, 'code')).toBe(false)
  expect(Object.hasOwn(error, 'details')).toBe(false)
}

const validPayload = JSON.stringify({
  message: 'Structured “failure”\nwith a NUL \u0000 and 🧪',
  code: 'fixture.structured_failure',
  details: {
    attempt: 2,
    nested: { source: 'runtime-test' },
  },
})

const malformedPayloads = [
  ['invalid JSON', '{'],
  ['null payload', 'null'],
  ['array payload', '[]'],
  ['string payload', '"not an error envelope"'],
  ['missing message', '{}'],
  ['non-string message', '{"message": 1}'],
  ['code without details', '{"message": "failure", "code": "fixture.failure"}'],
  ['details without code', '{"message": "failure", "details": {}}'],
  ['non-string code', '{"message": "failure", "code": 1, "details": {}}'],
  ['null details', '{"message": "failure", "code": "fixture.failure", "details": null}'],
  ['scalar details', '{"message": "failure", "code": "fixture.failure", "details": false}'],
  ['array details', '{"message": "failure", "code": "fixture.failure", "details": []}'],
] as const

describe('structured error runtime transport', () => {
  let fixtureDirectory: string | undefined
  let fixture: RuntimeErrorFixture

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'swift-node-runtime-error-fixture-'))
    const binaryName = `runtime_error_fixture.${nativeTargetId()}.node`
    const config: CompilerConfig = {
      moduleName: 'runtime_error_fixture',
      binaryName,
      swiftSources: [],
      projectDir: fixtureDirectory,
      intermediateDir: fixtureDirectory,
      buildDir: fixtureDirectory,
      objDir: fixtureDirectory,
      runtimeDir,
      minMacosVersion: '12.0',
      shipSwiftRuntime: false,
    }

    mkdirSync(fixtureDirectory, { recursive: true })
    writeFileSync(path.join(fixtureDirectory, 'addon.cpp'), fixtureSource)
    const addonObject = compileCpp(config)
    const addonPath = link(config, [addonObject])
    const nodeRequire = createRequire(import.meta.url)
    fixture = nodeRequire(addonPath) as RuntimeErrorFixture
  }, 180_000)

  afterAll(() => {
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('preserves a valid structured envelope for sync and async callers', async () => {
    const syncError = captureThrown(() => fixture.throwPayload(validPayload))
    expect(syncError.message).toBe('Structured “failure”\nwith a NUL \u0000 and 🧪')
    expect(syncError).toMatchObject({
      code: 'fixture.structured_failure',
      details: { attempt: 2, nested: { source: 'runtime-test' } },
    })

    const asyncError = await captureRejected(() => fixture.rejectPayload(validPayload))
    expect(asyncError.message).toBe(syncError.message)
    expect(asyncError).toMatchObject({
      code: 'fixture.structured_failure',
      details: { attempt: 2, nested: { source: 'runtime-test' } },
    })
  })

  it('keeps a valid plain envelope unstructured', async () => {
    const payload = JSON.stringify({ message: 'plain failure' })
    const syncError = captureThrown(() => fixture.throwPayload(payload))
    expect(syncError.message).toBe('plain failure')
    expectUnstructuredError(syncError)

    const asyncError = await captureRejected(() => fixture.rejectPayload(payload))
    expect(asyncError.message).toBe('plain failure')
    expectUnstructuredError(asyncError)
  })

  it.each(malformedPayloads)(
    'rejects a malformed %s envelope without poisoning later calls',
    async (_, payload) => {
      expectUnstructuredError(captureThrown(() => fixture.throwPayload(payload)))
      expectUnstructuredError(await captureRejected(() => fixture.rejectPayload(payload)))

      const recovery = captureThrown(() => fixture.throwPayload(validPayload))
      expect(recovery).toMatchObject({ code: 'fixture.structured_failure' })
    },
  )

  it('returns a plain Error when the native side provides no payload', async () => {
    const syncError = captureThrown(() => fixture.throwMissingPayload())
    expect(syncError.message).toBe('Swift operation failed without an error payload')
    expectUnstructuredError(syncError)

    const asyncError = await captureRejected(() => fixture.rejectMissingPayload())
    expect(asyncError.message).toBe('Swift operation failed without an error payload')
    expectUnstructuredError(asyncError)
  })

  it('frees every owned error payload across repeated sync and async failures', async () => {
    const syncFailures = 500
    const asyncFailures = 100
    const freedBefore = fixture.freedPayloads()

    for (let index = 0; index < syncFailures; index += 1) {
      const error = captureThrown(() => fixture.throwPayload(validPayload))
      expect(error).toMatchObject({ code: 'fixture.structured_failure' })
    }
    for (let index = 0; index < asyncFailures; index += 1) {
      const error = await captureRejected(() => fixture.rejectPayload(validPayload))
      expect(error).toMatchObject({ code: 'fixture.structured_failure' })
    }

    expect(fixture.freedPayloads() - freedBefore).toBe(syncFailures + asyncFailures)
  })
})
