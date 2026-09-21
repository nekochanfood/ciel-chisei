#!/usr/bin/env node
/**
 * Download bettaworx/ciel packages/api and generate TypeScript types
 * with openapi-typescript.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor");
const extractParent = path.join(tmpdir(), `ciel-openapi-${process.pid}`);
const specOut = path.join(vendorDir, "ciel-api");
const typesOut = path.join(root, "src", "generated", "api.d.ts");
const ref = process.env.CIEL_OPENAPI_REF ?? "main";
const tarballUrl =
	process.env.CIEL_OPENAPI_TARBALL ??
	`https://codeload.github.com/bettaworx/ciel/tar.gz/${ref}`;

mkdirSync(path.join(root, "src", "generated"), { recursive: true });
mkdirSync(vendorDir, { recursive: true });
rmSync(extractParent, { recursive: true, force: true });
mkdirSync(extractParent, { recursive: true });

const tarballPath = path.join(vendorDir, "ciel.tar.gz");

console.log(`Downloading OpenAPI sources from ${tarballUrl}`);
const response = await fetch(tarballUrl);
if (!response.ok || !response.body) {
	throw new Error(
		`Failed to download OpenAPI tarball: ${response.status} ${response.statusText}`,
	);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(tarballPath));

execFileSync("tar", ["-xzf", tarballPath, "-C", extractParent], {
	stdio: "inherit",
});

const entries = (await import("node:fs")).readdirSync(extractParent);
const repoRoot = entries
	.map((name) => path.join(extractParent, name))
	.find((p) => existsSync(path.join(p, "packages", "api", "openapi.yml")));

if (!repoRoot) {
	throw new Error("packages/api/openapi.yml was not found in the Ciel tarball");
}

rmSync(specOut, { recursive: true, force: true });
cpSync(path.join(repoRoot, "packages", "api"), specOut, { recursive: true });
rmSync(extractParent, { recursive: true, force: true });
rmSync(tarballPath, { force: true });

const specPath = path.join(specOut, "openapi.yml");
console.log(`Generating types from ${specPath}`);
execFileSync(
	process.execPath,
	[
		path.join(root, "node_modules", "openapi-typescript", "bin", "cli.js"),
		specPath,
		"-o",
		typesOut,
	],
	{ stdio: "inherit", cwd: root },
);

console.log(`Wrote ${path.relative(root, typesOut)}`);
