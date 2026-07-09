/**
 * The signed permission snapshot shape (rbac.md §14, adoption §8.2). Lives in
 * `common/` — not `auth/mobile/` — because it's a genuine cross-module leaf
 * type: the auth module's snapshot service builds it, but invitation-accept
 * and store-creation (stores/*) also embed it in their responses so the
 * client can patch its session in place instead of a full bootstrap round
 * trip. A response DTO never imports anything from another module
 * (layered-architecture.md §3.8) — this file is the shared leaf both sides
 * import from, so neither the auth module nor the stores module reaches into
 * the other's internals.
 *
 * The snake_case field names below are intentional, not an oversight: this
 * shape is signed byte-for-byte (`CryptoService.canonicalJson` + `signSnapshot`)
 * and sent to the client as-is — a response mapper reshaping it would
 * invalidate the signature. It is the one wire-facing shape that lives outside
 * `dto/response/` because its bytes, not just its type, are the contract.
 */

/**
 * Per-store access: this user's own CRUD grants IN THAT STORE
 * (`entityCode:action` strings — same wire form the old flat
 * `globalPermissions` used, just scoped now). A user can hold different
 * roles in different stores (e.g. Owner in one, cashier in another); a
 * flattened cross-store list let a permission held in Store A leak into the
 * mobile UI's gating while Store B was active. Client-UX mirror only — never
 * an authorization input, on either side.
 */
export interface StoreEntry {
  store_id:            string;
  name:                string;
  permissions:         string[];
}

export interface PermissionSnapshot {
  userId:             string;
  permissionsVersion: number;
  generatedAt:        string;
  stores:             StoreEntry[];
}

export interface SnapshotResult {
  snapshot:  PermissionSnapshot;
  signature: string;
}
