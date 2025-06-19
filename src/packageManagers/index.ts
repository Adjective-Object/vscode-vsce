import { PackageManager } from './types';
import { Deno } from './deno';
import { Npm } from './npm';
import { NonNonePackageManager, PackageManagerDefinition } from './types';
import { Yarn } from './yarn';

export type { NonNonePackageManager, PackageManagerDefinition };
export { PackageManager }

const packageManagers = {
	[PackageManager.Npm]: Npm,
	[PackageManager.Yarn]: Yarn,
	[PackageManager.Deno]: Deno,
} as const;

// detects the user's package manager based on the current working directory.
export async function detectUserPackageManager(
	cwd: string,
): Promise<NonNonePackageManager> {
	for (const name of [
		PackageManager.Yarn,
		PackageManager.Deno,
		PackageManager.Npm,
	] as const) {
		const packageManager = getPackageManager(name);
		if (await packageManager.detect(cwd)) {
			return name;
		}
	}
	return PackageManager.Npm; // default to npm if no package manager is detected
}

export function getPackageManager(id: NonNonePackageManager): PackageManagerDefinition {
	const pm = packageManagers[id];
	if (!pm) {
		throw new Error(`Unknown package manager: ${id} `);
	}
	return pm;
}
export async function getPackageManagerOrFallback(
	cwd: string,
	id: NonNonePackageManager | undefined
): Promise<PackageManagerDefinition> {
	id = id ?? await detectUserPackageManager(cwd);
	return getPackageManager(id);
}