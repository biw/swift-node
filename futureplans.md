# Future Plans

This document records intentional gaps in the currently supported `swift-node`
surface. It is a planning document, not a release commitment or a compatibility
promise. The package README remains the source of truth for supported APIs.

## Current baseline

The plans below build on the following supported behavior:

- `// @swift-node:codable` types cross the bridge as Foundation JSON, but their
  generated TypeScript declarations are `unknown`.
- Public structs with scalar and `String` stored fields have a lightweight,
  synchronous ABI bridge. More complex models should use `Codable`.
- Streams require both `// @swift-node:export` and `// @swift-node:stream`,
  return `AsyncStream` or `AsyncThrowingStream`, and use JavaScript callback
  subscriptions rather than `AsyncIterable`.
- Stream elements may be scalars, `String`, JSON-safe collections, or annotated
  `Codable` values. Top-level `Data` and `[UInt8]` are not stream elements.
- One-shot callbacks support the documented scalar arguments. Long-lived,
  Promise-returning callbacks support the deliberately narrow
  `@escaping (String, ...) async throws -> String` shape: the bridge retains
  the JavaScript callback, awaits its Promise, and releases it when Swift
  releases the closure.

The last item is intentionally not a future-plan item: it was delivered by
PR #4. The remaining callback work below is an expansion of that foundation.

## Bridge coverage

### Generated declarations for `Codable` models

Generate useful TypeScript types for `// @swift-node:codable` models instead of
falling back to `unknown`. Decide on a durable source of shape information
before implementing this:

- Parse the subset of stored properties that the Swift parser can represent, or
  accept an explicit schema/type-definition input from the package author.
- Model optional properties, arrays, string-keyed dictionaries, nested Codable
  models, enum representations, and concrete generic specializations.
- Keep the generated declaration aligned with the JSON representation actually
  encoded and decoded by Foundation, including the existing base64 treatment of
  nested `Data`.
- Reject or intentionally fall back for shapes whose JSON representation cannot
  be determined safely; do not emit a confident but inaccurate declaration.

### Richer direct struct support

Broaden the direct ABI bridge beyond public structs whose stored fields are
scalars or `String`. First define a stable layout and ownership model for each
additional category, including optionals, nested structs, binary values, and
collections. Raw ABI structs must remain unavailable across async boundaries;
`Codable` remains the appropriate transport when a layout is variable or needs
to cross an asynchronous boundary.

### Structured Swift errors in JavaScript

Replace message-only failures with a JavaScript error type that preserves Swift
error metadata where it is available:

- Foundation/NSError domain, numeric code, localized description, and user
  info.
- The Swift type name for non-NSError failures when it can be represented
  safely.
- A stable public TypeScript declaration and `instanceof`-usable JavaScript
  class, with normal `Error` fields and stack behavior retained.

This requires an error ABI that owns and frees every transmitted field exactly
once. It must work consistently for synchronous calls, Promise rejections,
streams, and Promise callbacks.

### Compiled-addon coverage for Foundation decoding failures

Add executable-addon tests for decoding failures that are presently easier to
exercise only at the parser/unit-test layer. Cover missing keys, nullability
mismatches, keyed-versus-unkeyed container mismatches, invalid enum values, and
custom `Codable` implementations. Assert the observable JavaScript failure
shape for synchronous functions, async functions, and stream inputs where the
transport is available.

## Streams and callbacks

### `AsyncSequence` return support

Accept exported `AsyncSequence` returns in addition to the concrete
`AsyncStream` and `AsyncThrowingStream` types. This needs a generated adapter
with a stable ABI for iteration, cancellation, completion, and thrown errors;
it cannot assume that every sequence has the concrete storage of an
`AsyncStream`. Establish which element and failure constraints are supported
before widening validation.

### Infer stream exports from return types

When an exported function returns a supported stream type, generate a stream
bridge without requiring the separate `// @swift-node:stream` annotation. The
parser, validator, generated Swift, Node-API wrapper, and declarations must all
make the same decision. Once inference is reliable, remove the redundant
annotation rather than maintaining two divergent ways to opt in.

### JavaScript `AsyncIterable` streams

Expose streams as JavaScript `AsyncIterable` values instead of callback
subscriptions. The resulting object should:

- implement `next()`, iterator cleanup, and explicit cancellation;
- complete normally, reject on Swift errors, and release callback/task state on
  every terminal path;
- communicate demand or apply a bounded queue so a fast Swift producer cannot
  grow memory without bound when JavaScript is slow; and
- preserve the current ability to cancel the Swift producer through
  `AsyncStream.Continuation.onTermination`.

### Binary stream elements

Extend the stream ABI and generated TypeScript declarations to carry top-level
`Data` and `[UInt8]` elements as `Uint8Array`/`Buffer` values. The bridge must
copy or otherwise retain bytes until Node has finished constructing the
JavaScript value; borrowed `UnsafeRawBufferPointer` is not a valid stream
element because its lifetime ends with the originating Swift call.

### Broader callback signatures

Build on the shipped Promise callback bridge rather than reintroducing
one-shot-only semantics. Expand deliberately, starting with supported scalar
and `String` arguments and return values, then evaluating structured and binary
values separately. Every long-lived callback shape must define:

- when JavaScript callback references are retained and released;
- what happens when Swift calls after JavaScript environment teardown;
- cancellation, duplicate settlement, and Promise-rejection behavior; and
- isolation tests for concurrent invocations and cleanup on every terminal
  path.

## Codebase maintenance and verification

### Maintain an executable bridge-test matrix

For every supported transport and execution mode, maintain at least one test
that builds and loads a real compiled addon, rather than relying exclusively on
generated-source or parser unit tests. The matrix should cover synchronous and
async exports, actor hops, `Codable`, direct structs, binary transports,
streams (value, error, completion, and cancellation), and long-lived Promise
callbacks. Add a row whenever a bridge feature is introduced, and use the
matrix to identify unit-tested paths that still lack executable coverage.

## Suggested sequencing

1. Establish the executable test matrix and structured error contract so future
   transport work has observable, regression-resistant behavior.
2. Complete stream inference and an `AsyncIterable` protocol before widening
   streams to `AsyncSequence` and binary elements.
3. Broaden declaration and direct-struct support only after their representation
   and ownership rules are explicit.
