const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const [root, directory] = process.argv.slice(2);
const fromPlugin = createRequire(path.join(root, 'package.json'));
const axios = fromPlugin('axios');
for (const transport of ['node:http', 'node:https']) require(transport).request = () => { throw new Error('Unexpected network request'); };
let used;
axios.defaults.adapter = async config => {
    used = JSON.parse(config.data).refresh_token;
    await new Promise(resolve => setTimeout(resolve, 80));
    if (JSON.parse(fs.readFileSync(path.join(directory, 'simplisafe3auth.json'))).refreshToken !== used) throw new Error('stale refresh token');
    return { status: 200, headers: {}, config, data: { access_token: 'fixture-access', refresh_token: used + '-rotated', expires_in: 3600, token_type: 'Bearer' } };
};
const Auth = require(path.join(root, 'lib/authManager')).default;
const auth = new Auth(directory, Object.assign(() => {}, { error: () => {} }));
process.send({ ready: true });
process.once('message', async () => {
    try { await auth.refreshCredentials(); process.send({ used }); }
    catch (error) { process.send({ error: error.message }); process.exitCode = 1; }
    finally { auth.dispose(); process.disconnect(); }
});
