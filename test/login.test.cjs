const test = require('node:test');
const assert = require('node:assert/strict');
const readline = require('node:readline/promises');
const https = require('node:https');
const auth = require('../dist/lib/authManager');
const Login = require('../dist/commands/login').default;

function loginHarness(t, { tokenError, inputError } = {}) {
    const calls = { messages: [], closed: 0 };
    class FakeAuth {
        constructor(storagePath) {
            calls.storagePath = storagePath;
            calls.auth = this;
            this.accessToken = 'private-test-access-token';
            this.refreshToken = 'private-test-refresh-token';
        }
        getSSAuthURL() { return 'https://auth.example/authorize'; }
        parseCodeFromURL(url) { calls.redirect = url; return 'test-code'; }
        async getToken(code) {
            calls.code = code;
            this.refreshInterval = setInterval(() => {}, 60000);
            if (tokenError) throw tokenError;
        }
    }
    t.mock.method(https, 'request', () => { throw new Error('Unexpected network request in login test'); });
    t.mock.method(auth, 'SimpliSafe3AuthenticationManager', function (storagePath) {
        return new FakeAuth(storagePath);
    });
    t.mock.method(readline, 'createInterface', () => ({
        on: () => {},
        question: async () => {
            if (inputError) throw inputError;
            return '  com.SimpliSafe.mobile://callback?code=test-code\n';
        },
        close: () => { calls.closed++; },
    }));
    t.mock.method(console, 'log', message => calls.messages.push(message));
    const clear = global.clearInterval;
    t.mock.method(global, 'clearInterval', interval => {
        calls.clearedInterval = interval;
        clear(interval);
    });
    t.after(() => clear(calls.auth?.refreshInterval));
    return calls;
}

test('CLI login exchanges the trimmed redirect and exits without printing tokens', async t => {
    const calls = loginHarness(t);
    await Login.run('/test/homebridge');
    assert.equal(calls.storagePath, '/test/homebridge');
    assert.equal(calls.redirect, 'com.SimpliSafe.mobile://callback?code=test-code');
    assert.equal(calls.code, 'test-code');
    assert.equal(calls.closed, 1);
    assert.equal(calls.clearedInterval, calls.auth.refreshInterval);
    assert.match(calls.messages.join('\n'), /Credentials retrieved successfully/);
    assert.doesNotMatch(calls.messages.join('\n'), /private-test-/);
});

test('CLI login surfaces token failures and clears any background refresh', async t => {
    const calls = loginHarness(t, { tokenError: new Error('token exchange failed') });
    await assert.rejects(Login.run('/test/homebridge'), /An error occurred retrieving credentials: token exchange failed/);
    assert.equal(calls.closed, 1);
    assert.equal(calls.clearedInterval, calls.auth.refreshInterval);
    assert.doesNotMatch(calls.messages.join('\n'), /Credentials retrieved successfully/);
});

test('CLI login closes the prompt when input fails without exchanging a token', async t => {
    const calls = loginHarness(t, { inputError: new Error('input closed') });
    await assert.rejects(Login.run('/test/homebridge'), /input closed/);
    assert.equal(calls.closed, 1);
    assert.equal(calls.code, undefined);
});
