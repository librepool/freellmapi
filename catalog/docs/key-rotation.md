# Ed25519 key rotation

The catalog feed signs every `/v1/latest` response with Ed25519; the
router verifies `x-catalog-signature` against the pinned public key
`PINNED_CATALOG_PUBKEY` in `server/src/services/catalog-sync.ts` (with a
`CATALOG_PUBKEY` env override for testing). This doc is the full rotation
flow, the rules that keep a rotation from breaking every router, and the
emergency procedure for a compromised key.

## Rules (non-negotiable)

1. **The dev keypair in `catalog/dev-keys/` must NEVER be used in
   production and must never be committed.** That directory is
   git-ignored (`.gitignore: catalog/dev-keys/` — verify it stays that
   way; `git check-ignore -v catalog/dev-keys/signing-private.pem`
   must match). A dev key is generated on a dev machine, has been
   copied around, and its public half is already pinned in the fork
   today — treat it as public knowledge.
2. **A production keypair is generated ON the feed host** (or in the
   host's secret store), never on a dev machine, never in this repo,
   never pasted into chat, email, or a ticket. The private key leaves
   the host never.
3. **No production key exists yet.** Do not "rotate" to anything until
   Alex / the host operator generates the first production keypair.
   `PINNED_CATALOG_PUBKEY` in the router still holds the upstream
   FreeLLMAPI key — replacing it is an Alex/host step, not something
   any agent does unilaterally.
4. Never put a real key value in code, config, docs, or reports. The
   only place a production private key lives is the host secret store;
   the only place a production public key lives is the pinned constant
   (and the `CATALOG_PUBKEY` override when testing).
5. Keep the old private key until the rotation is verified end to end.
   Destroying it early turns a bad deploy into an outage with no
   rollback.

## Fingerprints

`keyFingerprint(publicPem)` (`src/signing.ts`) is the first 16 hex
chars of the SHA-256 of the SPKI DER encoding. It is printed by
`generate-keypair.ts` and is the short handle for a key — use it to
confirm, without pasting a whole PEM, that the router pins the key you
think it pins. A fingerprint is not a secret, but it is also not a
substitute for comparing the full PEM: always compare the PEM itself
before deploying a production rotation.

## Generating a keypair

On the feed host (production) or locally (dev only):

```bash
node scripts/generate-keypair.ts [--out <dir>] [--force]
```

- Default `--out` is `catalog/dev-keys/` — **dev keys only**.
- Refuses to overwrite existing key files unless `--force` is passed
  (overwriting destroys the old keypair — only do it after a rotation
  completes, or if the old key was never pinned anywhere).
- Prints the public PEM, its fingerprint, and the exact
  `PINNED_CATALOG_PUBKEY` replacement snippet for
  `server/src/services/catalog-sync.ts`.

For production, run it on the host with `--out` pointing at the host's
secret directory (or generate in the secret store directly), then set
one of:

- `CATALOG_SIGNING_PRIVATE_KEY_PEM` — inline PEM (`\n` escapes), or
- `CATALOG_SIGNING_KEY_PATH` — path to the private PEM file.

The feed service logs the signing public key (and therefore its
fingerprint, via `keyFingerprint()`) at startup — that is the value to
compare against the router's pin.

## Rotation flow (planned rotation)

There is no overlap window in the protocol: the router trusts exactly
one pinned key (plus the `CATALOG_PUBKEY` env override). Rotation is
therefore a coordinated two-deploy sequence with a verification gate
between them. Do it in a low-traffic window and keep the old private key
until the last step.

1. **Generate on the host.** Generate the new keypair on the feed host
   per above. Record its fingerprint. Do not deploy anything yet.
2. **Stage the new public key in the router.** Replace
   `PINNED_CATALOG_PUBKEY` in `server/src/services/catalog-sync.ts`
   with the new public PEM (the exact snippet is printed by
   `generate-keypair.ts`). Commit and deploy the router — but note the
   router will now REJECT the feed's signatures until step 3, because
   the feed still signs with the old key. To avoid a verification gap,
   prefer the safer order below if the deploy pipeline allows it:
   deploy the router change behind the `CATALOG_PUBKEY` env override
   first (override = old key, so nothing changes), then flip the
   override to the new key at the same moment the feed service is
   restarted with the new private key. If the pipeline does not allow
   that, accept a short window where routers fall back to their
   bundled catalog (a failed signature discards the payload; the
   router keeps serving its last good catalog) and keep the window
   as short as possible.
3. **Deploy the feed service with the new private key.** Set
   `CATALOG_SIGNING_PRIVATE_KEY_PEM` / `CATALOG_SIGNING_KEY_PATH` to
   the new key and restart. Confirm the startup log shows the new
   public key / fingerprint.
4. **Deploy the router with the new pin** (if not already done via the
   override flip in step 2). The router now verifies against the new
   key.
5. **Verify a live round-trip** (see below). All three checks must pass
   before the old key is retired.
6. **Retire the old key.** Only after step 5 passes: remove the old
   private key from the host secret store, remove any `CATALOG_PUBKEY`
   override that still points at the old key, and record the rotation
   (date, old fingerprint → new fingerprint) in the ops notes. The old
   public key can stay in git history — it is public — but it must not
   remain pinned or configured anywhere live.

## Verification (live round-trip)

Run against the deployed feed service with a dev router (or curl +
manual verify) and require all of these:

1. `GET /v1/latest` with no key returns tier `monthly`, HTTP 200, and
   an `x-catalog-signature` that verifies against the **new** public
   key (`verifyBytes` in `src/signing.ts`, or
   `node scripts/sign-catalog.ts` in reverse).
2. `GET /v1/latest` with `Authorization: Bearer <live license key>`
   returns tier `live` and a signature that verifies against the new
   public key.
3. A router pointed at the feed (`CATALOG_BASE_URL`, `CATALOG_PUBKEY`
   unset so it uses the new pin) completes a sync: `syncCatalog`
   applies the catalog, no signature failure in the logs, and the
   applied version matches the feed's version.
4. The old public key no longer verifies new signatures (sanity check
   that the feed really switched, not that both keys somehow work).

If any check fails, roll back: restart the feed service with the old
private key and (if the pin was already deployed) revert the router pin
or flip `CATALOG_PUBKEY` back to the old public key. The old key is why
step 6 waits.

## Emergency rotation (key compromised)

If a production private key is suspected leaked:

1. Generate a new keypair on the host immediately.
2. Deploy the feed service with the new private key and the router with
   the new pin as fast as the pipeline allows (same steps 2–4 above,
   compressed — accept the verification gap; a leaked key is worse).
3. Verify the round-trip (step 5 above).
4. Retire the old key everywhere and treat every catalog payload signed
   with it after the compromise window as untrusted (routers already
   reject them once the pin moves).
5. Investigate the leak: how the key left the host, what else was
   exposed, and whether the host itself needs rebuilding before it is
   trusted with the next key.

There is no way to revoke a single Ed25519 key without rotating the
pin — the pin IS the trust root. That is why the private key never
leaves the host in the first place.

## What agents must not do

- Do not generate a keypair and present it as a production key. Any
  keypair generated on this VM is a dev key.
- Do not change `PINNED_CATALOG_PUBKEY` in the router. That change
  ships only with Alex's go-ahead and a host-generated production key.
- Do not commit `catalog/dev-keys/` or any `*.pem` (verify with
  `git status --short` after any key work — nothing under `dev-keys/`
  may ever appear).
