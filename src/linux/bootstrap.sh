#!/usr/bin/env bash
set -euo pipefail

# Best-effort bootstrap for Linux:
# - If node/npm are missing, try to install via detected package manager
# - Then run repo dependency install script
#
# This is NOT guaranteed to be fully unattended:
# - sudo may prompt for password
# - some distros may ship old Node.js/npm in default repos
#
# Run from repo root:
#   bash scripts/linux/bootstrap.sh

log() { echo "[bootstrap] $*"; }
warn() { echo "[bootstrap][warn] $*" >&2; }
err() { echo "[bootstrap][error] $*" >&2; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

need_sudo() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    if has_cmd sudo; then
      echo "sudo"
    else
      err "This script needs root privileges to install packages, but 'sudo' is not available. Re-run as root."
      exit 1
    fi
  else
    echo ""
  fi
}

install_node_apt() {
  local sudo_cmd
  sudo_cmd="$(need_sudo)"
  log "Detected apt-get. Installing nodejs + npm..."
  ${sudo_cmd} apt-get update
  ${sudo_cmd} apt-get install -y nodejs npm
}

install_node_dnf() {
  local sudo_cmd
  sudo_cmd="$(need_sudo)"
  log "Detected dnf. Installing nodejs + npm..."
  if ! ${sudo_cmd} dnf install -y nodejs npm; then
    warn "dnf install failed. Some distros use module streams. Try:"
    warn "  sudo dnf module list nodejs"
    warn "  sudo dnf module install nodejs:<stream>"
    return 1
  fi
}

install_node_yum() {
  local sudo_cmd
  sudo_cmd="$(need_sudo)"
  log "Detected yum. Installing nodejs + npm..."
  ${sudo_cmd} yum install -y nodejs npm
}

install_node_pacman() {
  local sudo_cmd
  sudo_cmd="$(need_sudo)"
  log "Detected pacman. Installing nodejs + npm..."
  ${sudo_cmd} pacman -Sy --noconfirm nodejs npm
}

install_node_zypper() {
  local sudo_cmd
  sudo_cmd="$(need_sudo)"
  log "Detected zypper. Installing nodejs + npm..."
  ${sudo_cmd} zypper --non-interactive install nodejs npm
}

install_node_best_effort() {
  if has_cmd apt-get; then
    install_node_apt
    return
  fi
  if has_cmd dnf; then
    install_node_dnf
    return
  fi
  if has_cmd yum; then
    install_node_yum
    return
  fi
  if has_cmd pacman; then
    install_node_pacman
    return
  fi
  if has_cmd zypper; then
    install_node_zypper
    return
  fi

  err "No supported package manager detected (apt-get, dnf, yum, pacman, zypper). Install Node.js + npm manually and re-run."
  exit 1
}

log "m3uHandler Linux bootstrap"

if ! has_cmd node || ! has_cmd npm; then
  warn "node/npm not found. Attempting installation via system package manager..."
  install_node_best_effort
fi

if ! has_cmd node || ! has_cmd npm; then
  err "node/npm still not available after install attempt."
  err "Install Node.js manually (https://nodejs.org/) and re-run this script."
  exit 1
fi

log "Node.js: $(node --version)"
log "npm: $(npm --version)"

log "Installing repo dependencies..."
npm run install-deps

log "Done. You can now run (from the repo folder):"
log "  npm run gui"