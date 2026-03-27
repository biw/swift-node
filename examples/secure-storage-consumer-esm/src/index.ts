import { delete as del, setServiceName, set, get } from '@swift-node-examples/secure-storage'

// Set a custom service name for Keychain
setServiceName('swift-node-demo')

// Store a secret
set('api-token', 'demo-token-value')
console.log('Stored api-token in Keychain')

// Retrieve it
const token = get('api-token')
console.log('Retrieved:', token)

// Clean up
del('api-token')
console.log('Deleted api-token')
