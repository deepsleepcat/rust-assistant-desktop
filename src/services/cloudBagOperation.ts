const operations = new Map<string, () => void>()
function operationKey(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
export function ownsCloudBagOperation(root: string, lease: () => void): boolean {
  return operations.get(operationKey(root)) === lease
}
export function acquireCloudBagOperation(root: string): (() => void) | null {
  const key = operationKey(root)
  if (operations.has(key)) return null
  const release = () => { if (operations.get(key) === release) operations.delete(key) }
  operations.set(key, release)
  return release
}
