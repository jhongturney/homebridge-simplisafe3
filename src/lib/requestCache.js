import { performance } from 'perf_hooks';

// Share matching reads while they run; keep successful results for a short TTL.
// Expiry uses timestamps rather than a timer for every completed request.
export default class RequestCache {
    pending = new Map();
    values = new Map();

    get(key, load, { ttl = 0, refresh = false } = {}) {
        if (this.pending.has(key)) return this.pending.get(key);
        const cached = this.values.get(key);
        if (!refresh && cached && cached.expires > performance.now()) return Promise.resolve(cached.value);
        this.values.delete(key);

        const request = Promise.resolve().then(load).then(value => {
            // A state-changing command may have cleared/replaced this read.
            if (ttl > 0 && this.pending.get(key) === request) {
                this.values.set(key, { value, expires: performance.now() + ttl });
            }
            return value;
        }).finally(() => {
            if (this.pending.get(key) === request) this.pending.delete(key);
        });
        this.pending.set(key, request);
        return request;
    }

    clear() {
        this.values.clear();
        this.pending.clear();
    }
}
