/**
 * 게임 실행 파일(host/, C# + WebView2) 안에서 실행될 때의 호스트 연결.
 * 일반 브라우저에서는 null이며, 이때는 WebHID를 쓴다.
 */
interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}

export interface Host {
  call<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  on(event: string, fn: (msg: Record<string, unknown>) => void): () => void;
}

function createHost(bridge: WebViewBridge): Host {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(msg: Record<string, unknown>) => void>>();
  bridge.addEventListener('message', (e) => {
    const m = e.data as Record<string, unknown>;
    if (typeof m.id === 'number' && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(String(m.error ?? '호스트 오류')));
    } else if (typeof m.event === 'string') {
      for (const fn of listeners.get(m.event) ?? []) fn(m);
    }
  });
  return {
    call<T>(cmd: string, args: Record<string, unknown> = {}) {
      const id = ++seq;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        bridge.postMessage({ id, cmd, ...args });
      });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
  };
}

const bridge =
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { chrome?: { webview?: WebViewBridge } }).chrome?.webview;
export const host: Host | null = bridge ? createHost(bridge) : null;
