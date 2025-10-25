import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import json5 from "json5";
import { safe } from "pb.safe";

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

if (verbose) {
	console.info({
		ref,
		json,
		verbose,
		ignore,
		ignoreRootPackageJson,
		ignoreMonotremePackageJson,
	});
}

main();
async function main() {
	type Project = {
		name: string;
		files: Array<string>;
		dependents: Array<{
			project: Project;
			trace: ReadonlyArray<string | number>;
		}>;
		dependencies: Array<
			| {
					type: "file";
					/**
					 * Path to affected file.
					 */
					path: string;
			  }
			| {
					type: "dependency";
					/**
					 * Path to affected project.
					 */
					path: ReadonlyArray<string>;
					/**
					 * Trace that determined the dependency.
					 */
					trace: ReadonlyArray<string | number>;
			  }
		>;
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
						files: [],
						dependents: [],
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
				.forEach((file) => {
					const $project = $projects.find(($project) =>
						file.startsWith($project),
					);
					if (!$project) {
						return;
					}
					const project = projects.get($project);
					if (!project) {
						throw new Error("Unexpected undefined for project reference.");
					}
					project.files.push(file.substring($project.length + 1));
				}),
		),
	);

	// Find all `tsconfig.json` files.
	const promises: Array<Promise<void>> = [];
	projects.forEach((project, $project) => {
		promises.push(
			(async () => {
				const file = join($project, "./tsconfig.json");
				const json = await safe(() =>
					readFile(resolve(file), { encoding: "utf8" }),
				);
				if (json instanceof Error) {
					return;
				}

				const object = json5.parse(json) as unknown as {
					compilerOptions?: {
						paths?: Record<string, ReadonlyArray<string>>;
					};
				};

				const paths = object.compilerOptions?.paths;
				if (!paths) {
					return;
				}

				Object.entries(paths).forEach(([key, files]) => {
					files.forEach((file, index) => {
						const path = join($project, file);
						projects.forEach((_project, _$project) => {
							if (_$project !== $project && path.startsWith(_$project)) {
								_project.dependents.push({
									project,
									trace: [
										"tsconfig.json",
										"compilerOptions",
										"path",
										key,
										index,
										file,
										path,
									],
								});
							}
						});
					});
				});
			})(),
		);
	});
	await Promise.all(promises);

	projects.forEach((project) => {
		if (project.files.length) {
			project.files.forEach((file) => {
				project.dependencies.push({
					type: "file",
					path: file,
				});
			});
			walk(project, [project.name]);
		}
	});
	function walk(project: Project, path: ReadonlyArray<string>) {
		if (project.dependents.length) {
			project.dependents.forEach((dependent) => {
				dependent.project.dependencies.push({
					type: "dependency",
					path: Array.from(path).reverse(),
					trace: dependent.trace,
				});
				walk(dependent.project, [...path, dependent.project.name]);
			});
		}
	}

	// >> Development.
	// projects.forEach((project) =>
	//   console.log({
	//     ...project,
	//     dependents: project.dependents.map((dependent) => ({
	//       ...dependent,
	//       project: `~${dependent.project.name}`,
	//     })),
	//   }),
	// );
	// <<

	if (verbose) {
		if (!projects.size) {
			console.info("No projects found.");
		} else {
			projects.forEach((project, $project) => {
				console.info("");
				console.info(
					$project + (project.dependencies.length ? " [affected]" : ""),
				);
				if (project.dependencies.length) {
					Array.from(project.dependencies)
						.sort(
							(a, b) =>
								(b.type === "file" ? 1 : 0) - (a.type === "file" ? 1 : 0),
						)
						.forEach((dependency) => {
							switch (dependency.type) {
								case "file": {
									console.info(`  * ${dependency.path}`);
									break;
								}
								case "dependency": {
									console.info(`  @ ${dependency.path.join(" -> ")}`);
									console.info(`    | ${dependency.trace.join(" -> ")}`);
									break;
								}
							}
						});
				}
			});
		}
		console.info("");
	}

	const affected = Array.from(projects.values())
		.filter((project) => project.dependencies.length)
		.map((project) => project.name);

	if (json) {
		console.info(JSON.stringify(affected));
	} else {
		if (affected.length) {
			console.info(affected.join("\n"));
		}
	}
}
