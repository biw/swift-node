// Loaded with Node's --import option by the local test wrapper and CI.
// Process warnings otherwise only reach stderr and can leave a green test run.
process.on('warning', (warning) => {
  const code = warning.code ? ` [${warning.code}]` : ''
  console.error(`Node warning promoted to test failure${code}: ${warning.name}: ${warning.message}`)
  throw warning
})
