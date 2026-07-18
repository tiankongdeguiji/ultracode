#!/bin/sh
# ultracode OSS installer.
#
# DISTRIBUTED ARTIFACT — this file is uploaded to object storage and piped to
# `sh` by end users; it is not CI tooling. Typical use:
#
#   curl -fsSL https://hongsheng-jhs.oss-cn-hangzhou.aliyuncs.com/ultracode/install.sh | sh
#
# It resolves a release (latest.json, or a pinned UC_VERSION), verifies the
# tarball checksum, lands it at $UC_INSTALL_DIR/app/<version>/, flips the
# app/current symlink, and writes a node-selecting shim to
# $UC_BIN_DIR/ultracode. Old app/<version> dirs are retained on purpose:
# detached runners and codex MCP registrations pin absolute versioned paths.
# $UC_INSTALL_DIR/workflows and .ultracode run stores are engine-owned and are
# never touched. All logic lives in functions and the very last line is
# `main "$@"`, so a truncated download executes nothing.
#
# Environment (all optional):
#   UC_BASE_URL      release origin (file:// also works)
#   UC_VERSION       pin a release version (a leading v is ignored)
#   UC_INSTALL_DIR   install root   (default: $HOME/.ultracode)
#   UC_BIN_DIR       shim directory (default: $HOME/.local/bin)
#   UC_NODE          explicit node binary; must be Node >= 20 or the install fails
#   UC_NODE_VERSION  Node version auto-provisioned when no usable node exists

set -eu

die() {
  printf 'ultracode installer: error: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

warn() {
  printf 'ultracode installer: warning: %s\n' "$1" >&2
}

assert_safe_path() {
  # These values are interpolated into the receipt JSON and the generated
  # shim (inside double quotes) — reject the characters that would break
  # either rather than trying to escape them.
  case "$2" in
    *'"'*|*'\'*|*'$'*|*'`'*) die "$1 must not contain double quotes, backslashes, dollar signs, or backticks" ;;
  esac
}

apply_defaults() {
  : "${UC_BASE_URL:=https://hongsheng-jhs.oss-cn-hangzhou.aliyuncs.com/ultracode}"
  : "${UC_VERSION:=}"
  : "${UC_INSTALL_DIR:=$HOME/.ultracode}"
  : "${UC_BIN_DIR:=$HOME/.local/bin}"
  : "${UC_NODE:=}"
  # The release pipeline regex-parses this pin; keep the exact idiom on its own line.
  : "${UC_NODE_VERSION:=22.14.0}"
  UC_BASE_URL=${UC_BASE_URL%/}
  # The receipt interpolates UC_BASE_URL into JSON naively — reject the two
  # characters that would break that.
  case "$UC_BASE_URL" in
    *'"'*|*'\'*) die 'UC_BASE_URL must not contain double quotes or backslashes' ;;
  esac
  assert_safe_path UC_INSTALL_DIR "$UC_INSTALL_DIR"
  assert_safe_path UC_BIN_DIR "$UC_BIN_DIR"
  [ -z "$UC_NODE" ] || assert_safe_path UC_NODE "$UC_NODE"
  # Relative override paths would bake cwd-dependent symlink targets and shim
  # paths — resolve them against the invoking cwd once, here.
  case "$UC_INSTALL_DIR" in
    /*) ;;
    *) UC_INSTALL_DIR="$PWD/$UC_INSTALL_DIR" ;;
  esac
  case "$UC_BIN_DIR" in
    /*) ;;
    *) UC_BIN_DIR="$PWD/$UC_BIN_DIR" ;;
  esac
}

require_curl() {
  command -v curl >/dev/null 2>&1 || die 'curl is required but was not found on PATH'
}

uc_fetch() {
  # -f matters: OSS 403/404 XML error pages must become hard failures, not
  # poisoned tarballs or manifests on disk. Timeouts bound a stalled
  # connection ($3 overrides the total cap for large tarballs).
  curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time "${3:-120}" -o "$1" "$2" \
    || die "download failed: $2"
}

stage_pid_live() {
  # $1 = a .stage dir, $2 = the pid separator ('.' or '-'). True when the
  # owning installer process is still alive — reaping a live concurrent
  # install's stage would make its second mv fail under set -eu. All installs
  # are HOME-scoped (same user), so kill -0 is authoritative here.
  uc_sp=${1##*.stage"$2"}
  case "$uc_sp" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$uc_sp" 2>/dev/null
}

link_swap() {
  # Point symlink $2 at $1. GNU mv -T renames over the old link atomically —
  # a concurrent shim launch never observes a missing link; BSD mv (macOS)
  # has no -T, so it falls back to ln -sfn's tiny unlink+create window.
  uc_ls_tmp="$(dirname "$2")/.lnk.$$"
  rm -f "$uc_ls_tmp"
  ln -s "$1" "$uc_ls_tmp"
  if mv -T "$uc_ls_tmp" "$2" 2>/dev/null; then
    :
  else
    rm -f "$uc_ls_tmp"
    ln -sfn "$1" "$2"
  fi
}

detect_platform() {
  uc_os_raw=$(uname -s)
  case "$uc_os_raw" in
    Linux) UC_OS=linux ;;
    Darwin) UC_OS=darwin ;;
    MINGW*|MSYS*|CYGWIN*) die 'Windows is not supported (use WSL)' ;;
    *) die "unsupported operating system: $uc_os_raw" ;;
  esac
  uc_arch_raw=$(uname -m)
  case "$uc_arch_raw" in
    x86_64|amd64) UC_ARCH=x64 ;;
    aarch64|arm64) UC_ARCH=arm64 ;;
    *) die "unsupported architecture: $uc_arch_raw" ;;
  esac
}

manifest_field() {
  # latest.json is emitted one key per line, so a line-oriented sed is sound.
  sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

assert_version_shape() {
  # The version names URLs, install paths, and a receipt JSON field — reject
  # traversal, whitespace, and JSON-breaking characters, then require a
  # digit-led dotted shape (SemVer prereleases still pass).
  case "$1" in
    */*|*..*|*[[:space:]]*|*'"'*|*'\'*) die "unexpected version string: '$1'" ;;
  esac
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) die "unexpected version string: '$1'" ;;
  esac
}

resolve_version() {
  if [ -n "$UC_VERSION" ]; then
    UC_RESOLVED_VERSION=${UC_VERSION#v}
    assert_version_shape "$UC_RESOLVED_VERSION"
    uc_fetch "$UC_TMP/app.tar.gz.sha256" \
      "$UC_BASE_URL/releases/v$UC_RESOLVED_VERSION/ultracode-$UC_RESOLVED_VERSION.tar.gz.sha256"
    UC_EXPECTED_SHA=$(awk 'NR==1{print $1}' "$UC_TMP/app.tar.gz.sha256")
  else
    uc_fetch "$UC_TMP/latest.json" "$UC_BASE_URL/latest.json"
    UC_RESOLVED_VERSION=$(manifest_field "$UC_TMP/latest.json" version)
    assert_version_shape "$UC_RESOLVED_VERSION"
    UC_EXPECTED_SHA=$(manifest_field "$UC_TMP/latest.json" sha256)
  fi
  case "$UC_EXPECTED_SHA" in
    ''|*[!0-9a-f]*) die "could not read a well-formed sha256 for version $UC_RESOLVED_VERSION" ;;
  esac
}

node_ok() {
  uc_node_v=$("$1" --version 2>/dev/null) || return 1
  uc_node_v=${uc_node_v#v}
  uc_node_major=${uc_node_v%%.*}
  case "$uc_node_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$uc_node_major" -ge 20 ]
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk 'NR==1{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk 'NR==1{print $1}'
  else
    die 'no sha256 tool found; install sha256sum (coreutils) or shasum (perl)'
  fi
}

provision_node() {
  uc_node_name="node-v$UC_NODE_VERSION-$UC_OS-$UC_ARCH"
  uc_node_dir="$UC_INSTALL_DIR/runtime/$uc_node_name"
  # node_ok (not a bare -x test) so an executable-but-broken runtime — arch
  # mismatch, truncated binary — is replaced instead of being kept forever.
  if ! node_ok "$uc_node_dir/bin/node"; then
    info "no usable Node >= 20 found; provisioning Node v$UC_NODE_VERSION"
    uc_fetch "$UC_TMP/$uc_node_name.tar.gz" "$UC_BASE_URL/runtime/$uc_node_name.tar.gz" 600
    uc_fetch "$UC_TMP/$uc_node_name.tar.gz.sha256" "$UC_BASE_URL/runtime/$uc_node_name.tar.gz.sha256"
    uc_node_expected=$(awk 'NR==1{print $1}' "$UC_TMP/$uc_node_name.tar.gz.sha256")
    uc_node_actual=$(sha256_of "$UC_TMP/$uc_node_name.tar.gz")
    if [ -z "$uc_node_expected" ] || [ "$uc_node_actual" != "$uc_node_expected" ]; then
      die 'sha256 mismatch for the Node runtime — corrupted download; re-run the installer'
    fi
    mkdir -p "$UC_TMP/node-extract"
    tar -xzf "$UC_TMP/$uc_node_name.tar.gz" -C "$UC_TMP/node-extract"
    [ -x "$UC_TMP/node-extract/$uc_node_name/bin/node" ] || die 'unexpected Node runtime tarball layout'
    mkdir -p "$UC_INSTALL_DIR/runtime"
    for uc_rt_stale in "$UC_INSTALL_DIR/runtime"/.stage.*; do
      [ -e "$uc_rt_stale" ] || continue
      stage_pid_live "$uc_rt_stale" . && continue
      rm -rf "$uc_rt_stale"
    done
    uc_node_stage="$UC_INSTALL_DIR/runtime/.stage.$$"
    mv "$UC_TMP/node-extract/$uc_node_name" "$uc_node_stage"
    if node_ok "$uc_node_dir/bin/node"; then
      # A concurrent install landed a working runtime while we downloaded —
      # keep it.
      rm -rf "$uc_node_stage"
    else
      # Same gate as the provisioning entry check: a runtime that is missing,
      # non-executable, or not runnable is broken — replace, don't keep.
      rm -rf "$uc_node_dir"
      mv "$uc_node_stage" "$uc_node_dir"
    fi
  fi
  link_swap "$uc_node_dir" "$UC_INSTALL_DIR/runtime/current"
  UC_NODE_BIN="$uc_node_dir/bin/node"
  node_ok "$UC_NODE_BIN" || die "provisioned Node runtime at $UC_NODE_BIN is not runnable on this machine"
}

choose_node() {
  if [ -n "$UC_NODE" ]; then
    node_ok "$UC_NODE" || die "UC_NODE=$UC_NODE failed the Node >= 20 check"
    # The chosen path is baked into the shim and receipt, where a relative
    # path would resolve against every future caller's cwd — absolutize it.
    case "$UC_NODE" in
      /*) UC_NODE_BIN=$UC_NODE ;;
      */*) UC_NODE_BIN="$(cd "$(dirname "$UC_NODE")" && pwd -P)/$(basename "$UC_NODE")" ;;
      *) UC_NODE_BIN=$(command -v "$UC_NODE") || die "UC_NODE=$UC_NODE not found on PATH" ;;
    esac
    return 0
  fi
  uc_path_node=$(command -v node 2>/dev/null || true)
  if [ -n "$uc_path_node" ] && node_ok "$uc_path_node"; then
    UC_NODE_BIN=$uc_path_node
    return 0
  fi
  if [ -x "$UC_INSTALL_DIR/runtime/current/bin/node" ] && node_ok "$UC_INSTALL_DIR/runtime/current/bin/node"; then
    UC_NODE_BIN="$UC_INSTALL_DIR/runtime/current/bin/node"
    return 0
  fi
  provision_node
}

download_app() {
  UC_TARBALL_PATH="$UC_TMP/ultracode-$UC_RESOLVED_VERSION.tar.gz"
  uc_fetch "$UC_TARBALL_PATH" \
    "$UC_BASE_URL/releases/v$UC_RESOLVED_VERSION/ultracode-$UC_RESOLVED_VERSION.tar.gz" 600
  uc_app_actual=$(sha256_of "$UC_TARBALL_PATH")
  if [ "$uc_app_actual" != "$UC_EXPECTED_SHA" ]; then
    die "sha256 mismatch for ultracode-$UC_RESOLVED_VERSION.tar.gz (expected $UC_EXPECTED_SHA, got $uc_app_actual) — corrupted download; re-run the installer"
  fi
}

write_receipt() {
  uc_now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  cat > "$1" <<EOF
{
  "schema": 1,
  "version": "$UC_RESOLVED_VERSION",
  "installedAt": "$uc_now",
  "baseUrl": "$UC_BASE_URL",
  "platform": "$UC_OS-$UC_ARCH",
  "node": "$UC_NODE_BIN",
  "installDir": "$UC_INSTALL_DIR",
  "binDir": "$UC_BIN_DIR"
}
EOF
}

install_app() {
  mkdir -p "$UC_TMP/app-extract"
  tar -xzf "$UC_TARBALL_PATH" -C "$UC_TMP/app-extract"
  uc_extracted="$UC_TMP/app-extract/ultracode-$UC_RESOLVED_VERSION"
  [ -f "$uc_extracted/dist/cli/main.js" ] || die 'unexpected release tarball layout (missing dist/cli/main.js)'
  # The receipt rides inside the extracted tree so the final rename lands the
  # payload and its proof-of-completeness in one atomic step.
  write_receipt "$uc_extracted/.install-receipt.json"
  mkdir -p "$UC_INSTALL_DIR/app"
  for uc_stale in "$UC_INSTALL_DIR/app"/.stage-*; do
    [ -e "$uc_stale" ] || continue
    stage_pid_live "$uc_stale" - && continue
    rm -rf "$uc_stale"
  done
  uc_app_stage="$UC_INSTALL_DIR/app/.stage-$$"
  mv "$uc_extracted" "$uc_app_stage"
  # Decide at the last instant, mirroring provision_node: a concurrent
  # same-version install may have landed a complete copy while we downloaded
  # — keep it (current/a detached runner may already reference it) instead
  # of wiping and re-landing ours.
  if [ -f "$UC_APP_TARGET/.install-receipt.json" ] && [ -f "$UC_APP_TARGET/dist/cli/main.js" ]; then
    rm -rf "$uc_app_stage"
  else
    if [ -e "$UC_APP_TARGET" ] || [ -L "$UC_APP_TARGET" ]; then
      warn "removing incomplete install at $UC_APP_TARGET"
      rm -rf "$UC_APP_TARGET"
    fi
    mv "$uc_app_stage" "$UC_APP_TARGET"
  fi
}

flip_current() {
  uc_current="$UC_INSTALL_DIR/app/current"
  UC_PREV_VERSION=''
  if [ -L "$uc_current" ]; then
    uc_prev_target=$(readlink "$uc_current" || true)
    UC_PREV_VERSION=${uc_prev_target##*/}
  elif [ -e "$uc_current" ]; then
    die "$uc_current exists but is not a symlink; move it aside and re-run the installer"
  fi
  link_swap "$UC_APP_TARGET" "$uc_current"
}

write_shim() {
  uc_shim="$UC_BIN_DIR/ultracode"
  mkdir -p "$UC_BIN_DIR"
  if [ -e "$uc_shim" ] || [ -L "$uc_shim" ]; then
    if ! grep -q ultracode-oss-shim "$uc_shim" 2>/dev/null; then
      mv "$uc_shim" "$UC_BIN_DIR/ultracode.pre-oss.bak"
      info "notice: existing $uc_shim is not an ultracode shim; moved it to $UC_BIN_DIR/ultracode.pre-oss.bak"
    fi
  fi
  uc_shim_tmp="$UC_BIN_DIR/.ultracode.tmp.$$"
  cat > "$uc_shim_tmp" <<EOF
#!/bin/sh
# ultracode-oss-shim — generated by the ultracode installer; edits are overwritten.
set -eu
uc_node="$UC_NODE_BIN"
if [ ! -x "\$uc_node" ]; then
  uc_node="$UC_INSTALL_DIR/runtime/current/bin/node"
fi
if [ ! -x "\$uc_node" ]; then
  uc_node=\$(command -v node 2>/dev/null || true)
  uc_ok=''
  if [ -n "\$uc_node" ]; then
    uc_v=\$("\$uc_node" --version 2>/dev/null || true)
    uc_v=\${uc_v#v}
    uc_major=\${uc_v%%.*}
    case "\$uc_major" in
      ''|*[!0-9]*) : ;;
      *) if [ "\$uc_major" -ge 20 ]; then uc_ok=1; fi ;;
    esac
  fi
  if [ -z "\$uc_ok" ]; then
    printf '%s\n' 'ultracode: no usable Node >= 20; re-run the installer' >&2
    exit 1
  fi
fi
exec "\$uc_node" "$UC_INSTALL_DIR/app/current/dist/cli/main.js" "\$@"
EOF
  chmod +x "$uc_shim_tmp"
  mv "$uc_shim_tmp" "$uc_shim"
}

path_hint() {
  case ":$PATH:" in
    *":$UC_BIN_DIR:"*) : ;;
    *)
      case "${SHELL:-/bin/bash}" in
        */zsh) info "note: $UC_BIN_DIR is not on your PATH — add to ~/.zshrc: export PATH=\"$UC_BIN_DIR:\$PATH\"" ;;
        */fish) info "note: $UC_BIN_DIR is not on your PATH — run: fish_add_path \"$UC_BIN_DIR\"" ;;
        *) info "note: $UC_BIN_DIR is not on your PATH — add to ~/.bashrc: export PATH=\"$UC_BIN_DIR:\$PATH\"" ;;
      esac
      ;;
  esac
  uc_existing=$(command -v ultracode 2>/dev/null || true)
  if [ -n "$uc_existing" ] && [ "$uc_existing" != "$UC_BIN_DIR/ultracode" ]; then
    warn "an 'ultracode' at $uc_existing shadows this install; if it is a stale npm link, run: npm unlink -g ultracode"
  fi
}

report_success() {
  info ''
  info "ultracode $UC_RESOLVED_VERSION installed."
  info "  engine: $UC_APP_TARGET"
  info "  shim:   $UC_BIN_DIR/ultracode"
  info "Run 'ultracode doctor' to verify the install."
  if [ -n "$UC_PREV_VERSION" ] && [ "$UC_PREV_VERSION" != "$UC_RESOLVED_VERSION" ]; then
    info "Upgraded from $UC_PREV_VERSION (old versions are retained on purpose)."
    info "Re-run 'ultracode install codex' (or your host) so host integrations pick up the new engine path."
  fi
}

cleanup_tmp() {
  rm -rf "$UC_TMP"
}

main() {
  apply_defaults
  require_curl
  detect_platform
  UC_TMP=$(mktemp -d)
  trap cleanup_tmp EXIT
  trap 'exit 1' INT TERM
  resolve_version
  UC_APP_TARGET="$UC_INSTALL_DIR/app/$UC_RESOLVED_VERSION"
  choose_node
  if [ -f "$UC_APP_TARGET/.install-receipt.json" ] && [ -f "$UC_APP_TARGET/dist/cli/main.js" ]; then
    # A receipted dir WITH its payload is a valid same-version install — a
    # detached runner may be executing from it right now, so keep it and skip
    # the download; the symlink and shim below still get refreshed. A receipt
    # whose payload vanished is treated as incomplete and reinstalled.
    info "ultracode $UC_RESOLVED_VERSION is already installed; keeping the existing copy"
  else
    info "installing ultracode $UC_RESOLVED_VERSION ($UC_OS-$UC_ARCH) into $UC_INSTALL_DIR"
    download_app
    install_app
  fi
  flip_current
  write_shim
  path_hint
  report_success
}

main "$@"
