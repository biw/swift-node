# Future Plans

This file tracks work that is intentionally outside the supported surface.

## Bridge coverage

- Broaden generated TypeScript declarations for `// @swift-node:codable` models beyond `unknown` (for example by parsing Codable stored properties or accepting a schema file).
- Broaden struct support beyond public structs with scalar and string fields.
- Preserve Swift error domain, code, type, and user info in a structured JavaScript error type rather than exposing only an error message.
- Add exhaustive compiled-addon coverage for Foundation decoding failures, including missing keys, nullability mismatches, keyed/unkeyed mismatches, invalid enum values, and custom `Codable` implementations.

## Streams and callbacks

- Support `AsyncSequence` returns in addition to `AsyncStream` and `AsyncThrowingStream`.
- Infer stream behavior from an exported stream return type, removing the separate `// @swift-node:stream` annotation.
- Expose streams as JavaScript `AsyncIterable` values with cancellation, completion, error propagation, and backpressure instead of callback subscriptions.
- Support every function-bridge value type as a stream element, including top-level `Data` and `[UInt8]`.
- Broaden callback support beyond one-shot scalar `@escaping (...) -> Void` signatures, with explicit ownership and cleanup for long-lived callbacks.

## Codebase maintenance

- Split `packages/swift-node/src/generator.ts` into smaller modules around type mapping, wrapper generation, and entrypoint generation.
- Add integration tests for remaining bridge paths that unit tests cover but the executable addon tests do not.
