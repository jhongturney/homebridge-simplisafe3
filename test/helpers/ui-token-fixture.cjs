// Used only by the UI integration tests in an isolated child process.
const { createRequire } = require('node:module');
const requireFromServer = createRequire(process.argv[1]);
const axios = requireFromServer('axios');

for (const transport of ['node:http', 'node:https']) {
    require(transport).request = () => { throw new Error('Unexpected network request in UI test'); };
}

axios.defaults.adapter = async config => {
    const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    if (config.url !== '/token' || data.grant_type !== 'authorization_code') {
        throw new Error('Unexpected authentication request in UI test');
    }
    if (data.code !== 'fixture-code') {
        throw new axios.AxiosError('Fixture rejected authorization code', 'ERR_BAD_REQUEST', config, undefined, {
            status: 400, statusText: 'Bad Request', headers: {}, config, data: { error: 'invalid_grant' },
        });
    }
    return {
        status: 200, statusText: 'OK', headers: {}, config,
        data: {
            access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token',
            expires_in: 3600, token_type: 'Bearer',
        },
    };
};
