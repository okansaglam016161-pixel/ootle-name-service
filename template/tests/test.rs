//! ONS local logic tests (tari_template_test_tooling). Proves registration, uniqueness, the
//! owner-only write authorisation (the core security property), reads, and name validation.

use std::collections::BTreeMap;
use tari_template_lib::prelude::{ComponentAddress, RistrettoPublicKeyBytes};
use tari_template_test_tooling::transaction::{args, Transaction};
use tari_template_test_tooling::TemplateTest;

// Deploy a fresh registry; returns its component address. The default test account is the caller.
fn deploy(test: &mut TemplateTest) -> ComponentAddress {
    test.call_function("OotleNameService", "new", args![], vec![test.owner_proof()])
}

// Register `name` as the DEFAULT account (caller A), expecting success.
fn register_ok(test: &mut TemplateTest, ons: ComponentAddress, name: &str) {
    test.execute_expect_success(
        Transaction::builder_localnet()
            .call_method(ons, "register", args![name])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
}

// Owner (default account A) sets a record, expecting success.
fn set_record_ok(test: &mut TemplateTest, ons: ComponentAddress, name: &str, key: &str, value: &str) {
    test.execute_expect_success(
        Transaction::builder_localnet()
            .call_method(ons, "set_record", args![name, key, value])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
}

#[test]
fn register_succeeds_and_name_is_registered() {
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);

    register_ok(&mut test, ons, "okz");

    let registered: bool = test.call_method(ons, "is_registered", args!["okz"], vec![test.owner_proof()]);
    assert!(registered, "name 'okz' should be registered after register()");

    // The record exists with an owner (the caller became the owner).
    let rec: Option<(RistrettoPublicKeyBytes, BTreeMap<String, String>)> =
        test.call_method(ons, "lookup", args!["okz"], vec![test.owner_proof()]);
    let (_owner, records) = rec.expect("lookup should return Some for a registered name");
    assert!(records.is_empty(), "a freshly registered name has no records yet");
}

#[test]
fn duplicate_registration_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);

    register_ok(&mut test, ons, "okz");

    // Registering the SAME name again must fail (global uniqueness in the shared component).
    test.execute_expect_failure(
        Transaction::builder_localnet()
            .call_method(ons, "register", args!["okz"])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );

    // ...and a DIFFERENT caller can't grab it either.
    let (_acct_b, proof_b, secret_b) = test.create_funded_account();
    test.execute_expect_failure(
        Transaction::builder_localnet()
            .call_method(ons, "register", args!["okz"])
            .build_and_seal(&secret_b),
        vec![proof_b],
    );
}

#[test]
fn owner_can_set_record_and_read_it_back() {
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);
    register_ok(&mut test, ons, "okz");

    set_record_ok(&mut test, ons, "okz", "nostr", "npub1exampleabc");
    set_record_ok(&mut test, ons, "okz", "tari", "otl_esm_example123");

    let nostr: Option<String> = test.call_method(ons, "get_record", args!["okz", "nostr"], vec![test.owner_proof()]);
    assert_eq!(nostr, Some("npub1exampleabc".to_string()));

    let tari: Option<String> = test.call_method(ons, "get_record", args!["okz", "tari"], vec![test.owner_proof()]);
    assert_eq!(tari, Some("otl_esm_example123".to_string()));

    // Overwriting an existing key is allowed for the owner.
    set_record_ok(&mut test, ons, "okz", "nostr", "npub1updated");
    let nostr2: Option<String> = test.call_method(ons, "get_record", args!["okz", "nostr"], vec![test.owner_proof()]);
    assert_eq!(nostr2, Some("npub1updated".to_string()));

    // Absent key → None.
    let missing: Option<String> = test.call_method(ons, "get_record", args!["okz", "nope"], vec![test.owner_proof()]);
    assert_eq!(missing, None);
}

#[test]
fn non_owner_cannot_set_record() {
    // THE core security property: only the registrant (caller) can modify their name.
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);

    // Account A (the default account) registers "okz".
    register_ok(&mut test, ons, "okz");

    // Account B — a different signer — tries to point "okz" at B's own keys. Must be rejected.
    let (_acct_b, proof_b, secret_b) = test.create_funded_account();
    test.execute_expect_failure(
        Transaction::builder_localnet()
            .call_method(ons, "set_record", args!["okz", "nostr", "npub1_attacker"])
            .build_and_seal(&secret_b),
        vec![proof_b],
    );

    // The record is unchanged (still empty) — B's write never landed.
    let val: Option<String> = test.call_method(ons, "get_record", args!["okz", "nostr"], vec![test.owner_proof()]);
    assert_eq!(val, None, "non-owner write must not have modified the record");
}

#[test]
fn caller_is_owner_binding_is_unforgeable() {
    // Demonstrate the binding both ways in one test: the owner CAN write, a non-owner CANNOT,
    // and each account independently owns only the names it registered.
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);

    // A registers "alice"; B registers "bob".
    register_ok(&mut test, ons, "alice"); // caller = default account A
    let (_acct_b, proof_b, secret_b) = test.create_funded_account();
    test.execute_expect_success(
        Transaction::builder_localnet()
            .call_method(ons, "register", args!["bob"])
            .build_and_seal(&secret_b),
        vec![proof_b.clone()],
    );

    // A can write to "alice"; B cannot write to "alice".
    set_record_ok(&mut test, ons, "alice", "nostr", "npub1_alice");
    test.execute_expect_failure(
        Transaction::builder_localnet()
            .call_method(ons, "set_record", args!["alice", "nostr", "npub1_hijack"])
            .build_and_seal(&secret_b),
        vec![proof_b.clone()],
    );

    // B can write to "bob"; A cannot write to "bob".
    test.execute_expect_success(
        Transaction::builder_localnet()
            .call_method(ons, "set_record", args!["bob", "nostr", "npub1_bob"])
            .build_and_seal(&secret_b),
        vec![proof_b],
    );
    test.execute_expect_failure(
        Transaction::builder_localnet()
            .call_method(ons, "set_record", args!["bob", "nostr", "npub1_hijack"])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );

    let alice_nostr: Option<String> = test.call_method(ons, "get_record", args!["alice", "nostr"], vec![test.owner_proof()]);
    assert_eq!(alice_nostr, Some("npub1_alice".to_string()));
    let bob_nostr: Option<String> = test.call_method(ons, "get_record", args!["bob", "nostr"], vec![test.owner_proof()]);
    assert_eq!(bob_nostr, Some("npub1_bob".to_string()));
}

#[test]
fn lookup_returns_full_record() {
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);

    // Unregistered → None.
    let none: Option<(RistrettoPublicKeyBytes, BTreeMap<String, String>)> =
        test.call_method(ons, "lookup", args!["ghost"], vec![test.owner_proof()]);
    assert!(none.is_none(), "lookup of an unregistered name is None");

    register_ok(&mut test, ons, "okz");
    set_record_ok(&mut test, ons, "okz", "nostr", "npub1abc");
    set_record_ok(&mut test, ons, "okz", "tari", "otl_esm_xyz");

    let rec: Option<(RistrettoPublicKeyBytes, BTreeMap<String, String>)> =
        test.call_method(ons, "lookup", args!["okz"], vec![test.owner_proof()]);
    let (_owner, records) = rec.expect("registered name should return Some");
    assert_eq!(records.get("nostr"), Some(&"npub1abc".to_string()));
    assert_eq!(records.get("tari"), Some(&"otl_esm_xyz".to_string()));
    assert_eq!(records.len(), 2);
}

#[test]
fn invalid_names_are_rejected() {
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);

    let bad_names: Vec<String> = vec![
        String::new(),          // empty
        "a".repeat(33),         // too long (> 32)
        "Okz".to_string(),      // uppercase not allowed
        "ok.z".to_string(),     // '.' not allowed
        "ok z".to_string(),     // space not allowed
        "café".to_string(),     // non-ASCII not allowed
    ];

    for bad in bad_names {
        test.execute_expect_failure(
            Transaction::builder_localnet()
                .call_method(ons, "register", args![bad])
                .build_and_seal(test.secret_key()),
            vec![test.owner_proof()],
        );
    }

    // A valid boundary case (exactly 32 chars, allowed charset) must SUCCEED.
    let ok32 = "a".repeat(32);
    test.execute_expect_success(
        Transaction::builder_localnet()
            .call_method(ons, "register", args![ok32.clone()])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
    let registered: bool = test.call_method(ons, "is_registered", args![ok32], vec![test.owner_proof()]);
    assert!(registered, "a 32-char lowercase-alnum name should be valid");
}

#[test]
fn set_record_on_unregistered_name_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);
    test.execute_expect_failure(
        Transaction::builder_localnet()
            .call_method(ons, "set_record", args!["ghost", "nostr", "npub1"])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
}

#[test]
fn oversized_record_value_is_rejected() {
    // Guardrail: value length is capped (MAX_VALUE_LEN = 512).
    let mut test = TemplateTest::my_crate();
    let ons = deploy(&mut test);
    register_ok(&mut test, ons, "okz");

    let too_long = "x".repeat(513);
    test.execute_expect_failure(
        Transaction::builder_localnet()
            .call_method(ons, "set_record", args!["okz", "big", too_long])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );

    // Exactly 512 is allowed.
    let ok = "x".repeat(512);
    set_record_ok(&mut test, ons, "okz", "big", &ok);
    let got: Option<String> = test.call_method(ons, "get_record", args!["okz", "big"], vec![test.owner_proof()]);
    assert_eq!(got, Some(ok));
}
