/** Binding metadata types omit RPC disposers. Own them without requiring
 * ordinary in-process objects to implement the resource protocol. */
export function rpcResource<T extends object | null>(value: T) {
  return {
    value,
    [Symbol.dispose]() {
      (value as (T & Partial<Disposable>) | null)?.[Symbol.dispose]?.();
    },
  };
}
