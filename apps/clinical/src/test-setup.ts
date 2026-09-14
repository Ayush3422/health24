// IndexedDB for Node, so the offline cache runs against a real implementation
// of the API rather than a mock of it.
import 'fake-indexeddb/auto';

/** The tab's sessionStorage: Node has none, and the offline cache keeps its record id there. */
if (typeof globalThis.sessionStorage === 'undefined') {
  const values = new Map<string, string>();

  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  };

  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage as Storage,
    configurable: true,
  });
}
