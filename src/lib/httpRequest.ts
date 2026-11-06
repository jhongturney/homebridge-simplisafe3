export const requestTimeoutMs = 20000;

interface RequestOptions {
    timeout: number;
    signal: AbortSignal;
}

// Bound the whole operation, including DNS, connection setup and retry delays.
// Abort the transport too, and release the deadline/listeners on every outcome.
export default async function withRequestTimeout<T>(request: (options: RequestOptions) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    const cancel = () => {
        const reason = callerSignal?.reason;
        controller.abort(reason instanceof Error ? reason : Object.assign(new Error('SimpliSafe request cancelled'), { name: 'AbortError' }));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();

    const timer = setTimeout(() => {
        controller.abort(Object.assign(new Error(`SimpliSafe request timed out after ${requestTimeoutMs}ms`), { name: 'TimeoutError' }));
    }, requestTimeoutMs);
    try {
        const response = Promise.resolve().then(() => {
            if (controller.signal.aborted) throw controller.signal.reason;
            return request({ timeout: requestTimeoutMs, signal: controller.signal });
        });
        return await Promise.race([response, aborted]);
    } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        callerSignal?.removeEventListener('abort', cancel);
    }
}
