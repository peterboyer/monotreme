import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import json5 from "json5";
import { safe } from "pb.safe";
// import * as json5 from "./json5-2.2.3.min.js";

const [, , ...args] = process.argv;
const ref = args.filter((arg) => !arg.startsWith("--"))[0] ?? "HEAD^1";
const json = process.argv.some((arg) => arg === "--json");
const verbose = process.argv.some((arg) => arg === "--verbose");
const ignore: ReadonlyArray<string> = process.argv.reduce((acc, arg) => {
	if (arg.startsWith("--ignore")) {
		acc.push(arg.substring(9));
	}
	return acc;
}, [] as Array<string>);
const ignoreRootPackageJson = !process.argv.some(
	(arg) => arg === "--no-ignore-root",
);
const ignoreMonotremePackageJson = !process.argv.some(
	(arg) => arg === "--no-ignore-monotreme",
);

debug({
	ref,
	json,
	verbose,
	ignore,
	ignoreRootPackageJson,
	ignoreMonotremePackageJson,
});

affected();
async function affected() {
	type Project = {
		name: string;
		$files: Array<string>;
		dependencies: Array<{
			project: string;
			file: string;
			key: string;
			value: string;
		}>;
	};

	const projects = new Map<string /* ProjectName */, Project>();

	await new Promise((resolve) =>
		resolve(
			execSync(
				[
					"find .",
					"-name package.json",
					'-not -path "*/node_modules/*"',
					ignoreRootPackageJson ? '-not -path "./package.json"' : "",
					ignoreMonotremePackageJson ? '-not -path "./monotreme/*"' : "",
					...ignore.map((pattern) => `-not -path "${pattern}"`),
					"| xargs dirname",
				].join(" "),
			)
				.toString()
				.trim()
				.replaceAll("./", "")
				.split("\n")
				.forEach(($project) => {
					projects.set($project, {
						name: $project,
						$files: [],
						dependencies: [],
					});
				}),
		),
	);

	const $projects = Array.from(projects.keys());

	await new Promise((resolve) =>
		resolve(
			execSync(`git diff --name-only ${ref} -- ${$projects.join(" ")}`)
				.toString()
				.trim()
				.split("\n")
				.forEach(($file) => {
					const $project = $projects.find((project) =>
						$file.startsWith(project),
					);
					if (!$project) {
						return;
					}
					const project = projects.get($project);
					if (!project) {
						throw new Error("Unexpected undefined for project reference.");
					}
					project.$files.push($file.substring($project.length + 1));
				}),
		),
	);

	// Find all `tsconfig.json` files.
	const promises: Array<Promise<void>> = [];
	projects.forEach((project, $project) => {
		promises.push(
			(async () => {
				const $file = join($project, "./tsconfig.json");
				const file = await safe(() =>
					readFile(resolve($file), { encoding: "utf8" }),
				);
				if (file instanceof Error) {
					return;
				}

				const object = json5.parse(file) as unknown as {
					compilerOptions?: {
						paths?: Record<string, ReadonlyArray<string>>;
					};
				};

				const paths = object.compilerOptions?.paths;
				if (!paths) {
					return;
				}

				Object.entries(paths).forEach(([key, $files]) => {
					$files.forEach(($file, index) => {
						const path = join($project, $file);
						projects.forEach((_project, _$project) => {
							if (_$project !== $project && path.startsWith(_$project)) {
								project.dependencies.push({
									project: _$project,
									file: "tsconfig.json",
									key: `.compilerOptions.path["${key}"][${index}]`,
									value: `"${path}"`,
								});
							}
						});
					});
				});
			})(),
		);
	});
	await Promise.all(promises);

	if (json) {
		return void console.info(JSON.stringify(affected));
	}

	if (!projects.size) {
		console.info("No projects found.");
	} else {
		projects.forEach((project, $project) => {
			console.info("");
			console.log($project);
			if (project.$files.length) {
				console.log("  files:");
				project.$files.forEach(($file) => {
					console.log("    - " + $file);
				});
			}
			if (project.dependencies.length) {
				console.log("  dependencies:");
				project.dependencies.forEach(({ project, file, key, value }) => {
					console.log(`    - ${project} ${file} ${key} = ${value}`);
				});
			}
		});
	}
}

function debug(value: unknown) {
	verbose && console.debug(JSON.stringify(value, undefined, 2));
}
