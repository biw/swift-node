import { ExportedFunction, classifyNativeSwiftType } from '../../parser.js'
import { isNullableType, promiseCallbackInfo, sanitizeId } from '../shared.js'

export function emitSwiftCallbackBridgeCall(
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

export function generatePromiseCallbackSwiftRuntime(
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
