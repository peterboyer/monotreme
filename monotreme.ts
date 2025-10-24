import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as json5 from "json5";
// import * as json5 from "./json5-2.2.3.min.js";

const [, , command, ...args] = process.argv;
const verbose = process.argv.some((arg) => arg === "--verbose");
const json = process.argv.some((arg) => arg === "--json");
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
	command,
	verbose,
	json,
	ignore,
	ignoreRootPackageJson,
	ignoreMonotremePackageJson,
});

if (!command) {
	throw new Error("Missing command.");
} else if (command === "affected") {
	affected();
} else {
	throw new Error("Unknown command.");
}

async function affected() {
	const ref = args.filter((arg) => !arg.startsWith("--"))[0] ?? "HEAD^1";
	debug({ ref });

	const packagedirs: ReadonlyArray<string> = execSync(
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
		.split("\n");
	debug({ packagedirs });

	const affectedfiles: ReadonlyArray<string> = execSync(
		`git diff --name-only ${ref} -- ${packagedirs.join(" ")}`,
	)
		.toString()
		.trim()
		.split("\n");
	debug({ affectedfiles });

	// Find all `tsconfig.json` files.
	const tsconfigfiles = await Promise.all(
		packagedirs.map((packagedir) => {
			const filepath = join(packagedir, "./tsconfig.json");
			return readFile(resolve(filepath), { encoding: "utf8" })
				.then((content) => {
					return {
						packagedir,
						filepath,
						content: json5.parse(content),
					};
				})
				.catch(() => undefined);
		}),
	);
	console.log({ tsconfigfiles });

	// project => dependents
	const depgraph: Record<
		string,
		Array<{ project: string; file: string; key: string; value: string }>
	> = {};
	tsconfigfiles.forEach((tsconfigfile) => {
		if (!tsconfigfile) {
			return;
		}

		const aliases = (
			tsconfigfile.content as {
				compilerOptions?: {
					paths?: Record<string, ReadonlyArray<string>>;
				};
			}
		).compilerOptions?.paths;
		if (!aliases) {
			return;
		}

		Object.entries(aliases).forEach(([key, aliaspaths]) => {
			aliaspaths.map((path, index) => {
				packagedirs.forEach((packagedir) => {
					const aliaspath = join(tsconfigfile.packagedir, path);
					console.log("compare", packagedir, "vs", aliaspath);
					if (aliaspath.startsWith(packagedir)) {
						const deps = depgraph[packagedir] ?? [];
						deps.push({
							project: tsconfigfile.packagedir,
							file: tsconfigfile.filepath,
							key: `.compilerOptions.path["${key}"][index]`,
							value: path,
						});
						depgraph[packagedir] = deps;
					}
				});
			});
		});
	});
	console.log("depgraph", depgraph);

	const why: Record<
		string,
		Array<{ type: "file" | "path" | "dep"; source: string }>
	> = {};

	const scanfiles = new Set<string>([...affectedfiles]);
	const affectedpackagedirs: ReadonlyArray<string> = Array.from(
		packagedirs
			.reduce((acc, dir) => {
				for (const file of scanfiles) {
					if (file.startsWith(dir)) {
						acc.add(dir);

						scanfiles.delete(file);
						const arr = why[dir] ?? [];
						arr.push({ type: "git.diff", source: file });
						why[dir] = arr;
					}
				}

				return acc;
			}, new Set<string>())
			.values(),
	);

	Object.keys(why).forEach((project) => {
		const deps = depgraph[project];
		if (!deps) {
			return;
		}
		for (const dep of deps) {
			const arr = why[dep.project] ?? [];
			arr.push({ type: "js.tsconfig.path", ...dep });
			why[dep.project] = arr;
		}
	});

	debug({ affectedpackagedirs });

	debug({ why });

	if (json) {
		console.info(JSON.stringify(affectedpackagedirs));
	} else {
		console.info(affectedpackagedirs.join("\n"));
	}
}

function debug(value: unknown) {
	verbose && console.debug(JSON.stringify(value, undefined, 2));
}
