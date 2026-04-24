// GENERATED — bootstrap surface for WP-5.
//
// This directory (`src/generated/`) is the Codama-TS client surface. WP-5
// hand-authors the first instruction builder because the Shank CLI is not
// installed locally and the Codama pipeline needs a full IDL; successive WPs
// (WP-6..WP-15) extend this surface per-instruction. The shape (`programs/`,
// `instructions/`, `accounts/`, `types/`) matches what `@codama/renderers-js`
// emits, so moving to a fully-regenerated client later is a drop-in swap.
//
// Regeneration command (documented now so the pipeline is reproducible as
// soon as the IDL grows complete):
//   pnpm --filter @pact-network/insurance codama:generate

import { address, type Address } from '@solana/kit';

export const PACT_INSURANCE_PROGRAM_ADDRESS: Address =
  address('7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU');

export const PACT_INSURANCE_LEGACY_ANCHOR_PROGRAM_ADDRESS: Address =
  address('2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3');

export const SYSTEM_PROGRAM_ADDRESS: Address = address(
  '11111111111111111111111111111111',
);
