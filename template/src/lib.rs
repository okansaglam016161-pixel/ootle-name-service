//! ONS — Ootle Name Service
//!
//! A decentralised username registry on the Tari Ootle. A name maps to an owner and an open set
//! of string key→value records. Bound (non-transferable) names for now. Designed to be reused by
//! any Tari project; Caravel is the first consumer.
//!
//! Security model: ownership is the transaction signer's Ristretto public key
//! (`CallerContext::transaction_signer_public_key()`), which cannot be forged. There is no way to
//! register a name pointing at someone else's identity, and only the recorded owner can mutate a
//! name's records. See README.md for the record-key convention (e.g. "nostr", "tari").

use tari_template_lib::prelude::*;
use std::collections::{BTreeMap, HashMap};

// ── Guardrails: bound on-chain state so a permissionless registry can't be griefed into bloat ──
const MAX_NAME_LEN: usize = 32; // names are map keys; short + ASCII keeps the shared component small
const MAX_KEY_LEN: usize = 64; // record keys are conventions ("nostr", "tari", …), bounded
const MAX_VALUE_LEN: usize = 512; // fits a hex Nostr key (64), an npub (~63) or an otl_esm_ address (~66) with headroom
const MAX_RECORDS_PER_NAME: usize = 16; // caps per-name growth; covers nostr+tari+a dozen app records

#[template]
mod ootle_name_service {
    use super::*;

    // The component (MUST be the first struct in the module — the macro treats the first as the
    // component). A single shared component gives global uniqueness via an atomic check-then-insert;
    // NFT-per-name was rejected because uniqueness can't be enforced across independent objects.
    pub struct OotleNameService {
        registry: HashMap<String, NameRecord>,
    }

    // A registered name's data: the unforgeable owner + an open key→value map. Not a fixed struct
    // of fields — the contract stores arbitrary string records and does NOT interpret the keys.
    #[derive(Clone)]
    pub struct NameRecord {
        pub owner: RistrettoPublicKeyBytes,
        pub records: BTreeMap<String, String>,
    }

    impl OotleNameService {
        /// Deploy the registry. All methods are public; write-authorisation is enforced in-method
        /// against the caller's identity (see `set_record`).
        pub fn new() -> Component<Self> {
            Component::new(Self { registry: HashMap::new() })
                .with_access_rules(ComponentAccessRules::allow_all())
                .create()
        }

        /// Register a new name. The caller becomes the owner. Fails if the name is invalid or taken.
        /// Uniqueness is atomic: the check and insert happen in one transaction on one component.
        pub fn register(&mut self, name: String) {
            validate_name(&name);
            assert!(
                !self.registry.contains_key(&name),
                "Name '{}' is already registered",
                name
            );
            let owner = CallerContext::transaction_signer_public_key();
            emit_event("NameRegistered", metadata!["name" => name.clone()]);
            self.registry.insert(
                name,
                NameRecord { owner, records: BTreeMap::new() },
            );
        }

        /// Set (or overwrite) a key→value record on a name. Only the name's owner — the exact
        /// caller who registered it — may do this. The caller can't be forged, so nobody can modify
        /// a name they don't own. The contract does not interpret the key or value.
        pub fn set_record(&mut self, name: String, key: String, value: String) {
            assert!(
                !key.is_empty() && key.len() <= MAX_KEY_LEN,
                "Record key length must be 1..={} bytes",
                MAX_KEY_LEN
            );
            assert!(
                value.len() <= MAX_VALUE_LEN,
                "Record value too long (max {} bytes)",
                MAX_VALUE_LEN
            );
            let caller = CallerContext::transaction_signer_public_key();
            let record = self
                .registry
                .get_mut(&name)
                .unwrap_or_else(|| panic!("Name '{}' is not registered", name));
            assert!(
                record.owner == caller,
                "Caller is not the owner of '{}'",
                name
            );
            // Only enforce the per-name cap when adding a NEW key (overwrites are always allowed).
            if !record.records.contains_key(&key) {
                assert!(
                    record.records.len() < MAX_RECORDS_PER_NAME,
                    "Name '{}' already holds the maximum of {} records",
                    name,
                    MAX_RECORDS_PER_NAME
                );
            }
            record.records.insert(key, value);
        }

        /// Public read: the value for (name, key), or None if the name or key is absent.
        pub fn get_record(&self, name: String, key: String) -> Option<String> {
            self.registry
                .get(&name)
                .and_then(|r| r.records.get(&key).cloned())
        }

        /// Public read: the full record for a name — (owner, all records) — or None if unregistered.
        pub fn lookup(
            &self,
            name: String,
        ) -> Option<(RistrettoPublicKeyBytes, BTreeMap<String, String>)> {
            self.registry.get(&name).map(|r| (r.owner, r.records.clone()))
        }

        /// Public read: whether a name is registered.
        pub fn is_registered(&self, name: String) -> bool {
            self.registry.contains_key(&name)
        }
    }

    // Name policy: non-empty, <= MAX_NAME_LEN bytes, ASCII lowercase [a-z0-9_-] only. Lowercase-only
    // avoids case/homoglyph impersonation (one canonical form per name). Panics reject invalid names.
    fn validate_name(name: &str) {
        assert!(!name.is_empty(), "Name cannot be empty");
        assert!(
            name.len() <= MAX_NAME_LEN,
            "Name too long (max {} bytes)",
            MAX_NAME_LEN
        );
        for c in name.chars() {
            let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-';
            assert!(
                ok,
                "Invalid character '{}' in name (allowed: a-z 0-9 _ -)",
                c
            );
        }
    }
}
