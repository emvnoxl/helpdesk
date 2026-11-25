#!/bin/sh
# Installs the newest version on this server: gets the code, rebuilds and restarts. People using the helpdesk see
# "being updated" and come back by themselves. Your data and settings are kept.
#   ./update.sh                    (normal)
#   ./update.sh --profile https    (if you run the built-in HTTPS; extra words go to docker compose)
set -e
cd "$(dirname "$0")"
git pull --ff-only
BUILD_ID="$(git rev-parse --short=7 HEAD)"
BUILD_NOTE="$(git log -1 --format=%s)"
export BUILD_ID BUILD_NOTE
docker compose "$@" up -d --build
echo "Updated to $BUILD_ID: $BUILD_NOTE"
