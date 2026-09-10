# LibreSync in LibreLog

LibreLog can synchronize through a separately hosted LibreSync server. Synchronization and backup are independent: enabling LibreSync does not replace JSON, encrypted, browser, migration-checkpoint, or WebDAV backups.

## Synchronized data

LibreLog synchronizes foods, meals, recipes, measurements, nutrition goals, theme, unit preference, daily notes (`note_*`), and saved meal templates (`template_*`). New setting keys are local-only unless a future LibreLog release explicitly adds them to this allowlist.

API caches; AI, USDA, WebDAV, and GitHub credentials; credential-protection configuration; AI provider/model/Ollama configuration; privacy consent; AI usage logs; initialization flags; backup timestamps; integrity metadata; and all LibreSync secrets and operational state stay on this device. Portable, automatic, migration-checkpoint, and WebDAV backups use the same positive user-data allowlist and exclude every device-local setting, credential, and LibreSync store.

## Pairing and encryption

Each LibreLog dataset has its own random 256-bit vault secret. It is not shared with LibreLift, even when both applications use the same server. Operations are encrypted in the browser with AES-256-GCM using a key derived by HKDF-SHA-256. The relay sees the vault, operation identifier, key epoch, nonce, ciphertext, and cursors, but not LibreLog record types, identifiers, causal metadata, or payloads.

An authorized device creates a short-lived, single-use invitation. The copyable pairing payload contains the server URL, application ID, vault ID, vault secret, and invitation token. Treat it like a password until it is consumed. There is no recovery phrase: an authorized device is required to pair another device.

Revoking a device prevents future relay access. It cannot erase copies already downloaded by that device or invalidate the vault secret it already learned. If that risk is unacceptable, create a new vault and pair only trusted devices.

## Offline and conflict behavior

Writes commit to LibreLog and its local outbox in one IndexedDB transaction, so LibreLog remains usable while the server is unavailable. Encrypted envelope bytes are persisted before upload and exact bytes are reused after timeouts. Remote operations update domain records, causal heads, conflicts, inbox status, and the continuation cursor atomically without producing outbox echoes.

Best-effort synchronization runs while LibreLog is open: at launch, after network reconnect, on foreground/resume, after a short local-mutation debounce, and from **Sync Now**. LibreLog does not promise closed-app background synchronization.

Concurrent values are retained. LibreLog shows one deterministic projection on every device while keeping all alternatives available in Settings. A live edit remains visible during an edit-versus-delete conflict. Choosing or merging a value emits a new operation that causally supersedes every conflicting head. Display timestamps never determine which value wins.

## Joining, restore, and deletion

Before joining a populated vault, LibreLog asks you to save a portable JSON safety backup and reads back and validates its exact bytes. On browsers without direct file saving, LibreLog downloads the file and then asks you to select that saved file once for exact verification. It then retains local records, pulls remote history, reconciles by stable identity, publishes local-only records, and exposes same-ID differences as conflicts. Canceling, selecting a different file, or failing the safety-backup write stops the join before the single-use invitation is consumed. Different record UUIDs remain distinct even when their names or dates match.

Merge imports become normal synchronized mutations. A full replacement requires explicit confirmation and emits the corresponding upserts and tombstones; it never leaves stale causal metadata behind. Migration checkpoints and WebDAV restores follow the same rule while synchronization is connected.

Before the first connection, LibreLog deterministically maps built-in foods to versioned semantic IDs, remaps meal/recipe/template references, and backfills stable child `itemId` values. Newly created records and children use `crypto.randomUUID()`. This prevents independently initialized devices from duplicating built-in foods while preserving legacy non-seed IDs.

The Settings screen distinguishes:

- disconnecting LibreSync while preserving all local LibreLog data (the local identity rotates, so re-pairing registers a new device; the abandoned server entry remains until another authorized device revokes it or the vault is deleted);
- clearing all data and credentials from this device while leaving the remote vault and other devices unchanged;
- deleting synchronized LibreLog records everywhere by emitting tombstones; and
- permanently deleting the remote vault, including relay operations, invitations, and device credentials.

All destructive actions require separate confirmation. A remote vault deletion is irreversible at the relay, though independent backups and copies already held by devices may still exist.
