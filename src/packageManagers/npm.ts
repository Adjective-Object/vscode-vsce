import * as path from 'path';
import { CancellationToken } from '../util';
import { PackageManagerDefinition } from './types';
import { exec, parseStdout } from './util/exec';

async function checkNPM(cancellationToken?: CancellationToken): Promise<void> {
	const { stdout } = await exec('npm -v', {}, cancellationToken);
	const version = stdout.trim();

	if (/^3\.7\.[0123]$/.test(version)) {
		throw new Error(`npm@${version} doesn't work with vsce. Please update npm: npm install -g npm`);
	}
}

function getNpmDependencies(cwd: string): Promise<string[]> {
	return checkNPM()
		.then(() =>
			exec('npm list --production --parseable --depth=99999 --loglevel=error', { cwd, maxBuffer: 5000 * 1024 })
		)
		.then(({ stdout }) => stdout.split(/[\r\n]/).filter(dir => path.isAbsolute(dir)));
}

export function getLatestVersion(name: string, cancellationToken?: CancellationToken): Promise<string> {
	return checkNPM(cancellationToken)
		.then(() => exec(`npm show ${name} version`, {}, cancellationToken))
		.then(parseStdout);
}

export const Npm: PackageManagerDefinition = {
	name: 'npm',
	taskRun: (task: string): [string, ...string[]] => ['npm', 'run', task],
	detect: () => Promise.resolve(true),
	getDependencies: getNpmDependencies
}