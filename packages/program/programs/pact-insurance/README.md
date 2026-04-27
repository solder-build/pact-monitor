# LEGACY — Anchor crate (pact-insurance)

This Anchor crate is retained as a rollback fallback for the Pinocchio port
completed in WP-17 (2026-04-24). Default builds and deploys target the
Pinocchio crate at ../../programs-pinocchio/pact-insurance-pinocchio/.

To fall back to this legacy crate:
    anchor build
    solana program deploy target/deploy/pact_insurance.so

Do NOT modify source files in this directory without captain approval.
The Pinocchio crate is the sole go-forward implementation.
