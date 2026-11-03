export function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `bim-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
