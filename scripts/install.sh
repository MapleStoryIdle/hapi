#!/bin/sh
set -eu

BASE_URL="${SHAPI_DOWNLOAD_BASE_URL:-https://hapi.ye2moe.fun}"
INSTALL_DIR="${SHAPI_INSTALL_DIR:-$HOME/.local/bin}"
SETUP_MODE="ask"
WORKSPACE_NAME=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    color_bold='\033[1m'
    color_green='\033[32m'
    color_cyan='\033[36m'
    color_yellow='\033[33m'
    color_reset='\033[0m'
else
    color_bold=''
    color_green=''
    color_cyan=''
    color_yellow=''
    color_reset=''
fi

usage() {
    cat <<'EOF'
Usage: install.sh [--base-url <https://hub.example.com>] [--install-dir <path>]
                  [--register | --join | --no-register] [--workspace-name <name>]

Defaults:
  Hub URL: https://hapi.ye2moe.fun
  A fresh interactive install asks whether to create or join a workspace.
  Completed setup automatically pairs and starts the Runner.
  Updates restart the installed Runner. Non-interactive fresh installs require
  --register, or SHAPI_WEB_TOKEN together with --join.

Environment alternatives:
  SHAPI_DOWNLOAD_BASE_URL
  SHAPI_INSTALL_DIR
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --base-url)
            [ "$#" -ge 2 ] || { usage >&2; exit 2; }
            BASE_URL="$2"
            shift 2
            ;;
        --install-dir)
            [ "$#" -ge 2 ] || { usage >&2; exit 2; }
            INSTALL_DIR="$2"
            shift 2
            ;;
        --register)
            SETUP_MODE="new"
            shift
            ;;
        --join)
            SETUP_MODE="join"
            shift
            ;;
        --no-register)
            SETUP_MODE="none"
            shift
            ;;
        --workspace-name)
            [ "$#" -ge 2 ] || { usage >&2; exit 2; }
            WORKSPACE_NAME="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

case "$BASE_URL" in
    https://*) curl_security="https" ;;
    http://localhost|http://localhost:*|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*|http://\[::1\]|http://\[::1\]:*|http://\[::1\]/*) curl_security="loopback" ;;
    *) echo "The download base URL must use HTTPS (except loopback development URLs)" >&2; exit 2 ;;
esac
BASE_URL="${BASE_URL%/}"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
existing_command="$(command -v shapi 2>/dev/null || command -v hapi 2>/dev/null || true)"
fresh_install="yes"
[ -n "$existing_command" ] && fresh_install="no"
[ -f "$INSTALL_DIR/shapi" ] && fresh_install="no"

configure_path() {
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) return ;;
    esac

    if [ "$INSTALL_DIR" != "$HOME/.local/bin" ]; then
        echo "Add $INSTALL_DIR to PATH before using shapi."
        return
    fi

    shell_name="$(basename "${SHELL:-sh}")"
    case "$shell_name" in
        zsh) rc_file="$HOME/.zshrc"; path_line='export PATH="$HOME/.local/bin:$PATH"' ;;
        bash) rc_file="$HOME/.bashrc"; path_line='export PATH="$HOME/.local/bin:$PATH"' ;;
        fish) rc_file="$HOME/.config/fish/config.fish"; path_line='fish_add_path "$HOME/.local/bin"' ;;
        *) rc_file="$HOME/.profile"; path_line='export PATH="$HOME/.local/bin:$PATH"' ;;
    esac

    mkdir -p "$(dirname "$rc_file")"
    if [ -f "$rc_file" ] && ! grep -Fqx "$path_line" "$rc_file"; then
        cp "$rc_file" "$rc_file.shapi-backup-$(date +%Y%m%d%H%M%S)"
    fi
    if [ ! -f "$rc_file" ] || ! grep -Fqx "$path_line" "$rc_file"; then
        printf '\n%s\n%s\n' '# Added by SHAPI installer' "$path_line" >> "$rc_file"
        echo "Added SHAPI to PATH in $rc_file."
    fi
    echo "Open a new terminal or load $rc_file to use the shapi command."
}

choose_setup() {
    if [ "$SETUP_MODE" != "ask" ]; then
        printf '%s\n' "$SETUP_MODE"
        return
    fi
    if [ "$fresh_install" != "yes" ] || [ ! -t 1 ] || [ ! -r /dev/tty ]; then
        printf 'none\n'
        return
    fi

    printf '\nWorkspace setup:\n' >/dev/tty
    printf '  1) Create a new workspace\n' >/dev/tty
    printf '  2) Join an existing workspace\n' >/dev/tty
    printf 'Choose [1]: ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    case "$answer" in
        ""|1) printf 'new\n' ;;
        2) printf 'join\n' ;;
        *) echo "Invalid choice" >&2; exit 2 ;;
    esac
}

read_web_token() {
    if [ -n "${SHAPI_WEB_TOKEN:-}" ]; then
        web_token="$SHAPI_WEB_TOKEN"
    else
        [ -r /dev/tty ] || { echo "SHAPI_WEB_TOKEN is required for a non-interactive join" >&2; exit 2; }
        printf 'Enter the existing spw credential: ' >/dev/tty
        saved_stty="$(stty -g </dev/tty)"
        stty -echo </dev/tty
        IFS= read -r web_token </dev/tty || web_token=""
        stty "$saved_stty" </dev/tty
        printf '\n' >/dev/tty
    fi
    printf '%s\n' "$web_token" | grep -Eq '^spw[A-Za-z0-9_-]{43}$' \
        || { echo "Invalid spw credential" >&2; exit 2; }
    printf '%s\n' "$web_token"
}

download() {
    show_progress="${3:-no}"
    if [ "$curl_security" = "https" ]; then
        if [ "$show_progress" = "yes" ] && [ -t 2 ]; then
            curl -fL --progress-bar --proto '=https' --tlsv1.2 "$1" -o "$2"
        else
            curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"
        fi
    else
        if [ "$show_progress" = "yes" ] && [ -t 2 ]; then
            curl -fL --progress-bar "$1" -o "$2"
        else
            curl -fsSL "$1" -o "$2"
        fi
    fi
}

case "$(uname -s)" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$platform" = "linux" ] && [ "$arch" = "x64" ]; then
    artifact="hapi-linux-x64-baseline.tar.gz"
else
    artifact="hapi-${platform}-${arch}.tar.gz"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/shapi-install.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

echo "Fetching release information from $BASE_URL"
download "$BASE_URL/downloads/runner/latest.json" "$tmp_dir/latest.json"

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9A-Za-z.+-]*\)".*/\1/p' "$tmp_dir/latest.json" | head -n 1)"
[ -n "$version" ] || { echo "Invalid latest.json: version is missing" >&2; exit 1; }
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || { echo "Invalid stable release version: $version" >&2; exit 1; }

release_url="$(sed -n 's/.*"downloadBaseUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp_dir/latest.json" | head -n 1)"
[ -n "$release_url" ] || release_url="$BASE_URL/downloads/runner/$version"
case "$release_url" in
    https://*) ;;
    http://localhost|http://localhost:*|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*|http://\[::1\]|http://\[::1\]:*|http://\[::1\]/*) ;;
    *) echo "Invalid latest.json: downloadBaseUrl must use HTTPS" >&2; exit 1 ;;
esac
release_url="${release_url%/}"
echo "Downloading Runner $version ($artifact)"
download "$release_url/$artifact" "$tmp_dir/$artifact" yes
download "$release_url/checksums.txt" "$tmp_dir/checksums.txt"

expected="$(awk -v file="$artifact" '$2 == file || $2 == "*" file { print $1; exit }' "$tmp_dir/checksums.txt")"
[ -n "$expected" ] || { echo "No checksum published for $artifact" >&2; exit 1; }
manifest_expected="$(awk -v file="\"file\": \"$artifact\"" '
    index($0, file) { found = 1; next }
    found && /"sha256"[[:space:]]*:/ {
        line = $0
        sub(/^.*"sha256"[[:space:]]*:[[:space:]]*"/, "", line)
        sub(/".*$/, "", line)
        print line
        exit
    }
' "$tmp_dir/latest.json")"
printf '%s\n' "$manifest_expected" | grep -Eq '^[0-9a-f]{64}$' \
    || { echo "Invalid latest.json: artifact SHA-256 is missing" >&2; exit 1; }
[ "$expected" = "$manifest_expected" ] \
    || { echo "Release checksum does not match the Hub manifest" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp_dir/$artifact" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp_dir/$artifact" | awk '{ print $1 }')"
else
    echo "sha256sum or shasum is required" >&2
    exit 1
fi

[ "$actual" = "$expected" ] || { echo "SHA-256 verification failed" >&2; exit 1; }

mkdir "$tmp_dir/unpacked"
archive_entries="$(tar -tzf "$tmp_dir/$artifact")"
[ "$archive_entries" = "hapi" ] || { echo "Release archive contains unexpected paths" >&2; exit 1; }
tar -xzf "$tmp_dir/$artifact" -C "$tmp_dir/unpacked"
[ -f "$tmp_dir/unpacked/hapi" ] || { echo "Release archive does not contain hapi" >&2; exit 1; }
chmod 755 "$tmp_dir/unpacked/hapi"

reported_version="$("$tmp_dir/unpacked/hapi" --version)"
case "$reported_version" in
    "SHAPI version: $version"|"SHAPI $version") ;;
    *) echo "Downloaded binary reported an unexpected version: $reported_version" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR"
target="$INSTALL_DIR/shapi"
if [ -f "$target" ]; then
    current_version="$("$target" --version 2>/dev/null || echo unknown)"
    if [ "$current_version" = "$reported_version" ]; then
        echo "SHAPI is already up to date: $reported_version"
        install_required="no"
    else
        install_required="yes"
        cp "$target" "$INSTALL_DIR/shapi.previous"
        echo "Updating $current_version -> $reported_version"
    fi
else
    install_required="yes"
    echo "Installing $reported_version"
fi

if [ "$install_required" = "yes" ]; then
    install -m 755 "$tmp_dir/unpacked/hapi" "$INSTALL_DIR/.shapi.next"
    mv -f "$INSTALL_DIR/.shapi.next" "$target"
fi
ln -sf shapi "$INSTALL_DIR/hapi"

echo "Installed: $target"
"$target" --version
configure_path
echo "Existing ~/.hapi settings and runner credentials were preserved."

setup="$(choose_setup)"
web_token=""
web_token_file="$tmp_dir/web-token"
if [ "$setup" = "new" ]; then
    echo "Creating a workspace on $BASE_URL"
    if [ -n "$WORKSPACE_NAME" ]; then
        "$target" workspace register --name "$WORKSPACE_NAME" --hub "$BASE_URL" --output-token-file "$web_token_file"
    else
        "$target" workspace register --hub "$BASE_URL" --output-token-file "$web_token_file"
    fi
    web_token="$(cat "$web_token_file")"
elif [ "$setup" = "join" ]; then
    web_token="$(read_web_token)"
    umask 077
    printf '%s\n' "$web_token" > "$web_token_file"
fi

if [ "$setup" = "new" ] || [ "$setup" = "join" ]; then
    echo "Pairing this Runner with the workspace"
    "$target" runner pair --hub "$BASE_URL" --web-token-file "$web_token_file"
fi

runner_started="no"
if [ "$setup" != "none" ] || [ "$fresh_install" != "yes" ]; then
    echo "Starting Runner"
    "$target" runner start
    runner_started="yes"
fi

echo
printf '%bSHAPI setup complete%b\n' "$color_bold$color_green" "$color_reset"
printf '%bHub:%b %s\n' "$color_cyan" "$color_reset" "$BASE_URL"
if [ -n "$web_token" ]; then
    printf '%bToken:%b %s\n' "$color_yellow" "$color_reset" "$web_token"
else
    printf '%bToken:%b preserved locally by you; SHAPI does not store it\n' "$color_yellow" "$color_reset"
fi
if [ "$runner_started" = "yes" ]; then
    printf '%bRunner:%b running…\n' "$color_green" "$color_reset"
else
    printf '%bRunner:%b not started\n' "$color_yellow" "$color_reset"
fi

if [ "$fresh_install" = "yes" ] && [ "$setup" = "none" ]; then
    echo "Runner was not started because no workspace was selected."
fi
