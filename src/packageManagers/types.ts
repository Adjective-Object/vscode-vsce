
/**
 * The supported list of package managers.
 * @public
 */
export enum PackageManager {
	Npm,
	Yarn,
	None,
}
export type NonNonePackageManager = Exclude<PackageManager, PackageManager.None>;

export type PackageManagerDefinition = {
	name: string;
	taskRun: (task: string) => string[];
	detect: (cwd: string) => Promise<boolean>;
	getDependencies: (
		cwd: string,
		packagedDependencies?: string[]
	) => Promise<string[]>;
};
