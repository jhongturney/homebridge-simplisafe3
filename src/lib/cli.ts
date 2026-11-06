import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import isDocker from 'is-docker';
import Login from '../commands/login';

const help = `Usage: homebridge-simplisafe3 <command> [options]

Commands:
  login                 Login with SimpliSafe

Options:
  -d, --homebridgeDir    The path to your Homebridge directory (login only)
  -h, --help            Show help
  -v, --version         Show the installed plugin version`;

export async function run(args: string[] = process.argv.slice(2)): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            homebridgeDir: { type: 'string', short: 'd' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
        },
    });

    const command = positionals[0];
    if (values.version) {
        const manifest: { name: string; version: string } = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        console.log(`${manifest.name}/${manifest.version}`);
        return;
    }
    if (command !== undefined && !['login', 'help'].includes(command)) {
        throw new Error(`Unknown command: ${command}. Run homebridge-simplisafe3 --help.`);
    }
    if (positionals.length > 1 && !(command === 'help' && positionals.length === 2 && positionals[1] === 'login')) {
        throw new Error('Unexpected arguments. Run homebridge-simplisafe3 --help.');
    }
    if (values.help || !command || command === 'help') {
        console.log(help);
        return;
    }

    const storagePath = values.homebridgeDir ?? (isDocker() ? '/homebridge/' : path.join(os.homedir(), '.homebridge'));
    await Login.run(storagePath);
}
