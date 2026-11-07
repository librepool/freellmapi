import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deprecated FreeLLMAPI-era names, accepted for one release. When the new
// LIBREPOOL_* name is unset and the old name is set, the old value is copied
// across and a warning is logged; the new name always wins when both are set.
// The old names are left in place in process.env so code that still reads
// them (e.g. the feed-service agent's files) keeps working during the move.
const DEPRECATED_ENV_ALIASES: Record<string, string> = {
  FREEAPI_ENV_PATH: 'LIBREPOOL_ENV_PATH',
  FREEAPI_DB_PATH: 'LIBREPOOL_DB_PATH',
  FREEAPI_DB_DIR_HARDENING: 'LIBREPOOL_DB_DIR_HARDENING',
  FREEAPI_DB_BACKUP_PATH: 'LIBREPOOL_DB_BACKUP_PATH',
  FREEAPI_DB_BACKUP_URL: 'LIBREPOOL_DB_BACKUP_URL',
  FREEAPI_DB_BACKUP_TOKEN: 'LIBREPOOL_DB_BACKUP_TOKEN',
  FREEAPI_DB_BACKUP_KEY: 'LIBREPOOL_DB_BACKUP_KEY',
  FREEAPI_DB_BACKUP_INTERVAL_MS: 'LIBREPOOL_DB_BACKUP_INTERVAL_MS',
  FREEAPI_DB_BACKUP_TARGET: 'LIBREPOOL_DB_BACKUP_TARGET',
  FREEAPI_CONFIG_PATH: 'LIBREPOOL_CONFIG_PATH',
  FREEAPI_CONFIG_JSON: 'LIBREPOOL_CONFIG_JSON',
  FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS: 'LIBREPOOL_BLOCK_PRIVATE_PROVIDER_URLS',
  FREEAPI_PROXY_LOCAL_DESTINATIONS: 'LIBREPOOL_PROXY_LOCAL_DESTINATIONS',
  FREEAPI_DESKTOP: 'LIBREPOOL_DESKTOP',
  FREEAPI_VERSION: 'LIBREPOOL_VERSION',
  FREELLMAPI_COMPRESSION: 'LIBREPOOL_COMPRESSION',
  FREELLMAPI_CONTEXT_HANDOFF: 'LIBREPOOL_CONTEXT_HANDOFF',
  FREELLMAPI_COMMIT_SHA: 'LIBREPOOL_COMMIT_SHA',
  FREELLMAPI_INSTALL_METHOD: 'LIBREPOOL_INSTALL_METHOD',
  FREELLMAPI_UPDATE_CHECK: 'LIBREPOOL_UPDATE_CHECK',
  FREELLMAPI_UPDATE_GITHUB_TOKEN: 'LIBREPOOL_UPDATE_GITHUB_TOKEN',
  FREELLMAPI_SELF_UPDATE_URL: 'LIBREPOOL_SELF_UPDATE_URL',
  FREELLMAPI_SELF_UPDATE_TOKEN: 'LIBREPOOL_SELF_UPDATE_TOKEN',
};

function applyDeprecatedEnvAliases(): void {
  for (const [oldName, newName] of Object.entries(DEPRECATED_ENV_ALIASES)) {
    const oldValue = process.env[oldName];
    if (oldValue === undefined) continue;
    if (process.env[newName] === undefined) process.env[newName] = oldValue;
    console.warn(`[config] ${oldName} is deprecated; use ${newName} instead.`);
  }
}

// LIBREPOOL_ENV_PATH lets embedders (e.g. the desktop app, where __dirname sits
// inside a bundle) point at an explicit .env — or at nothing: dotenv silently
// no-ops on a missing file either way.
dotenv.config({
  path:
    process.env.LIBREPOOL_ENV_PATH
    ?? process.env.FREEAPI_ENV_PATH
    ?? path.resolve(__dirname, '../../.env'),
});

// Aliases are applied after dotenv loads so old names from the .env file are
// honoured too, not just ones inherited from the shell.
applyDeprecatedEnvAliases();
