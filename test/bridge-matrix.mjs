// The bridge matrix names the supported runtime behaviours that must be
// exercised through a compiled addon. Keep this list in sync with the public
// bridge surface: a new transport or execution mode needs an executable row
// before it is considered covered.

export const executableBridgeMatrix = Object.freeze([
  {
    id: 'synchronous-exports-and-throws',
    description: 'Synchronous values and thrown Swift errors cross the addon boundary.',
    caseNames: ['supported-type-matrix'],
  },
  {
    id: 'asynchronous-exports-and-rejections',
    description: 'Async Swift exports resolve values and reject JavaScript Promises.',
    caseNames: ['supported-type-matrix'],
  },
  {
    id: 'actor-hops',
    description: 'MainActor and custom global-actor exports retain their execution semantics.',
    caseNames: ['supported-type-matrix'],
  },
  {
    id: 'direct-structs',
    description: 'Direct ABI structs, including Float fields, compile and round-trip.',
    caseNames: ['supported-type-matrix', 'float-struct-round-trip'],
  },
  {
    id: 'codable-transport',
    description: 'Codable values, nested binary data, and cross-file models round-trip.',
    caseNames: ['supported-type-matrix'],
  },
  {
    id: 'binary-transports',
    description: 'Owned Data/[UInt8] and borrowed UnsafeRawBufferPointer inputs preserve bytes.',
    caseNames: ['supported-type-matrix', 'borrowed-buffer-input'],
  },
  {
    id: 'one-shot-callbacks',
    description: 'Callbacks work both during a call and after Swift returns to JavaScript.',
    caseNames: ['supported-type-matrix', 'threadsafe-callback-lifetime'],
  },
  {
    id: 'long-lived-promise-callbacks',
    description: 'Swift retains Promise-returning callbacks across calls and releases them explicitly.',
    caseNames: ['long-lived-promise-callback'],
  },
  {
    id: 'streams',
    description: 'Streams deliver values, errors, completion, cancellation, and cleanup.',
    caseNames: ['supported-type-matrix'],
  },
])

export function assertExecutableBridgeMatrix(productionCases) {
  const caseNames = new Set()
  const duplicatedCases = new Set()

  for (const { name } of productionCases) {
    if (caseNames.has(name)) duplicatedCases.add(name)
    caseNames.add(name)
  }

  const rowIds = new Set()
  const duplicatedRows = new Set()
  const emptyRows = new Set()
  const missingCases = []

  for (const { id, caseNames: rowCaseNames } of executableBridgeMatrix) {
    if (rowIds.has(id)) duplicatedRows.add(id)
    rowIds.add(id)

    if (!Array.isArray(rowCaseNames) || rowCaseNames.length === 0) {
      emptyRows.add(id)
      continue
    }

    for (const caseName of rowCaseNames) {
      if (!caseNames.has(caseName)) missingCases.push(`${id} -> ${caseName}`)
    }
  }

  const failures = []
  if (duplicatedCases.size > 0) failures.push(`duplicate production cases: ${[...duplicatedCases].join(', ')}`)
  if (duplicatedRows.size > 0) failures.push(`duplicate matrix rows: ${[...duplicatedRows].join(', ')}`)
  if (emptyRows.size > 0) failures.push(`matrix rows without executable cases: ${[...emptyRows].join(', ')}`)
  if (missingCases.length > 0) failures.push(`matrix rows without a compiled-addon case: ${missingCases.join(', ')}`)
  if (failures.length > 0) throw new Error(failures.join('\n'))
}
