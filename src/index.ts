import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
import { program } from "commander";
import chalk from "chalk";
import fg from "fast-glob";

const ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;
type Algorithm = (typeof ALGORITHMS)[number];
type OutputFormat = "hex" | "base64";

function isValidAlgo(algo: string): algo is Algorithm {
  return ALGORITHMS.includes(algo as Algorithm);
}

function isValidFormat(fmt: string): fmt is OutputFormat {
  return fmt === "hex" || fmt === "base64";
}

async function hashFile(
  filePath: string,
  algo: Algorithm,
  format: OutputFormat = "hex",
  showProgress = true
): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash(algo);
    const stat = statSync(filePath);
    const stream = createReadStream(filePath);
    let processed = 0;
    const total = stat.size;
    const isLarge = total > 10 * 1024 * 1024; // 10 MB threshold

    stream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      if (showProgress && isLarge && process.stderr.isTTY) {
        processed += chunk.length;
        const pct = ((processed / total) * 100).toFixed(1);
        const filled = Math.floor((processed / total) * 30);
        const bar = "█".repeat(filled) + "░".repeat(30 - filled);
        process.stderr.write(`\r  ${bar} ${pct}%`);
      }
    });

    stream.on("end", () => {
      if (showProgress && isLarge && process.stderr.isTTY) {
        process.stderr.write("\r" + " ".repeat(50) + "\r");
      }
      res(hash.digest(format as BufferEncoding));
    });

    stream.on("error", rej);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function expandPaths(patterns: string[], recursive: boolean): Promise<string[]> {
  const results: string[] = [];
  for (const pattern of patterns) {
    const abs = resolve(pattern);
    try {
      const stat = statSync(abs);
      if (stat.isFile()) {
        results.push(abs);
        continue;
      }
      if (stat.isDirectory()) {
        const globPattern = recursive
          ? `${abs}/**/*`
          : `${abs}/*`;
        const found = await fg(globPattern, {
          onlyFiles: true,
          ignore: ["**/node_modules/**", "**/.git/**"],
          dot: false,
        });
        results.push(...found.sort());
        continue;
      }
    } catch {
      // not a simple path — treat as glob
    }
    const found = await fg(pattern, {
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
      absolute: true,
    });
    if (found.length === 0) {
      console.error(chalk.yellow(`  Warning: no files matched "${pattern}"`));
    }
    results.push(...found.sort());
  }
  return [...new Set(results)];
}

// ─── hash command ────────────────────────────────────────────────────────────

program
  .name("file-hash-cli")
  .description("Compute and verify file checksums from the terminal")
  .version("1.0.0");

program
  .command("hash [paths...]")
  .alias("h")
  .description("Hash one or more files / globs / directories")
  .option("-a, --algo <algorithm>", `Algorithm: ${ALGORITHMS.join(", ")}`, "sha256")
  .option("-A, --all-algos", "Show all algorithms")
  .option("-f, --format <fmt>", "Output format: hex | base64", "hex")
  .option("-r, --recursive", "Recurse into directories")
  .option("-j, --json", "Output as JSON")
  .action(async (paths: string[], opts) => {
    if (paths.length === 0) {
      console.error(chalk.red("Error: provide at least one file, glob, or directory."));
      process.exit(1);
    }

    const algo = opts.algo as string;
    const fmt = opts.format as string;

    if (!opts.allAlgos && !isValidAlgo(algo)) {
      console.error(chalk.red(`Invalid algorithm "${algo}". Choose from: ${ALGORITHMS.join(", ")}`));
      process.exit(1);
    }
    if (!isValidFormat(fmt)) {
      console.error(chalk.red(`Invalid format "${fmt}". Choose: hex | base64`));
      process.exit(1);
    }

    const algos: Algorithm[] = opts.allAlgos ? [...ALGORITHMS] : [algo as Algorithm];
    const files = await expandPaths(paths, !!opts.recursive);

    if (files.length === 0) {
      console.error(chalk.red("No files found."));
      process.exit(1);
    }

    if (opts.json) {
      const output: object[] = [];
      for (const f of files) {
        const entry: Record<string, string> = {
          file: f,
          size: formatSize(statSync(f).size),
        };
        for (const a of algos) {
          entry[a] = await hashFile(f, a, fmt as OutputFormat, false);
        }
        output.push(entry);
      }
      console.log(JSON.stringify(output.length === 1 ? output[0] : output, null, 2));
    } else {
      for (const f of files) {
        const stat = statSync(f);
        console.log(chalk.bold(`\n  ${basename(f)}`) + chalk.dim(` (${formatSize(stat.size)})`));
        for (const a of algos) {
          const digest = await hashFile(f, a, fmt as OutputFormat);
          console.log(`  ${chalk.cyan(a.toUpperCase().padEnd(7))} ${digest}`);
        }
      }
      console.log();
    }
  });

// ─── verify command ───────────────────────────────────────────────────────────

program
  .command("verify <file> <expected>")
  .alias("v")
  .description("Verify a file against an expected hash")
  .option("-a, --algo <algorithm>", `Algorithm: ${ALGORITHMS.join(", ")}`, "sha256")
  .option("-f, --format <fmt>", "Output format: hex | base64", "hex")
  .option("-j, --json", "Output as JSON")
  .action(async (filePath: string, expected: string, opts) => {
    const abs = resolve(filePath);
    const algo = opts.algo as string;
    const fmt = opts.format as string;

    if (!isValidAlgo(algo)) {
      console.error(chalk.red(`Invalid algorithm "${algo}". Choose from: ${ALGORITHMS.join(", ")}`));
      process.exit(1);
    }
    if (!isValidFormat(fmt)) {
      console.error(chalk.red(`Invalid format "${fmt}". Choose: hex | base64`));
      process.exit(1);
    }

    try {
      const actual = await hashFile(abs, algo as Algorithm, fmt as OutputFormat);
      const match = actual.toLowerCase() === expected.toLowerCase();

      if (opts.json) {
        console.log(JSON.stringify({ file: abs, algorithm: algo, format: fmt, expected, actual, match }, null, 2));
      } else {
        console.log();
        console.log(match ? chalk.green.bold("  ✓ MATCH") : chalk.red.bold("  ✗ MISMATCH"));
        console.log(`  ${chalk.dim("File:")}     ${basename(abs)}`);
        console.log(`  ${chalk.dim("Algo:")}     ${algo.toUpperCase()} (${fmt})`);
        console.log(`  ${chalk.dim("Expected:")} ${expected}`);
        console.log(`  ${chalk.dim("Actual:")}   ${actual}`);
        console.log();
      }

      process.exit(match ? 0 : 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${msg}`));
      process.exit(1);
    }
  });

// ─── compare command ──────────────────────────────────────────────────────────

program
  .command("compare <file1> <file2>")
  .alias("c")
  .description("Compare hashes of two files")
  .option("-a, --algo <algorithm>", `Algorithm: ${ALGORITHMS.join(", ")}`, "sha256")
  .option("-A, --all-algos", "Compare with all algorithms")
  .option("-f, --format <fmt>", "Output format: hex | base64", "hex")
  .option("-j, --json", "Output as JSON")
  .action(async (file1: string, file2: string, opts) => {
    const abs1 = resolve(file1);
    const abs2 = resolve(file2);
    const algo = opts.algo as string;
    const fmt = opts.format as string;

    if (!opts.allAlgos && !isValidAlgo(algo)) {
      console.error(chalk.red(`Invalid algorithm "${algo}". Choose from: ${ALGORITHMS.join(", ")}`));
      process.exit(1);
    }
    if (!isValidFormat(fmt)) {
      console.error(chalk.red(`Invalid format "${fmt}". Choose: hex | base64`));
      process.exit(1);
    }

    const algos: Algorithm[] = opts.allAlgos ? [...ALGORITHMS] : [algo as Algorithm];

    try {
      const results: Array<{ algorithm: string; h1: string; h2: string; match: boolean }> = [];

      for (const a of algos) {
        const [h1, h2] = await Promise.all([
          hashFile(abs1, a, fmt as OutputFormat, false),
          hashFile(abs2, a, fmt as OutputFormat, false),
        ]);
        results.push({ algorithm: a, h1, h2, match: h1 === h2 });
      }

      const allMatch = results.every((r) => r.match);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              file1: abs1,
              file2: abs2,
              format: fmt,
              match: allMatch,
              algorithms: results,
            },
            null,
            2
          )
        );
      } else {
        console.log();
        console.log(chalk.bold("  Comparing:"));
        console.log(`  ${chalk.cyan("A:")} ${basename(abs1)} ${chalk.dim(`(${formatSize(statSync(abs1).size)})`)}`);
        console.log(`  ${chalk.cyan("B:")} ${basename(abs2)} ${chalk.dim(`(${formatSize(statSync(abs2).size)})`)}`);
        console.log();
        for (const r of results) {
          const icon = r.match ? chalk.green("✓") : chalk.red("✗");
          console.log(`  ${icon} ${chalk.cyan(r.algorithm.toUpperCase().padEnd(7))} ${r.match ? "identical" : "different"}`);
          if (!r.match) {
            console.log(`    ${chalk.dim("A:")} ${r.h1}`);
            console.log(`    ${chalk.dim("B:")} ${r.h2}`);
          }
        }
        console.log();
      }

      process.exit(allMatch ? 0 : 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${msg}`));
      process.exit(1);
    }
  });

program.parse();
