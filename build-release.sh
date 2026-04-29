#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
METADATA_FILE="${SCRIPT_DIR}/metadata.json"
SCHEMA_FILE="${SCRIPT_DIR}/schemas/org.gnome.shell.extensions.codex-usage.gschema.xml"

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        printf 'Missing required command: %s\n' "$1" >&2
        exit 1
    fi
}

read_metadata_value() {
    local key="$1"

    sed -nE "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/p" "${METADATA_FILE}" | head -n 1
}

pack_with_zip() {
    local default_bundle="$1"
    local staging_dir

    require_command zip
    staging_dir="$(mktemp -d)"
    cleanup_staging_dir() {
        rm -rf -- "${staging_dir}"
    }
    trap cleanup_staging_dir EXIT

    printf 'Packing extension bundle with zip fallback...\n'

    cp "${SCRIPT_DIR}/metadata.json" "${staging_dir}/"
    cp "${SCRIPT_DIR}/extension.js" "${staging_dir}/"
    cp "${SCRIPT_DIR}/codex.js" "${staging_dir}/"
    cp "${SCRIPT_DIR}/prefs.js" "${staging_dir}/"
    cp "${SCRIPT_DIR}/stylesheet.css" "${staging_dir}/"

    if [[ -f "${SCRIPT_DIR}/LICENSE" ]]; then
        cp "${SCRIPT_DIR}/LICENSE" "${staging_dir}/"
    fi

    if [[ -f "${SCRIPT_DIR}/README.md" ]]; then
        cp "${SCRIPT_DIR}/README.md" "${staging_dir}/"
    fi

    mkdir -p "${staging_dir}/schemas"
    cp "${SCHEMA_FILE}" "${staging_dir}/schemas/"
    cp "${SCRIPT_DIR}/schemas/gschemas.compiled" "${staging_dir}/schemas/"

    (
        cd "${staging_dir}"
        zip -qr "${default_bundle}" .
    )

    rm -rf -- "${staging_dir}"
    trap - EXIT
}

require_command glib-compile-schemas

if [[ ! -f "${METADATA_FILE}" ]]; then
    printf 'Missing metadata file: %s\n' "${METADATA_FILE}" >&2
    exit 1
fi

if [[ ! -f "${SCHEMA_FILE}" ]]; then
    printf 'Missing schema file: %s\n' "${SCHEMA_FILE}" >&2
    exit 1
fi

UUID="$(read_metadata_value uuid)"
VERSION_NAME="$(read_metadata_value version-name)"

if [[ -z "${UUID}" ]]; then
    printf 'Unable to read "uuid" from %s\n' "${METADATA_FILE}" >&2
    exit 1
fi

if [[ -z "${VERSION_NAME}" ]]; then
    printf 'Unable to read "version-name" from %s\n' "${METADATA_FILE}" >&2
    exit 1
fi

mkdir -p "${DIST_DIR}"

printf 'Compiling schemas...\n'
glib-compile-schemas "${SCRIPT_DIR}/schemas"

DEFAULT_BUNDLE="${DIST_DIR}/${UUID}.shell-extension.zip"
VERSIONED_BUNDLE="${DIST_DIR}/${UUID}-${VERSION_NAME}.zip"

rm -f "${DEFAULT_BUNDLE}" "${VERSIONED_BUNDLE}"
pack_with_zip "${DEFAULT_BUNDLE}"

mv -f "${DEFAULT_BUNDLE}" "${VERSIONED_BUNDLE}"

printf 'Release bundle ready: %s\n' "${VERSIONED_BUNDLE}"
