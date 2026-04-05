# file-hash-cli

Fast CLI tool to calculate and verify file hashes (MD5, SHA1, SHA256, SHA512).

## Installation

```bash
npm install -g file-hash-cli
```

## Usage

### Calculate hash

```bash
# SHA256 (default)
file-hash hash myfile.zip

# Specific algorithm
file-hash hash myfile.zip --algo md5

# All algorithms at once
file-hash hash myfile.zip --all

# JSON output
file-hash hash myfile.zip --all --json

# Copy to clipboard
file-hash hash myfile.zip --clipboard

# Hash all files in a directory
file-hash hash ./my-folder
```

### Verify a file

```bash
file-hash verify myfile.zip abc123...
file-hash verify myfile.zip abc123... --algo md5
```

Exit code `0` on match, `1` on mismatch.

### Compare two files

```bash
file-hash compare file1.zip file2.zip
file-hash compare file1.zip file2.zip --all
```

## Options

| Option | Description |
|---|---|
| `-a, --algo <alg>` | Algorithm: `md5`, `sha1`, `sha256`, `sha512` (default: `sha256`) |
| `-A, --all` | Show all algorithms |
| `-j, --json` | JSON output |
| `-c, --clipboard` | Copy hash to clipboard |
| `-V, --version` | Show version |
| `-h, --help` | Show help |

## Features

- Streaming hash calculation (handles large files)
- Progress bar for files > 10 MB
- Recursive directory hashing
- Clipboard support (Linux/macOS/WSL)
- JSON output for scripting

## License

MIT
