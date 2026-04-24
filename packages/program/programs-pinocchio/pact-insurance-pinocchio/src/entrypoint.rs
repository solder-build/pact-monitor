use pinocchio::{account::AccountView, address::Address, error::ProgramError, ProgramResult};

use crate::{discriminator::Discriminator, instructions};

pub fn process_instruction(
    _program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (disc_byte, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    let disc = Discriminator::try_from(*disc_byte)?;

    match disc {
        Discriminator::InitializeProtocol => instructions::initialize_protocol::process(accounts, rest),
        Discriminator::UpdateConfig => instructions::update_config::process(accounts, rest),
        Discriminator::UpdateOracle => instructions::update_oracle::process(accounts, rest),
        Discriminator::CreatePool => instructions::create_pool::process(accounts, rest),
        Discriminator::Deposit => instructions::deposit::process(accounts, rest),
        Discriminator::Withdraw => instructions::withdraw::process(accounts, rest),
        Discriminator::UpdateRates => instructions::update_rates::process(accounts, rest),
        Discriminator::EnableInsurance
        | Discriminator::DisablePolicy
        | Discriminator::SettlePremium
        | Discriminator::SubmitClaim => Err(ProgramError::Custom(u32::MAX)),
    }
}
