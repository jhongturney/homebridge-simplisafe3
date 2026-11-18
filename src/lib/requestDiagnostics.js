// Static operation names keep account/device IDs, URL query parameters and
// command bodies out of normal failure logs. Unknown routes stay anonymous.
export function apiOperation(params) {
    const candidate = typeof params.method === 'string' ? params.method.toUpperCase() : 'GET';
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(candidate) ? candidate : 'REQUEST';
    let pathname;
    try { pathname = new URL(params.url, 'https://api.simplisafe.com').pathname; }
    catch (err) { return `${method} API request`; }
    const operations = [
        [/^\/api\/authCheck\/?$/, 'authentication check'],
        [/^\/users\/[^/]+\/subscriptions\/?$/, 'subscription list'],
        [/^\/subscriptions\/[^/]+\/?$/, 'subscription details'],
        [/^\/ss3\/subscriptions\/[^/]+\/sensors\/?$/, 'sensors'],
        [/^\/ss3\/subscriptions\/[^/]+\/state\/[^/]+\/?$/, 'alarm command'],
        [/^\/doorlock\/[^/]+\/[^/]+\/state\/?$/, 'lock command'],
        [/^\/doorlock\/[^/]+\/?$/, 'locks']
    ];
    const operation = operations.find(([pattern]) => pattern.test(pathname));
    return `${method} ${operation ? operation[1] : 'API request'}`;
}

export function requestFailureMessage(params, error, cooldownSeconds, elapsedMs) {
    // Deliberately omit error.message, statusText, request/config and response
    // bodies: those may contain credentials or echoed request details.
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) && !/[\r\n]/.test(error.code) ? error.code : null;
    let reason;
    if (Number.isInteger(error.response?.status)) {
        reason = `HTTP ${error.response.status}${error.response.status === 403 ? ' Forbidden' : ''}`;
    } else {
        let category = 'request error';
        if (error.name === 'TimeoutError' || ['ETIMEDOUT', 'ECONNABORTED'].includes(code)) category = 'request timeout';
        else if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) category = 'DNS failure';
        else if (code && /^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$)/.test(code)) category = 'TLS failure';
        else if (['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_NETWORK'].includes(code)) category = 'connection failure';
        const detail = code || (error.name === 'TimeoutError' ? 'TimeoutError' : 'no error code');
        reason = `${category} (${detail}; no HTTP response)`;
    }
    return `SSAPI ${apiOperation(params)} failed after ${Math.max(0, Math.round(elapsedMs))}ms: ${reason}. Plugin API cooldown: ${cooldownSeconds}s before another request can be attempted.`;
}
