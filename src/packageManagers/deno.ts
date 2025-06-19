import * as path from 'path';
import * as fs from 'fs';
import type { PackageManagerDefinition } from './types';
import { promisify } from 'util';

const exists = (file: string) =>
	fs.promises.stat(file).then(
		_ => true,
		_ => false
	);

const realpath = promisify(fs.realpath);

async function findDenoLock(cwd: string): Promise<string | null> {
	// find deno.lock in the ancestor directories of the cwd
	for (let dir = cwd; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const lockFile = path.join(dir, 'deno.lock');
		if (await exists(lockFile)) {
			return lockFile;
		}
	}
	return null;
}

export async function detectDeno(cwd: string): Promise<boolean> {
	// find deno.lock in the ancestor directories of the cwd
	return (await findDenoLock(cwd)) !== null;
}

type DenoWorkspace = {
	packageJson: {
		// repo version string of form "registry:package@version"
		dependencies?: string[]
	}
}
type DenoWorkspaceWithMeta = {
	packageJson: {
		name: string;
		dependencies?: string[];
		workspaceDependencies?: string[];
	}
}
type DenoNpmEntry = {
	integrity: string;
	dependencies?: string[];
	bin?: boolean
}
type DenoLock = {
	version: string;
	// specifiers of version range -> exact version string
	specifiers: { [specifier: string]: string };
	workspace: DenoWorkspace | {
		// path -> 
		members: Record<string, DenoWorkspace>
	}
} & {
	// keyed on registry ID (e.g. "npm") -> package_name@exact_version
	[key: string]: Record<string, DenoNpmEntry>,
};

function iterDenoWorkspaceMembers(
	denoLock: DenoLock
): [string, DenoWorkspace][] {
	if ('workspace' in denoLock && 'members' in denoLock.workspace) {
		// deno.lock has a workspace with members
		return Object.entries(denoLock.workspace.members);
	} else if ('workspace' in denoLock && 'packageJson' in denoLock.workspace) {
		// deno.lock has a single root workspace member
		return [['.', denoLock.workspace]];
	} else {
		return []
	}
}

function denoStoreId(packageAtVersion: string): string {
	return packageAtVersion.replace('/', '+')
}

function splitPackageAtVersion(packageAtVersion: string): [string, string | undefined] {
	// Check if the package@version starts with an @. If so, it is a scoped package.
	let colonOffset = packageAtVersion.indexOf(':');
	let initialOffset = packageAtVersion.charAt(colonOffset + 1) === '@' ? colonOffset + 2 : colonOffset + 1;
	let cutPoint = packageAtVersion.indexOf('@', initialOffset);

	if (cutPoint === -1) {
		return [packageAtVersion, undefined];
	}

	// Split the package name and version
	let packageName = packageAtVersion.slice(0, cutPoint);
	let version = packageAtVersion.slice(cutPoint + 1);
	if (!version) {
		throw new Error(`Invalid package@version format: '${packageAtVersion}'`);
	}
	return [packageName, version];
}

// Sometimes deno stores multiple packages together in the lockfile, joined by underscores.
//
// This function splits the version string by underscores, returning an array of
// package names and versions. For example, "fdir@6.4.6_picomatch@4.0.2" would return
// ["fdir@6.4.6", "picomatch@4.0.2"].
//
// Note that this cannot be a simple split on '_', because both suffixed-versions and package
// names may contain underscores. For example, "string_utils" is a valid package name, and
// "1.2.3.alpha_4" is valid semver.
function splitMultiPackageAtVersion(packageAtVersion: string): string[] {
	const produced = [];
	const maxIters = packageAtVersion.length
	for (let i = 0; i < maxIters; i++) {
		// pop the first package name from the string
		const [packageName, versionTail] = splitPackageAtVersion(packageAtVersion);
		if (!versionTail?.includes('@')) {
			// versionTail is the actual final version, so we can just push it
			produced.push(`${packageAtVersion}`);
			return produced;
		}

		// otherwise, there is another package in the version string
		const underscoreIndex = versionTail?.indexOf('_');
		if (underscoreIndex === -1) {
			throw new Error(`Invalid multi-package version string: ${packageAtVersion}. Expected an underscore to separate packages in version suffix '${versionTail}'`);
		}
		const [version, rest] = versionTail.split('_', 2);
		packageAtVersion = rest; // update the packageAtVersion to the rest of the string
		produced.push(`${packageName}@${version}`);
	}

	throw new Error("Exceeded maxIters while trying to split multi-package version string: " + packageAtVersion);
}

function denoPath(denoLockPath: string, packageAtVersion: string): Promise<string> {
	const storePath = path.join(denoLockPath, '..', 'node_modules', '.deno',
		// replace / with + to match the deno store format
		`${denoStoreId(packageAtVersion)}`,
		"node_modules",
	)

	// resolve the symlink, if any
	return realpath(storePath);
}

const KNOWN_REGISTRIES = ['npm', 'jsr']

function selectDenoDependencies(
	denoLockPath: string,
	denoLock: DenoLock,
	packagedDependencies: string[]
): Promise<string[]> {
	const workspacesWithLocalDeps = Object.fromEntries(iterDenoWorkspaceMembers(denoLock).map(([localPath, workspace]): [string, DenoWorkspaceWithMeta] => {
		// read the package.json file to get the package name
		const packageJsonPath = path.join(denoLockPath, '..', localPath, 'package.json');
		if (!fs.existsSync(packageJsonPath)) {
			throw new Error(`Could not find package.json in workspace ${localPath} `);
		}
		const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
		const packageJson: { name: string, dependencies?: Record<string, string> } = JSON.parse(packageJsonContent);
		if (!packageJson.name) {
			throw new Error(`Could not find name in package.json in workspace ${localPath} `);
		}

		// add local workspace dependencies to the deno workspace object
		const copyWorkspace: DenoWorkspaceWithMeta = {
			packageJson: {
				...workspace.packageJson,
				name: packageJson.name,
			}
		}
		if (packageJson.dependencies) {
			for (const [depName, depVersion] of Object.entries(packageJson.dependencies)) {
				if (depVersion.startsWith('workspace:')) {
					copyWorkspace.packageJson.workspaceDependencies = copyWorkspace.packageJson.workspaceDependencies || [];
					copyWorkspace.packageJson.workspaceDependencies.push(depName);
				}
			}
		}
		return [localPath, copyWorkspace]
	}));

	const matchedLocalWorkspaces: [string, DenoWorkspaceWithMeta][] = Object.entries(workspacesWithLocalDeps).filter(([_localPath, workspace]) => {
		return packagedDependencies.includes(workspace.packageJson.name);
	});

	// set of npm dependencies we have seen. Used as a visited set in the npm
	// frontier traversal below
	const registryDependencies: Set<string> = new Set();
	for (let registry of KNOWN_REGISTRIES) {
		if (!denoLock[registry]) continue;

		for (let specifier in denoLock[registry]) {
			// split on the last @ to get the package name and version
			const lastAtIndex = specifier.lastIndexOf('@');
			if (lastAtIndex === -1) {
				throw new Error(`Invalid specifier in deno.lock: '${specifier}'`);
			}
			const packageName = specifier.slice(0, lastAtIndex);
			if (packagedDependencies.includes(packageName)) {
				registryDependencies.add(`${registry}:${specifier}`);
			}
		};
	}

	// final list of paths to package
	const collectedDependencyPaths: (string | Promise<string>)[] = []

	// traverse workspaces frontier to find all included dependencies from within the workspace
	const workspacesFrontier: [string, DenoWorkspaceWithMeta][] = [...matchedLocalWorkspaces];
	const MAX_ITERS = 10000; // safety limit to prevent infinite loops
	for (let i = 0; workspacesFrontier.length > 0 && i < MAX_ITERS; i++) {
		const [localPath, workspace] = workspacesFrontier.pop()!;
		collectedDependencyPaths.push(path.join(denoLockPath, '..', localPath));
		// push all dependencies of this workspace to the frontier
		workspace.packageJson.workspaceDependencies?.forEach((dependency) => {
			workspacesFrontier.push([dependency, workspacesWithLocalDeps[dependency]]);
		})
		// add all npm dependencies of this workspace to the matchedNpmDependencies set
		workspace.packageJson.dependencies?.forEach((dependency) => {
			// translate the dependency ranges from 'specifiers' to the exact version string
			const versionString = denoLock.specifiers[dependency];
			const [packageNameWithRegistry, _] = splitPackageAtVersion(dependency);
			registryDependencies.add(`${packageNameWithRegistry}@${versionString}`);
		});
	}

	// done traversing workspaces, now traverse them to get the list of npm dependencies
	const frontier = Array.from(registryDependencies)
	for (let i = 0; frontier.length > 0 && i < MAX_ITERS; i++) {
		let versionString = frontier.pop()!;
		// if there is no version suffix, this should have an unambiguous resolution, so
		// we can just grab the first entry from a matching registry

		// split into registry, id@version
		let [registryId, packageAtVersion] = versionString.split(':', 2);
		if (!registryId || !packageAtVersion) {
			throw new Error(`Invalid version string in deno.lock: ${versionString}`);
		}

		// infer a package version if none was supplied
		let [packageName, version] = splitPackageAtVersion(packageAtVersion);
		if (!version) {
			// no version, match only by package name
			for (let key of Object.keys(denoLock[registryId])) {
				if (key.startsWith(packageName + '@')) {
					// found a match, use the first one
					packageAtVersion = key;
					break;
				}
			}
		}

		// add the dependency to the packaged paths
		for (let splitPackageAtVersion of splitMultiPackageAtVersion(packageAtVersion)) {
			collectedDependencyPaths.push(
				denoPath(denoLockPath, splitPackageAtVersion),
			);
		}

		// find the package in the deno.lock file
		if (!(registryId in denoLock)) {
			throw new Error(`Could not find registry ${registryId} in deno.lock`);
		}
		const packageMeta = denoLock[registryId][packageAtVersion]
		if (!packageMeta) {
			throw new Error(`Could not find '${packageAtVersion}' in deno.lock registry ${registryId} `);
		}

		if (!packageMeta.dependencies) {
			continue;
		}

		// add the dependencies to the frontier
		for (let dependency of packageMeta.dependencies) {
			// handle rebound packages, of form
			// <rebound-name?@<registry>:<original-name>@<version>
			const colonPoint = dependency.indexOf(":")
			const atPoint = dependency.indexOf("@", 1)
			if (atPoint !== -1 && colonPoint !== -1 && atPoint < colonPoint) {
				// if there was an @ before the colon, this is a rebound package
				// and we want to queue the original package name into the frontier
				dependency = dependency.slice(atPoint + 1)
			}

			const dependencyString = (dependency.includes(':'))
				? dependency
				: `${registryId}:${dependency}`;
			// queue the dependency for visiting and add it to the npmDependencies set
			if (!registryDependencies.has(dependencyString)) {
				frontier.push(dependencyString);
				registryDependencies.add(dependencyString);
			}
		}
	}

	return Promise.all(collectedDependencyPaths);
}

// Get the dependencies from the deno.lock file, as an array of paths to the
// root directories of the dependencies.
//
// If packagedDependencies is provided, return only those dependencies.
// Otherwise, return all dependencies in the deno.lock file.
//
// NOTE: this includes everything in your workspace, if you're working in a monorepo,
// but that behavior is consistent with getYarnDependencies.
export async function getDenoDependencies(
	cwd: string,
	packagedDependencies?: string[],
): Promise<string[]> {
	// Find and read the deno.lock file in the parents of the current directory
	const denoLockPath = await findDenoLock(cwd);
	if (!denoLockPath) {
		throw new Error('Could not find deno.lock file in the current directory or its parents');
	}
	const denoLockContent: string = await fs.promises.readFile(denoLockPath!, 'utf8')
	const denoLock: DenoLock = JSON.parse(denoLockContent);

	let absPathResults: string[];
	if (!Array.isArray(packagedDependencies)) {
		// return all dependencies in the deno.lock file.
		absPathResults = await Promise.all(Object.keys(denoLock.npm)
			.map(x => splitMultiPackageAtVersion(x))
			.flat()
			.map(packageAtVersion => denoPath(
				denoLockPath,
				packageAtVersion,
			)));
	} else {
		absPathResults = await selectDenoDependencies(
			denoLockPath,
			denoLock,
			packagedDependencies
		)
	}

	// ensure the root workspace is included in the results
	if (!absPathResults.includes(cwd)) {
		absPathResults.push(cwd);
	}

	return Array.from(new Set(absPathResults));
}

export const Deno: PackageManagerDefinition = {
	name: 'deno',
	taskRun: (task: string): [string, ...string[]] => ['deno', 'task', task],
	detect: detectDeno,
	getDependencies: getDenoDependencies
};