import Foundation
import Security

// MARK: - Service Name

private var customServiceName: String? = nil

// @swift-node:export
func setServiceName(_ serviceName: String) {
    customServiceName = serviceName
}

private func getServiceName() -> String {
    // Use custom service name if set, otherwise fall back to bundle identifier
    if let custom = customServiceName {
        return custom
    }

    guard let bundleId = Bundle.main.bundleIdentifier else {
        fatalError("secure-storage: Cannot determine bundle identifier. Must run within a bundled application or call setServiceName() first.")
    }
    return bundleId
}

// MARK: - Get Value

// @swift-node:export
func get(_ key: String) -> String? {
    let service = getServiceName()

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: key,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    guard status == errSecSuccess,
          let data = result as? Data,
          let value = String(data: data, encoding: .utf8) else {
        return nil
    }

    return value
}

// MARK: - Set Value

// @swift-node:export
func set(_ key: String, _ value: String) -> Bool {
    let service = getServiceName()

    guard let valueData = value.data(using: .utf8) else {
        return false
    }

    let baseQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: key
    ]

    // First, try to update existing item
    let updateQuery: [String: Any] = baseQuery.merging([
        kSecValueData as String: valueData,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
    ]) { (_, new) in new }

    var status = SecItemUpdate(baseQuery as CFDictionary, updateQuery as CFDictionary)

    // If update failed because item doesn't exist, add it
    if status == errSecItemNotFound {
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: valueData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        status = SecItemAdd(addQuery as CFDictionary, nil)
    }

    return status == errSecSuccess
}

// MARK: - Delete Value

// @swift-node:export
func delete(_ key: String) -> Bool {
    let service = getServiceName()

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: key
    ]

    let status = SecItemDelete(query as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
}
