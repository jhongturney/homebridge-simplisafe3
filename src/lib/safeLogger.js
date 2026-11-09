const hidden = '[REDACTED]';
const wrappers = new WeakMap();
const secretKey = /^(?:authorization|proxyauthorization|cookie|setcookie|accesstoken|refreshtoken|usertoken|token|password|clientsecret|codeverifier|codechallenge|authcode|authorizationcode|srtpkey|srtpsalt|videosrtp|audiosrtp|srtpoutparams|icepwd|credential)$/i;
const normalize = key => key.replace(/[^a-z0-9]/gi, '');
const credentialField = '(?:access[_-]?token|refresh[_-]?token|user[_-]?token|token|password|client[_-]?secret|code[_-]?verifier|code[_-]?challenge|auth[_-]?code|authorization[_-]?code|srtp[_-]?(?:key|salt|out[_-]?params)|(?:video|audio)[_-]?srtp|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|credential|code)';
const quotedField = new RegExp(`(["'])(${credentialField})\\1(\\s*:\\s*)(["'])(?:\\\\.|(?!\\4)[^\\r\\n])*?\\4`, 'gi');
const assignedField = new RegExp(`(\\b${credentialField}\\s*[:=]\\s*)[^\\s&"'<>]+`, 'gi');

export function redactText(text) {
    return text
        .replace(quotedField, (match, quote, key, separator, valueQuote) => `${quote}${key}${quote}${separator}${valueQuote}${hidden}${valueQuote}`)
        .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, `$1 ${hidden}`)
        .replace(assignedField, `$1${hidden}`)
        .replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)(\s*:\s*)[^\r\n]+/gi, `$1$2${hidden}`)
        .replace(/(-srtp_out_params\s+)[^\s"']+/gi, `$1${hidden}`)
        .replace(/(a=ice-pwd:)[^\r\n]+/gi, `$1${hidden}`)
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${hidden}@`);
}

// Return detached logging data. Never call an error's toJSON/custom inspector,
// traverse its request/config, or hand a live credential-bearing object to a sink.
export function safeLogValue(value, seen = new WeakSet(), depth = 0) {
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') return JSON.stringify(safeLogValue(parsed, seen, depth + 1));
        } catch (err) { /* ordinary diagnostic text */ }
        return redactText(value);
    }
    if (value === null || typeof value !== 'object') return typeof value === 'function' ? '[Function]' : value;
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary data]';
    if (depth >= 8) return '[Depth limit]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
        if (value instanceof Error) {
            const result = { name: redactText(value.name), message: redactText(value.message) };
            for (const key of ['code', 'status', 'statusCode', 'cause']) {
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (descriptor && 'value' in descriptor) result[key] = safeLogValue(descriptor.value, seen, depth + 1);
            }
            const response = Object.getOwnPropertyDescriptor(value, 'response')?.value;
            const status = response && Object.getOwnPropertyDescriptor(response, 'status')?.value;
            if (typeof status === 'number') result.status = status;
            return result;
        }
        if (value instanceof URL) return redactText(value.toString());
        const result = Array.isArray(value) ? [] : Object.create(null);
        for (const key of Object.keys(value).slice(0, 100)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (secretKey.test(normalize(key)) || (normalize(key) === 'code' && typeof descriptor?.value === 'string')) result[key] = hidden;
            else result[key] = descriptor && 'value' in descriptor ? safeLogValue(descriptor.value, seen, depth + 1) : '[Getter]';
        }
        return result;
    } finally {
        seen.delete(value);
    }
}

export default function safeLogger(logger = console.log) {
    if (wrappers.has(logger)) return wrappers.get(logger);
    const safe = (...args) => logger.apply(logger, args.map(value => safeLogValue(value)));
    for (const level of ['debug', 'info', 'warn', 'error', 'success', 'log']) {
        const sink = typeof logger[level] === 'function' ? logger[level] : logger;
        safe[level] = (...args) => sink.apply(logger, args.map(value => safeLogValue(value)));
    }
    wrappers.set(logger, safe);
    wrappers.set(safe, safe);
    return safe;
}

// FFmpeg can split credentials across stderr chunks. Redact complete lines only;
// discard oversized diagnostics instead of emitting a potentially secret prefix.
export function lineLogger(logger) {
    let pending = '';
    let dropping = false;
    return chunk => {
        for (const part of chunk.toString().split(/(\n)/)) {
            if (part === '\n') {
                if (!dropping && pending) logger(redactText(pending));
                pending = '';
                dropping = false;
            } else if (!dropping) {
                pending += part;
                if (pending.length > 8192) { pending = ''; dropping = true; }
            }
        }
    };
}
