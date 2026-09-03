/**
 * Update the Homebrew formula for SHAPI.
 *
 * This script:
 * 1. Reads checksums from release-artifacts/checksums.txt
 * 2. Generates an updated shapi.rb formula
 * 3. Optionally clones the tap repo, commits, and pushes
 *
 * Usage:
 *   # Generate formula locally (for review)
 *   bun run scripts/update-homebrew-formula.ts --version 0.1.0 --repository owner/shapi
 *
 *   # Generate and push to tap repository
 *   bun run scripts/update-homebrew-formula.ts --version 0.1.0 --repository owner/shapi --push
 *
 * Environment:
 *   SHAPI_RELEASE_REPOSITORY - GitHub owner/repository containing release assets
 *   HOMEBREW_TAP_REPO       - Git URL of the tap repository; an unset value skips --push
 *   HOMEBREW_TAP_NAME       - Optional brew tap name, for example owner/tap
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

interface PlatformSha {
    darwinArm64: string;
    darwinX64: string;
    linuxArm64: string;
    linuxX64: string;
}

function parseChecksums(checksumsPath: string): PlatformSha {
    const content = readFileSync(checksumsPath, 'utf-8');
    const lines = content.trim().split('\n');

    const shas: Partial<PlatformSha> = {};

    for (const line of lines) {
        const [sha, filename] = line.split('  ');
        if (!sha || !filename) continue;

        if (filename.includes('darwin-arm64')) shas.darwinArm64 = sha;
        else if (filename.includes('darwin-x64')) shas.darwinX64 = sha;
        else if (filename.includes('linux-arm64')) shas.linuxArm64 = sha;
        else if (filename.includes('linux-x64')) shas.linuxX64 = sha;
    }

    const missing: string[] = [];
    if (!shas.darwinArm64) missing.push('darwin-arm64');
    if (!shas.darwinX64) missing.push('darwin-x64');
    if (!shas.linuxArm64) missing.push('linux-arm64');
    if (!shas.linuxX64) missing.push('linux-x64');

    if (missing.length > 0) {
        throw new Error(`Missing SHA256 checksums for: ${missing.join(', ')}`);
    }

    return shas as PlatformSha;
}

function generateFormula(version: string, repository: string, shas: PlatformSha): string {
    return `# typed: false
# frozen_string_literal: true

class Shapi < Formula
  desc "App for agentic coding - access coding agent anywhere"
  homepage "https://github.com/${repository}"
  version "${version}"
  license "AGPL-3.0-only"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/${repository}/releases/download/v#{version}/hapi-darwin-arm64.tar.gz"
      sha256 "${shas.darwinArm64}"
    else
      url "https://github.com/${repository}/releases/download/v#{version}/hapi-darwin-x64.tar.gz"
      sha256 "${shas.darwinX64}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/${repository}/releases/download/v#{version}/hapi-linux-arm64.tar.gz"
      sha256 "${shas.linuxArm64}"
    else
      url "https://github.com/${repository}/releases/download/v#{version}/hapi-linux-x64-baseline.tar.gz"
      sha256 "${shas.linuxX64}"
    end
  end

  def install
    # Release archives keep the internal binary name for runner compatibility.
    bin.install "hapi" => "shapi"
    bin.install_symlink "shapi" => "hapi"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/shapi --version")
  end
end
`;
}

function readOption(args: string[], option: string): string | undefined {
    const index = args.indexOf(option);
    const value = index >= 0 ? args[index + 1]?.trim() : undefined;
    return value || undefined;
}

function validateVersion(version: string): string {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`Invalid release version: ${version}. Expected a semantic version without the v prefix.`);
    }
    return version;
}

function validateRepository(repository: string): string {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new Error(`Invalid GitHub repository: ${repository}. Expected owner/repository.`);
    }
    return repository;
}

function deriveTapName(tapRepo: string | undefined): string | undefined {
    if (!tapRepo) return undefined;

    const match = tapRepo.match(/github\.com[/:]([^/]+)\/homebrew-([^/.]+)(?:\.git)?$/i);
    if (!match) return undefined;
    return `${match[1]}/${match[2]}`;
}

function printUsage(): void {
    console.log(`Usage:
  bun run scripts/update-homebrew-formula.ts --version <version> --repository <owner/repository> [--push]

Options:
  --version <version>  Version to update to (required)
  --repository <repo>  GitHub release repository; defaults to SHAPI_RELEASE_REPOSITORY or GITHUB_REPOSITORY
  --push               Clone tap repo, commit and push changes
  --help               Show this help message

Examples:
  # Generate formula locally
  bun run scripts/update-homebrew-formula.ts --version 0.1.0 --repository owner/shapi

  # Push to tap repository
  HOMEBREW_TAP_REPO=https://github.com/owner/homebrew-tap.git \\
    bun run scripts/update-homebrew-formula.ts --version 0.1.0 --repository owner/shapi --push
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(0);
    }

    const versionValue = readOption(args, '--version');
    if (!versionValue) {
        console.error('Error: --version is required\n');
        printUsage();
        process.exit(1);
    }
    const version = validateVersion(versionValue);

    const repositoryValue = readOption(args, '--repository')
        || process.env.SHAPI_RELEASE_REPOSITORY?.trim()
        || process.env.GITHUB_REPOSITORY?.trim();
    if (!repositoryValue) {
        console.error('Error: --repository is required outside GitHub Actions\n');
        printUsage();
        process.exit(1);
    }

    const repository = validateRepository(repositoryValue);
    const shouldPush = args.includes('--push');
    const tapRepo = process.env.HOMEBREW_TAP_REPO?.trim() || undefined;
    const tapName = process.env.HOMEBREW_TAP_NAME?.trim() || deriveTapName(tapRepo);
    const checksumsPath = join(projectRoot, 'release-artifacts', 'checksums.txt');

    if (shouldPush && !tapRepo) {
        console.log('Homebrew publish skipped: HOMEBREW_TAP_REPO is not configured.');
        return;
    }

    if (!existsSync(checksumsPath)) {
        console.error(`Error: Checksums file not found: ${checksumsPath}`);
        console.error('This file is generated by the CI workflow during release.');
        process.exit(1);
    }

    console.log(`Generating SHAPI Homebrew formula for v${version} from ${repository}...\n`);

    // Parse checksums
    const shas = parseChecksums(checksumsPath);
    console.log('SHA256 checksums:');
    console.log(`  darwin-arm64: ${shas.darwinArm64}`);
    console.log(`  darwin-x64:   ${shas.darwinX64}`);
    console.log(`  linux-arm64:  ${shas.linuxArm64}`);
    console.log(`  linux-x64:    ${shas.linuxX64}\n`);

    // Generate formula content
    const formulaContent = generateFormula(version, repository, shas);

    if (!shouldPush) {
        // Just output the formula locally
        const localFormulaDir = join(projectRoot, 'release-artifacts', 'Formula');
        mkdirSync(localFormulaDir, { recursive: true });

        const localFormulaPath = join(localFormulaDir, 'shapi.rb');
        writeFileSync(localFormulaPath, formulaContent);

        console.log(`Formula generated: ${localFormulaPath}\n`);
        console.log('To push to the tap repository, run with --push flag.');
        console.log(`Or manually copy to your homebrew-tap repo's Formula/ directory.`);
        return;
    }

    // Clone and push to tap repository
    const githubToken = process.env.GITHUB_TOKEN;
    let cloneUrl = tapRepo;

    // Use token-authenticated URL in CI
    if (githubToken && tapRepo.includes('github.com')) {
        cloneUrl = tapRepo.replace('https://github.com/', `https://x-access-token:${githubToken}@github.com/`);
    }

    console.log(`Cloning ${tapRepo}...`);

    const tempDir = join(tmpdir(), `homebrew-tap-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
        execFileSync('git', ['clone', '--depth', '1', cloneUrl, tempDir], { stdio: 'pipe' });

        // Ensure Formula directory exists
        const formulaDir = join(tempDir, 'Formula');
        mkdirSync(formulaDir, { recursive: true });

        // Write formula
        const formulaPath = join(formulaDir, 'shapi.rb');
        writeFileSync(formulaPath, formulaContent);
        console.log(`Updated: ${formulaPath}`);

        // Configure git user for CI
        if (githubToken) {
            execFileSync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: tempDir, stdio: 'pipe' });
        }

        // Commit and push
        execFileSync('git', ['add', 'Formula/shapi.rb'], { cwd: tempDir, stdio: 'pipe' });

        const stagedDiff = spawnSync('git', ['diff', '--cached', '--quiet'], {
            cwd: tempDir,
            stdio: 'pipe'
        });
        if (stagedDiff.error) {
            throw stagedDiff.error;
        }
        if (stagedDiff.status === 0) {
            console.log('\nNo changes to commit (formula already up to date)');
        } else if (stagedDiff.status === 1) {
            execFileSync('git', ['commit', '-m', `Update shapi to v${version}`], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['push', 'origin', 'main'], { cwd: tempDir, stdio: 'pipe' });
            console.log(`\nSuccessfully pushed SHAPI v${version} to homebrew-tap`);
        } else {
            throw new Error(`Unable to inspect staged Homebrew formula (git exited ${stagedDiff.status ?? 'without a status'}).`);
        }

        if (tapName) {
            console.log('\nUsers can now install via:');
            console.log(`  brew install ${tapName}/shapi`);
        }
    } finally {
        // Cleanup
        rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error('Error:', error.message || error);
    process.exit(1);
});
