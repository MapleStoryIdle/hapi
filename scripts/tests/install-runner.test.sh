#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shapi-installer-test.XXXXXX")"
SERVER_PID=""
cleanup() {
    if [[ -n "$SERVER_PID" ]]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

make_binaries() {
    local version="$1"
    mkdir -p "$TMP_ROOT/binaries"
    printf '%s\n' "$version" > "$TMP_ROOT/binaries/runner-version.txt"
    for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64-baseline; do
        mkdir -p "$TMP_ROOT/binaries/$target"
        cat > "$TMP_ROOT/binaries/$target/hapi" <<EOF
#!/bin/sh
if [ -n "\${SHAPI_TEST_COMMAND_LOG:-}" ]; then
    printf '%s\\n' "\$*" >> "\$SHAPI_TEST_COMMAND_LOG"
fi
if [ "\${1:-}" = "workspace" ] && [ "\${2:-}" = "register" ]; then
    previous=""
    for argument in "\$@"; do
        if [ "\$previous" = "--output-token-file" ]; then
            printf '%s\\n' "spw$(printf 'w%.0s' {1..43})" > "\$argument"
            chmod 600 "\$argument"
        fi
        previous="\$argument"
    done
fi
echo "SHAPI $version"
EOF
        chmod +x "$TMP_ROOT/binaries/$target/hapi"
    done
}

prepare() {
    local version="$1"
    make_binaries "$version"
    bun "$REPO_ROOT/scripts/release/prepare-runner-downloads.ts" \
        --version "$version" \
        --download-base-url "http://127.0.0.1:$PORT/downloads/runner/$version" \
        --binaries-dir "$TMP_ROOT/binaries" \
        --output-dir "$TMP_ROOT/public" >/dev/null
    mkdir -p "$TMP_ROOT/public/downloads"
    ln -s ../runner "$TMP_ROOT/public/downloads/runner"
}

PORT=$((18000 + $$ % 10000))
prepare 1.2.3
mkdir -p "$TMP_ROOT/home/.hapi/credentials"
printf 'keep-me\n' > "$TMP_ROOT/home/.hapi/credentials/runner.json"
printf '%s\n' '{"cliApiToken":"keep-me"}' > "$TMP_ROOT/home/.hapi/settings.json"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$TMP_ROOT/public" \
    >"$TMP_ROOT/http.log" 2>&1 &
SERVER_PID=$!
for _ in {1..50}; do
    curl -fsS "http://127.0.0.1:$PORT/downloads/runner/latest.json" >/dev/null 2>&1 && break
    sleep 0.1
done

HOME="$TMP_ROOT/home" SHAPI_INSTALL_DIR="$TMP_ROOT/bin" \
    sh "$REPO_ROOT/scripts/install.sh" --base-url "http://127.0.0.1:$PORT" >"$TMP_ROOT/install.log"
grep -Fq 'Downloading Runner 1.2.3 (' "$TMP_ROOT/install.log"
grep -Fqx 'Download complete. Verifying Runner package...' "$TMP_ROOT/install.log"
grep -Fqx 'Verification complete. Unpacking Runner...' "$TMP_ROOT/install.log"
grep -Fqx 'Runner package ready. Installing and configuring...' "$TMP_ROOT/install.log"
grep -Fqx 'SHAPI setup complete' "$TMP_ROOT/install.log"
grep -Fqx "Hub: http://127.0.0.1:$PORT" "$TMP_ROOT/install.log"
grep -Fqx 'Token: preserved locally by you; SHAPI does not store it' "$TMP_ROOT/install.log"
grep -Fqx 'Runner: running…' "$TMP_ROOT/install.log"
if LC_ALL=C grep -q "$(printf '\033')" "$TMP_ROOT/install.log"; then
    echo "Non-interactive installer output unexpectedly contains color escapes" >&2
    exit 1
fi
[[ "$("$TMP_ROOT/bin/shapi" --version)" == "SHAPI 1.2.3" ]]
[[ "$(cat "$TMP_ROOT/home/.hapi/credentials/runner.json")" == "keep-me" ]]

prepare 1.2.4
HOME="$TMP_ROOT/home" SHAPI_INSTALL_DIR="$TMP_ROOT/bin" \
    sh "$REPO_ROOT/scripts/install.sh" --base-url "http://127.0.0.1:$PORT" >/dev/null
[[ "$("$TMP_ROOT/bin/shapi" --version)" == "SHAPI 1.2.4" ]]
[[ "$("$TMP_ROOT/bin/shapi.previous" --version)" == "SHAPI 1.2.3" ]]

SHAPI_TEST_COMMAND_LOG="$TMP_ROOT/register.log" \
HOME="$TMP_ROOT/home" SHAPI_INSTALL_DIR="$TMP_ROOT/bin" \
    sh "$REPO_ROOT/scripts/install.sh" --base-url "http://127.0.0.1:$PORT" \
        --register --workspace-name "Alice" >"$TMP_ROOT/register-install.log"
grep -Fq "workspace register --name Alice --hub http://127.0.0.1:$PORT --output-token-file" "$TMP_ROOT/register.log"
grep -Fq "runner pair --hub http://127.0.0.1:$PORT --web-token-file" "$TMP_ROOT/register.log"
grep -Fqx "runner start" "$TMP_ROOT/register.log"
grep -Eq '^Token: spw[A-Za-z0-9_-]{43}$' "$TMP_ROOT/register-install.log"
grep -Fqx 'Runner: running…' "$TMP_ROOT/register-install.log"

: > "$TMP_ROOT/register.log"
SHAPI_TEST_COMMAND_LOG="$TMP_ROOT/register.log" \
SHAPI_WEB_TOKEN="spw$(printf 'j%.0s' {1..43})" \
HOME="$TMP_ROOT/home" SHAPI_INSTALL_DIR="$TMP_ROOT/bin" \
    sh "$REPO_ROOT/scripts/install.sh" --base-url "http://127.0.0.1:$PORT" --join >/dev/null
grep -Fq "runner pair --hub http://127.0.0.1:$PORT --web-token-file" "$TMP_ROOT/register.log"
grep -Fqx "runner start" "$TMP_ROOT/register.log"

prepare 1.2.5
mkdir -p "$TMP_ROOT/fresh-home"
HOME="$TMP_ROOT/fresh-home" HAPI_HOME= SHELL=/bin/zsh PATH=/usr/bin:/bin CLI_API_TOKEN= \
SHAPI_DOWNLOAD_BASE_URL="http://127.0.0.1:$PORT" \
    sh "$REPO_ROOT/scripts/install.sh" --no-register >/dev/null
[[ "$("$TMP_ROOT/fresh-home/.local/bin/shapi" --version)" == "SHAPI 1.2.5" ]]
grep -Fqx 'export PATH="$HOME/.local/bin:$PATH"' "$TMP_ROOT/fresh-home/.zshrc"

mkdir -p "$TMP_ROOT/fresh-nontty-home"
HOME="$TMP_ROOT/fresh-nontty-home" HAPI_HOME= SHELL=/bin/zsh PATH=/usr/bin:/bin CLI_API_TOKEN= \
SHAPI_DOWNLOAD_BASE_URL="http://127.0.0.1:$PORT" \
    sh "$REPO_ROOT/scripts/install.sh" >"$TMP_ROOT/fresh-nontty.log"
grep -Fqx 'Runner: not started' "$TMP_ROOT/fresh-nontty.log"
grep -Fqx 'No interactive terminal was available, so workspace setup was skipped.' "$TMP_ROOT/fresh-nontty.log"
grep -Fqx "Create: curl -fsSL http://127.0.0.1:$PORT/install.sh | sh -s -- --register" "$TMP_ROOT/fresh-nontty.log"

# An installed binary without credentials is still an incomplete first setup.
HOME="$TMP_ROOT/fresh-nontty-home" HAPI_HOME= SHELL=/bin/zsh PATH=/usr/bin:/bin CLI_API_TOKEN= \
SHAPI_DOWNLOAD_BASE_URL="http://127.0.0.1:$PORT" \
    sh "$REPO_ROOT/scripts/install.sh" >"$TMP_ROOT/incomplete-retry.log"
grep -Fqx 'Runner: not started' "$TMP_ROOT/incomplete-retry.log"
grep -Fqx 'No interactive terminal was available, so workspace setup was skipped.' "$TMP_ROOT/incomplete-retry.log"

checksum="$TMP_ROOT/public/downloads/runner/1.2.5/checksums.txt"
printf '%064d  %s\n' 0 "$(awk 'NR == 1 { print $2 }' "$checksum")" > "$checksum"
if HOME="$TMP_ROOT/home" SHAPI_INSTALL_DIR="$TMP_ROOT/bin" \
    sh "$REPO_ROOT/scripts/install.sh" --base-url "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "Installer unexpectedly accepted a bad checksum" >&2
    exit 1
fi
[[ "$("$TMP_ROOT/bin/shapi" --version)" == "SHAPI 1.2.4" ]]

if HOME="$TMP_ROOT/home" SHAPI_INSTALL_DIR="$TMP_ROOT/bin" \
    sh "$REPO_ROOT/scripts/install.sh" --base-url "http://localhost.evil" >/dev/null 2>&1; then
    echo "Installer unexpectedly accepted a non-loopback HTTP Hub URL" >&2
    exit 1
fi

prepare 1.2.6
for archive in "$TMP_ROOT/public/downloads/runner/1.2.6"/*.tar.gz; do
    printf 'tampered\n' >> "$archive"
done
(
    cd "$TMP_ROOT/public/downloads/runner/1.2.6"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum ./*.tar.gz | sed 's|  \./|  |' > checksums.txt
    else
        shasum -a 256 ./*.tar.gz | sed 's|  \./|  |' > checksums.txt
    fi
)
if HOME="$TMP_ROOT/home" SHAPI_INSTALL_DIR="$TMP_ROOT/bin" \
    sh "$REPO_ROOT/scripts/install.sh" --base-url "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "Installer unexpectedly trusted a release checksum that differs from the Hub manifest" >&2
    exit 1
fi
[[ "$("$TMP_ROOT/bin/shapi" --version)" == "SHAPI 1.2.4" ]]

echo "Runner installer test passed"
