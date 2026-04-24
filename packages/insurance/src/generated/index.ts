// Codama-style TS client surface for `@pact-network/insurance`.
//
// Bootstrapped in WP-5 (first Pinocchio handler). Extends per-instruction in
// successive WPs. Re-generate with:
//   pnpm --filter @pact-network/insurance codama:generate

export * from './programs/pactInsurance.js';
export * from './instructions/initializeProtocol.js';
export * from './instructions/updateConfig.js';
export * from './instructions/updateOracle.js';
export * from './instructions/createPool.js';
export * from './instructions/deposit.js';
export * from './instructions/withdraw.js';
export * from './instructions/updateRates.js';
export * from './instructions/enableInsurance.js';
export * from './instructions/disablePolicy.js';
export * from './instructions/settlePremium.js';
export * from './instructions/submitClaim.js';
export * from './accounts/protocolConfig.js';
export * from './accounts/coveragePool.js';
export * from './accounts/underwriterPosition.js';
export * from './accounts/policy.js';
export * from './accounts/claim.js';
export * from './types/initializeProtocolArgs.js';
export * from './types/updateConfigArgs.js';
export * from './types/createPoolArgs.js';
export * from './types/enableInsuranceArgs.js';
