import { SimpliSafe3AuthenticationManager } from '../lib/authManager';
import { createInterface } from 'readline/promises';

class Login {
    static description = 'Login with SimpliSafe';
    authManager?: SimpliSafe3AuthenticationManager;

    static async run(storagePath: string): Promise<void> {
        await new Login().run(storagePath);
    }

    async run(storagePath: string): Promise<void> {
        this.authManager = new SimpliSafe3AuthenticationManager(storagePath);

        const loginURL = this.authManager.getSSAuthURL();

        console.log('\n******* Simplisafe Authentication *******');
        console.log('\nCopy and paste this URL into your browser to log in to SimpliSafe:\n' + loginURL);
        console.log('\nOnce you have approved the login, depending on your browser, you then will either be redirected to a URL that begins with com.SimpliSafe.mobile:// which you should copy and paste back here in its entirety.');
        console.log('\nOr, many browsers will not display the final redirect but will show an error in the Console (e.g. View > Developer Tools > Javascript Console) and you will have to copy and paste the URL from the error message.');
        console.log('\nSafari v15.1+ does not show the URL in the console or the browser and thus is not recommended for this process.');
        console.log('\nAlso please note that this task cannot be performed on a mobile device.\n');

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on('SIGINT', () => process.exit(130)); // readline swallows Ctrl+C otherwise
        let redirectURLStr;
        try {
            redirectURLStr = (await rl.question('Redirect URL: ')).trim();
        } finally {
            rl.close();
        }

        const code = this.authManager.parseCodeFromURL(redirectURLStr);

        try {
            await this.authManager.getToken(code);

            console.log('\nCredentials retrieved successfully.');
            console.log('Please restart Homebridge for changes to take effect.');
        } catch (e) {
            throw new Error(`An error occurred retrieving credentials: ${(e as Error).message}`);
        } finally {
            // A one-off login must not keep running the background token refresh.
            clearInterval(this.authManager.refreshInterval);
        }
    }
}

export default Login;
