import { createHash, type BinaryToTextEncoding } from "node:crypto";
import { createReadStream, statSync, readdirSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
import { execSync } from "node:child_process";
import { program } from "commander";
import chalk from "chalk";

const ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;
type Algorithm = (typeof ALGORITHMS)[number];

function isValidAlgo(algo: string): algo is Algorithm {
  return ALGORITHMS.includes(algo as Algorithm);
}

async function hashFile(
  filePath: string,
  algo: Algorithm,
  showProgress = true
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo);
    const stat = statSync(filePath);
    const stream = createReadStream(filePath);
    let processed = 0;
    const total = stat.size;
    const isLarge = total > 10 * 1024 * 1024; // 10MB

    stream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      if (showProgress && isLarge && process.stderr.isTTY) {
        processed += chunk.length;
        const pct = ((processed / total) * 100).toFixed(1);
        const bar = "█".repeat(Math.floor((processed / total) * 30));
        const empty = "░".repeat(30 - bar.length);
        process.stderr.write(`\r  ${bar}${empty} ${pct}%`);
      }
    });

    stream.on("end", () => {
      if (showProgress && isLarge && process.stderr.isTTY) {
        process.stderr.write("\r" + " ".repeat(50) + "\r");
      }
      resolve(hash.digest("hex"));
    });

    stream.on("error", reject);
  });
}

function collectFiles(dirPath: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function copyToClipboard(text: string): boolean {
  try {
    const cmds = ["xclip -selection clipboard", "xsel --clipboard", "pbcopy", "clip.exe"];
    for (const cmd of cmds) {
      try {
        execSync(`echo -n "${text}" | ${cmd}`, { stdio: "pipe" });
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

program
  .name("file-hash")
  .description("Calculate file hashes (MD5, SHA1, SHA256, SHA512)")
  .version("1.0.0");

program
  .command("hash")
  .alias("h")
  .description("Calculate hash of a file or directory")
  .argument("<path>", "File or directory path")
  .option("-a, --algo <algorithm>", "Hash algorithm", "sha256")
  .option("-A, --all", "Show all algorithms")
  .option("-j, --json", "Output as JSON")
  .option("-c, --clipboard", "Copy hash to clipboard")
  .action(async (targetPath: string, opts) => {
    const absPath = resolve(targetPath);

    try {
      const stat = statSync(absPath);

      if (stat.isFile()) {
        const algos: Algorithm[] = opts.all
          ? [...ALGORITHMS]
          : [opts.algo as Algorithm];

        if (!opts.all && !isValidAlgo(opts.algo)) {
          console.error(
            chalk.red(`Invalid algorithm: ${opts.algo}. Use: ${ALGORITHMS.join(", ")}`)
          );
          process.exit(1);
        }

        if (opts.json) {
          const result: Record<string, string> = { file: absPath, size: formatSize(stat.size) };
          for (const algo of algos) {
            result[algo] = await hashFile(absPath, algo);
          }
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.bold(`\n  ${basename(absPath)}`) + chalk.dim(` (${formatSize(stat.size)})`));
          console.log();
          for (const algo of algos) {
            const digest = await hashFile(absPath, algo);
            console.log(`  ${chalk.cyan(algo.toUpperCase().padEnd(7))} ${digest}`);
            if (opts.clipboard && algos.length === 1) {
              copyToClipboard(digest)
                ? console.log(chalk.green("\n  Copied to clipboard!"))
                : console.log(chalk.yellow("\n  Could not copy to clipboard"));
            }
          }
          console.log();
        }
      } else if (stat.isDirectory()) {
        const files = collectFiles(absPath);
        const algo: Algorithm = opts.all ? "sha256" : (opts.algo as Algorithm);

        if (!opts.all && !isValidAlgo(opts.algo)) {
          console.error(
            chalk.red(`Invalid algorithm: ${opts.algo}. Use: ${ALGORITHMS.join(", ")}`)
          );
          process.exit(1);
        }

        if (opts.json) {
          const results: Array<{ file: string; hash: string; size: string }> = [];
          for (const f of files) {
            results.push({
              file: relative(absPath, f),
              hash: await hashFile(f, algo, false),
              size: formatSize(statSync(f).size),
            });
          }
          console.log(JSON.stringify({ directory: absPath, algorithm: algo, files: results }, null, 2));
        } else {
          console.log(chalk.bold(`\n  Directory: ${absPath}`));
          console.log(chalk.dim(`  Algorithm: ${algo.toUpperCase()} | ${files.length} files\n`));
          for (const f of files) {
            const digest = await hashFile(f, algo, false);
            const rel = relative(absPath, f);
            console.log(`  ${chalk.gray(digest.slice(0, 12))}.. ${chalk.white(rel)}`);
          }
          console.log();
        }
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command("verify")
  .alias("v")
  .description("Verify a file against an expected hash")
  .argument("<file>", "File path")
  .argument("<hash>", "Expected hash value")
  .option("-a, --algo <algorithm>", "Hash algorithm", "sha256")
  .action(async (filePath: string, expectedHash: string, opts) => {
    const absPath = resolve(filePath);
    const algo = opts.algo as Algorithm;

    if (!isValidAlgo(algo)) {
      console.error(chalk.red(`Invalid algorithm: ${algo}. Use: ${ALGORITHMS.join(", ")}`));
      process.exit(1);
    }

    try {
      const actual = await hashFile(absPath, algo);
      const match = actual.toLowerCase() === expectedHash.toLowerCase();

      if (opts.parent?.json) {
        console.log(JSON.stringify({ file: absPath, algorithm: algo, expected: expectedHash, actual, match }, null, 2));
      } else {
        console.log();
        if (match) {
          console.log(chalk.green.bold("  ✓ MATCH"));
        } else {
          console.log(chalk.red.bold("  ✗ MISMATCH"));
        }
        console.log(`  ${chalk.dim("File:")}     ${basename(absPath)}`);
        console.log(`  ${chalk.dim("Algo:")}     ${algo.toUpperCase()}`);
        console.log(`  ${chalk.dim("Expected:")} ${expectedHash}`);
        console.log(`  ${chalk.dim("Actual:")}   ${actual}`);
        console.log();
      }

      process.exit(match ? 0 : 1);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command("compare")
  .alias("c")
  .description("Compare hashes of two files")
  .argument("<file1>", "First file")
  .argument("<file2>", "Second file")
  .option("-a, --algo <algorithm>", "Hash algorithm", "sha256")
  .option("-A, --all", "Compare with all algorithms")
  .action(async (file1: string, file2: string, opts) => {
    const abs1 = resolve(file1);
    const abs2 = resolve(file2);
    const algos: Algorithm[] = opts.all
      ? [...ALGORITHMS]
      : [opts.algo as Algorithm];

    if (!opts.all && !isValidAlgo(opts.algo)) {
      console.error(chalk.red(`Invalid algorithm: ${opts.algo}. Use: ${ALGORITHMS.join(", ")}`));
      process.exit(1);
    }

    try {
      console.log();
      console.log(chalk.bold("  Comparing:"));
      console.log(`  ${chalk.cyan("A:")} ${basename(abs1)} ${chalk.dim(`(${formatSize(statSync(abs1).size)})`)}`);
      console.log(`  ${chalk.cyan("B:")} ${basename(abs2)} ${chalk.dim(`(${formatSize(statSync(abs2).size)})`)}`);
      console.log();

      let allMatch = true;
      for (const algo of algos) {
        const [h1, h2] = await Promise.all([
          hashFile(abs1, algo, false),
          hashFile(abs2, algo, false),
        ]);
        const match = h1 === h2;
        if (!match) allMatch = false;
        const icon = match ? chalk.green("✓") : chalk.red("✗");
        console.log(`  ${icon} ${chalk.cyan(algo.toUpperCase().padEnd(7))} ${match ? "identical" : "different"}`);
        if (!match) {
          console.log(`    ${chalk.dim("A:")} ${h1}`);
          console.log(`    ${chalk.dim("B:")} ${h2}`);
        }
      }
      console.log();
      process.exit(allMatch ? 0 : 1);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program.parse();
