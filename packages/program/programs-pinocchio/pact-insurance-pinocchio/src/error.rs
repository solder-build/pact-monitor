use pinocchio::error::ProgramError;

pub const PACT_ERROR_BASE: u32 = 6000;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PactError {
    ProtocolPaused = 0,
    PoolAlreadyExists = 1,
    PolicyAlreadyExists = 2,
    DelegationMissing = 3,
    DelegationInsufficient = 4,
    TokenAccountMismatch = 5,
    PolicyInactive = 6,
    InsufficientPoolBalance = 7,
    InsufficientPrepaidBalance = 8,
    WithdrawalUnderCooldown = 9,
    WithdrawalWouldUnderfund = 10,
    AggregateCapExceeded = 11,
    ClaimWindowExpired = 12,
    DuplicateClaim = 13,
    InvalidRate = 14,
    HostnameTooLong = 15,
    AgentIdTooLong = 16,
    CallIdTooLong = 17,
    Unauthorized = 18,
    InvalidTriggerType = 19,
    ZeroAmount = 20,
    BelowMinimumDeposit = 21,
    ConfigSafetyFloorViolation = 22,
    ArithmeticOverflow = 23,
    UnauthorizedDeployer = 24,
    UnauthorizedOracle = 25,
    FrozenConfigField = 26,
    RateOutOfBounds = 27,
    RateBelowFloor = 28,
    PolicyExpired = 29,
    InvalidOracleKey = 30,
}

impl From<PactError> for ProgramError {
    fn from(e: PactError) -> Self {
        ProgramError::Custom(PACT_ERROR_BASE + e as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(e: PactError) -> u32 {
        match ProgramError::from(e) {
            ProgramError::Custom(c) => c,
            _ => panic!("PactError must map to ProgramError::Custom"),
        }
    }

    #[test]
    fn protocol_paused_is_6000() {
        assert_eq!(PactError::ProtocolPaused as u32 + PACT_ERROR_BASE, 6000);
        assert_eq!(code(PactError::ProtocolPaused), 6000);
    }

    #[test]
    fn unauthorized_is_6018() {
        assert_eq!(PactError::Unauthorized as u32 + PACT_ERROR_BASE, 6018);
        assert_eq!(code(PactError::Unauthorized), 6018);
    }

    #[test]
    fn frozen_config_field_is_6026() {
        assert_eq!(PactError::FrozenConfigField as u32 + PACT_ERROR_BASE, 6026);
        assert_eq!(code(PactError::FrozenConfigField), 6026);
    }

    #[test]
    fn rate_out_of_bounds_is_6027() {
        assert_eq!(PactError::RateOutOfBounds as u32 + PACT_ERROR_BASE, 6027);
        assert_eq!(code(PactError::RateOutOfBounds), 6027);
    }

    #[test]
    fn invalid_oracle_key_is_endpoint() {
        assert_eq!(PactError::InvalidOracleKey as u32 + PACT_ERROR_BASE, 6030);
        assert_eq!(code(PactError::InvalidOracleKey), 6030);
    }

    #[test]
    fn all_variants_are_contiguous_from_6000() {
        let mapping: &[(PactError, u32)] = &[
            (PactError::ProtocolPaused, 6000),
            (PactError::PoolAlreadyExists, 6001),
            (PactError::PolicyAlreadyExists, 6002),
            (PactError::DelegationMissing, 6003),
            (PactError::DelegationInsufficient, 6004),
            (PactError::TokenAccountMismatch, 6005),
            (PactError::PolicyInactive, 6006),
            (PactError::InsufficientPoolBalance, 6007),
            (PactError::InsufficientPrepaidBalance, 6008),
            (PactError::WithdrawalUnderCooldown, 6009),
            (PactError::WithdrawalWouldUnderfund, 6010),
            (PactError::AggregateCapExceeded, 6011),
            (PactError::ClaimWindowExpired, 6012),
            (PactError::DuplicateClaim, 6013),
            (PactError::InvalidRate, 6014),
            (PactError::HostnameTooLong, 6015),
            (PactError::AgentIdTooLong, 6016),
            (PactError::CallIdTooLong, 6017),
            (PactError::Unauthorized, 6018),
            (PactError::InvalidTriggerType, 6019),
            (PactError::ZeroAmount, 6020),
            (PactError::BelowMinimumDeposit, 6021),
            (PactError::ConfigSafetyFloorViolation, 6022),
            (PactError::ArithmeticOverflow, 6023),
            (PactError::UnauthorizedDeployer, 6024),
            (PactError::UnauthorizedOracle, 6025),
            (PactError::FrozenConfigField, 6026),
            (PactError::RateOutOfBounds, 6027),
            (PactError::RateBelowFloor, 6028),
            (PactError::PolicyExpired, 6029),
            (PactError::InvalidOracleKey, 6030),
        ];
        for (variant, expected) in mapping {
            assert_eq!(code(*variant), *expected, "variant {:?} must map to {}", variant, expected);
        }
    }
}
