#!/usr/bin/env bash
# The LibrePool installer moved to https://librepool.com/install.sh
# This shim keeps old `curl ... github.io ... | bash` one-liners working.
set -euo pipefail
exec bash -c "$(curl -fsSL https://librepool.com/install.sh)"
