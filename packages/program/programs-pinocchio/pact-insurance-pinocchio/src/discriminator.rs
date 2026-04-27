use pinocchio::error::ProgramError;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Discriminator {
    InitializeProtocol = 0,
    UpdateConfig = 1,
    UpdateOracle = 2,
    CreatePool = 3,
    Deposit = 4,
    EnableInsurance = 5,
    DisablePolicy = 6,
    SettlePremium = 7,
    Withdraw = 8,
    UpdateRates = 9,
    SubmitClaim = 10,
}

impl TryFrom<u8> for Discriminator {
    type Error = ProgramError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::InitializeProtocol),
            1 => Ok(Self::UpdateConfig),
            2 => Ok(Self::UpdateOracle),
            3 => Ok(Self::CreatePool),
            4 => Ok(Self::Deposit),
            5 => Ok(Self::EnableInsurance),
            6 => Ok(Self::DisablePolicy),
            7 => Ok(Self::SettlePremium),
            8 => Ok(Self::Withdraw),
            9 => Ok(Self::UpdateRates),
            10 => Ok(Self::SubmitClaim),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
