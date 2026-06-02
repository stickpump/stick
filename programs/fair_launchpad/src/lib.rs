use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    keccak::hashv,
    program::invoke_signed,
    system_program,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token as legacy_token,
    token::{Token as LegacyToken, TokenAccount as LegacyTokenAccount, Transfer as LegacyTransfer},
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("3cp7EpueLdu5RM5sPGLdnE8smPdWAkco3aMwAihju7VL");

const BASIS_POINTS: u16 = 10_000;
const BASE_WEIGHT_BPS: u128 = 20_000;
const LOCK_SECONDS: i64 = 3_600;
const DAY_SECONDS: i64 = 86_400;
const MIN_RAISE_SECONDS: u32 = 60;
const MAX_RAISE_SECONDS: u32 = DAY_SECONDS as u32;
const MAX_METADATA_URI: usize = 200;
const MAX_SETTLEMENT_URI: usize = 200;
const MAX_ROUTE_INSTRUCTIONS: usize = 8;
const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_FEES_PROGRAM_ID: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

#[program]
pub mod fair_launchpad {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_presale(
        ctx: Context<CreatePresale>,
        presale_id: u64,
        input: PresaleConfigInput,
        metadata_uri: String,
        reward_preset: RewardPreset,
        vesting_preset: VestingPreset,
    ) -> Result<()> {
        require!(
            metadata_uri.len() <= MAX_METADATA_URI,
            LaunchpadError::MetadataUriTooLong
        );
        require!(
            input.duration_seconds >= MIN_RAISE_SECONDS
                && input.duration_seconds <= MAX_RAISE_SECONDS,
            LaunchpadError::InvalidDuration
        );
        require!(
            input.min_contribution > 0,
            LaunchpadError::InvalidMinContribution
        );
        require!(
            input.devbuy_required_amount > 0,
            LaunchpadError::DevbuyRequired
        );
        require!(
            input.dev_vesting_initial_unlock_bps <= BASIS_POINTS,
            LaunchpadError::InvalidVestingConfig
        );
        require!(
            input.launch_type == LaunchType::EarlyBoostBatch,
            LaunchpadError::InvalidLaunchType
        );
        require!(
            input.quote_asset == QuoteAsset::Sol,
            LaunchpadError::InvalidQuoteAsset
        );
        require!(
            input.mint == ctx.accounts.mint.key(),
            LaunchpadError::InvalidTokenMint
        );
        require!(input.hard_cap > 0, LaunchpadError::InvalidTarget);
        require!(
            input.soft_cap == input.hard_cap,
            LaunchpadError::InvalidTarget
        );
        require!(
            input.devbuy_required_amount <= input.hard_cap,
            LaunchpadError::InvalidTarget
        );
        require!(
            input.min_contribution <= input.hard_cap,
            LaunchpadError::InvalidMinContribution
        );
        require!(
            input.ticket_size == 0 && input.max_tickets_per_wallet == 0,
            LaunchpadError::InvalidLaunchConfig
        );
        create_quote_vault(
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.quote_vault.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.accounts.presale.key(),
        )?;

        let presale = &mut ctx.accounts.presale;
        presale.id = presale_id;
        presale.creator = ctx.accounts.creator.key();
        presale.config = ctx.accounts.config.key();
        presale.mint = input.mint;
        presale.quote_mint = input.quote_mint;
        presale.metadata_uri = metadata_uri;
        presale.launch_type = input.launch_type;
        presale.quote_asset = input.quote_asset;
        presale.boost_preset = input.boost_preset;
        presale.reward_preset = reward_preset;
        presale.vesting_preset = vesting_preset;
        presale.status = PresaleStatus::Draft;
        presale.duration_seconds = input.duration_seconds;
        presale.start_ts = 0;
        presale.end_ts = 0;
        presale.closed_ts = 0;
        presale.min_contribution = input.min_contribution;
        presale.devbuy_required_amount = input.devbuy_required_amount;
        presale.devbuy_amount = 0;
        presale.devbuy_weight = 0;
        presale.dev_vesting_cliff_seconds = input.dev_vesting_cliff_seconds;
        presale.dev_vesting_linear_seconds = input.dev_vesting_linear_seconds;
        presale.dev_vesting_initial_unlock_bps = input.dev_vesting_initial_unlock_bps;
        presale.soft_cap = input.soft_cap;
        presale.hard_cap = input.hard_cap;
        presale.max_wallet_contribution = input.max_wallet_contribution;
        presale.ticket_size = input.ticket_size;
        presale.max_tickets_per_wallet = input.max_tickets_per_wallet;
        presale.total_accepted = 0;
        presale.total_committed = 0;
        presale.total_weight = 0;
        presale.total_refundable = 0;
        presale.settlement_gross_accepted = 0;
        presale.settlement_root = [0; 32];
        presale.settlement_uri = String::new();
        presale.route_state = RouteState::RouteNotStarted;
        presale.pump_quote_spent = 0;
        presale.pumpswap_quote_spent = 0;
        presale.total_winning_quote = 0;
        presale.total_tokens_purchased = 0;
        presale.total_locked_tokens = 0;
        presale.finalized_quote = 0;
        presale.raffle_seed_slot = 0;
        presale.raffle_seed = [0; 32];
        presale.winning_ticket_count = 0;
        presale.creator_reward_total = 0;
        presale.creator_reward_claimed = 0;
        presale.holder_reward_total = 0;
        presale.holder_reward_claimed = 0;
        presale.bump = ctx.bumps.presale;
        Ok(())
    }

    pub fn devbuy(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.presale.quote_asset == QuoteAsset::Sol,
            LaunchpadError::InvalidQuoteAsset
        );
        let accepted = record_devbuy(
            &mut ctx.accounts.presale,
            &mut ctx.accounts.contributor_state,
            ctx.accounts.contributor.key(),
            amount,
            ctx.bumps.contributor_state,
        )?;

        transfer_lamports(
            &ctx.accounts.contributor.to_account_info(),
            &ctx.accounts.quote_vault.to_account_info(),
            accepted,
        )?;

        Ok(())
    }

    pub fn devbuy_quote_token(ctx: Context<ContributeQuoteToken>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.presale.quote_asset == QuoteAsset::Usdc,
            LaunchpadError::InvalidQuoteAsset
        );
        require!(
            ctx.accounts.contributor_quote_ata.mint == ctx.accounts.presale.quote_mint,
            LaunchpadError::InvalidQuoteMint
        );
        require!(
            ctx.accounts.quote_vault_ata.mint == ctx.accounts.presale.quote_mint,
            LaunchpadError::InvalidQuoteMint
        );
        require!(
            ctx.accounts.quote_vault_ata.owner == ctx.accounts.presale.key(),
            LaunchpadError::InvalidVaultOwner
        );
        let accepted = record_devbuy(
            &mut ctx.accounts.presale,
            &mut ctx.accounts.contributor_state,
            ctx.accounts.contributor.key(),
            amount,
            ctx.bumps.contributor_state,
        )?;

        legacy_token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                LegacyTransfer {
                    from: ctx.accounts.contributor_quote_ata.to_account_info(),
                    to: ctx.accounts.quote_vault_ata.to_account_info(),
                    authority: ctx.accounts.contributor.to_account_info(),
                },
            ),
            accepted,
        )?;
        Ok(())
    }

    pub fn open_presale(ctx: Context<OpenPresale>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let presale = &mut ctx.accounts.presale;
        require!(
            ctx.accounts.creator.key() == presale.creator,
            LaunchpadError::Unauthorized
        );
        require!(
            presale.status == PresaleStatus::Draft,
            LaunchpadError::InvalidStatus
        );
        require!(
            presale.devbuy_amount >= presale.devbuy_required_amount,
            LaunchpadError::DevbuyRequired
        );
        presale.status = PresaleStatus::Open;
        presale.start_ts = now;
        presale.end_ts = now
            .checked_add(presale.duration_seconds as i64)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }

    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.presale.quote_asset == QuoteAsset::Sol,
            LaunchpadError::InvalidQuoteAsset
        );
        let accepted = record_contribution(
            &mut ctx.accounts.presale,
            &mut ctx.accounts.contributor_state,
            ctx.accounts.contributor.key(),
            amount,
            ctx.bumps.contributor_state,
        )?;

        transfer_lamports(
            &ctx.accounts.contributor.to_account_info(),
            &ctx.accounts.quote_vault.to_account_info(),
            accepted,
        )?;

        Ok(())
    }

    pub fn contribute_quote_token(ctx: Context<ContributeQuoteToken>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.presale.quote_asset == QuoteAsset::Usdc,
            LaunchpadError::InvalidQuoteAsset
        );
        require!(
            ctx.accounts.contributor_quote_ata.mint == ctx.accounts.presale.quote_mint,
            LaunchpadError::InvalidQuoteMint
        );
        require!(
            ctx.accounts.quote_vault_ata.mint == ctx.accounts.presale.quote_mint,
            LaunchpadError::InvalidQuoteMint
        );
        require!(
            ctx.accounts.quote_vault_ata.owner == ctx.accounts.presale.key(),
            LaunchpadError::InvalidVaultOwner
        );

        let accepted = record_contribution(
            &mut ctx.accounts.presale,
            &mut ctx.accounts.contributor_state,
            ctx.accounts.contributor.key(),
            amount,
            ctx.bumps.contributor_state,
        )?;

        legacy_token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                LegacyTransfer {
                    from: ctx.accounts.contributor_quote_ata.to_account_info(),
                    to: ctx.accounts.quote_vault_ata.to_account_info(),
                    authority: ctx.accounts.contributor.to_account_info(),
                },
            ),
            accepted,
        )?;
        Ok(())
    }

    pub fn close_presale(ctx: Context<ClosePresale>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let presale = &mut ctx.accounts.presale;
        require!(
            presale.status == PresaleStatus::Open,
            LaunchpadError::PresaleNotOpen
        );
        require!(
            now >= presale.end_ts,
            LaunchpadError::PresaleStillOpen
        );

        presale.closed_ts = now;
        if presale.soft_cap > 0 && presale.total_committed < presale.soft_cap {
            presale.status = PresaleStatus::RefundOnly;
            presale.total_refundable = presale.total_committed;
        } else if presale.launch_type == LaunchType::RaffleAllocation {
            presale.status = PresaleStatus::Closed;
            presale.raffle_seed_slot = Clock::get()?.slot.saturating_add(1);
        } else {
            presale.status = PresaleStatus::Closed;
        }
        Ok(())
    }

    pub fn set_settlement(
        ctx: Context<SetSettlement>,
        gross_accepted_total: u64,
        settlement_root: [u8; 32],
        settlement_uri: String,
    ) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        require!(
            ctx.accounts.config.key() == presale.config,
            LaunchpadError::Unauthorized
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority,
            LaunchpadError::Unauthorized
        );
        require!(
            matches!(
                presale.status,
                PresaleStatus::Closed | PresaleStatus::Finalizing | PresaleStatus::Finalized
            ),
            LaunchpadError::InvalidStatus
        );
        require!(
            settlement_uri.len() <= MAX_SETTLEMENT_URI,
            LaunchpadError::SettlementUriTooLong
        );
        require!(
            settlement_root != [0; 32],
            LaunchpadError::InvalidSettlementRoot
        );
        require!(
            gross_accepted_total > 0 && gross_accepted_total <= presale.hard_cap,
            LaunchpadError::InvalidSettlement
        );
        if presale.finalized_quote > 0 {
            require!(
                gross_accepted_total <= presale.finalized_quote,
                LaunchpadError::InvalidSettlement
            );
        }

        presale.settlement_root = settlement_root;
        presale.settlement_uri = settlement_uri;
        presale.settlement_gross_accepted = gross_accepted_total;
        presale.total_refundable = presale
            .total_committed
            .checked_sub(gross_accepted_total)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }

    pub fn settle_raffle(
        ctx: Context<SettleRaffle>,
        seed: [u8; 32],
        winning_ticket_count: u64,
    ) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        require!(
            presale.launch_type == LaunchType::RaffleAllocation,
            LaunchpadError::NotRaffle
        );
        require!(
            presale.status == PresaleStatus::Closed,
            LaunchpadError::InvalidStatus
        );
        require!(
            winning_ticket_count > 0,
            LaunchpadError::InvalidWinningTicketCount
        );

        presale.raffle_seed = seed;
        presale.winning_ticket_count = winning_ticket_count;
        presale.total_winning_quote = winning_ticket_count
            .checked_mul(presale.ticket_size)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(
            presale.total_winning_quote <= presale.total_accepted,
            LaunchpadError::InvalidWinningTicketCount
        );
        presale.total_refundable = presale
            .total_accepted
            .checked_sub(presale.total_winning_quote)
            .ok_or(LaunchpadError::MathOverflow)?;
        presale.status = PresaleStatus::RaffleSettled;
        Ok(())
    }

    pub fn mark_raffle_contributor(
        ctx: Context<MarkRaffleContributor>,
        winning_tickets: u64,
    ) -> Result<()> {
        let presale = &ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.status == PresaleStatus::RaffleSettled,
            LaunchpadError::InvalidStatus
        );
        require!(
            winning_tickets <= contributor.tickets,
            LaunchpadError::InvalidWinningTicketCount
        );

        contributor.winning_tickets = winning_tickets;
        let winning_quote = winning_tickets
            .checked_mul(presale.ticket_size)
            .ok_or(LaunchpadError::MathOverflow)?;
        contributor.refundable_amount = contributor
            .accepted_amount
            .checked_sub(winning_quote)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }

    pub fn finalize_pump_create_buy<'info>(
        mut ctx: Context<'_, '_, '_, 'info, FinalizePumpRoute<'info>>,
        max_quote_spend: u64,
        min_tokens_out: u64,
        route_instructions: Vec<RouteInstructionInput>,
        complete: bool,
    ) -> Result<()> {
        require!(
            ctx.accounts.presale.route_state == RouteState::RouteNotStarted,
            LaunchpadError::InvalidRouteState
        );
        execute_route_step(
            &mut ctx.accounts,
            ctx.remaining_accounts,
            max_quote_spend,
            min_tokens_out,
            &route_instructions,
            RouteProgram::Pump,
        )?;

        let presale = &mut ctx.accounts.presale;
        if complete {
            require!(
                presale.finalized_quote <= spendable_route_quote(presale)?,
                LaunchpadError::IncompleteFinalize
            );
        }
        presale.route_state = if complete {
            RouteState::Finalized
        } else {
            RouteState::PumpBought
        };
        if complete {
            presale.status = PresaleStatus::Finalized;
        }
        Ok(())
    }

    pub fn finalize_migrate<'info>(
        ctx: Context<'_, '_, '_, 'info, FinalizePumpRoute<'info>>,
        route_instructions: Vec<RouteInstructionInput>,
    ) -> Result<()> {
        require!(
            ctx.accounts.presale.route_state == RouteState::PumpBought,
            LaunchpadError::InvalidRouteState
        );
        execute_route_cpis(
            &ctx.accounts.presale,
            &ctx.accounts.quote_vault,
            &ctx.accounts.mint,
            ctx.remaining_accounts,
            &route_instructions,
            RouteProgram::Pump,
        )?;
        ctx.accounts.presale.route_state = RouteState::Migrated;
        Ok(())
    }

    pub fn finalize_pumpswap_buy<'info>(
        mut ctx: Context<'_, '_, '_, 'info, FinalizePumpRoute<'info>>,
        max_quote_spend: u64,
        min_tokens_out: u64,
        route_instructions: Vec<RouteInstructionInput>,
    ) -> Result<()> {
        require!(
            ctx.accounts.presale.route_state == RouteState::Migrated,
            LaunchpadError::InvalidRouteState
        );
        execute_route_step(
            &mut ctx.accounts,
            ctx.remaining_accounts,
            max_quote_spend,
            min_tokens_out,
            &route_instructions,
            RouteProgram::PumpSwap,
        )?;
        require!(
            ctx.accounts.presale.finalized_quote <= spendable_route_quote(&ctx.accounts.presale)?,
            LaunchpadError::IncompleteFinalize
        );
        ctx.accounts.presale.route_state = RouteState::Finalized;
        ctx.accounts.presale.status = PresaleStatus::Finalized;
        Ok(())
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.quote_asset == QuoteAsset::Sol,
            LaunchpadError::InvalidQuoteAsset
        );
        require!(
            matches!(
                presale.status,
                PresaleStatus::RefundOnly | PresaleStatus::RaffleSettled | PresaleStatus::Finalized
            ),
            LaunchpadError::RefundUnavailable
        );

        let refund = if presale.status == PresaleStatus::RefundOnly {
            contributor.accepted_amount
        } else {
            contributor.refundable_amount
        };
        require!(refund > 0, LaunchpadError::NothingToClaim);
        contributor.refundable_amount = 0;
        contributor.accepted_amount = contributor.accepted_amount.saturating_sub(refund);
        transfer_lamports_from_vault(
            presale,
            &ctx.accounts.quote_vault.to_account_info(),
            &ctx.accounts.contributor.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            refund,
        )?;
        Ok(())
    }

    pub fn send_refund_to_owner(ctx: Context<SendRefundToOwner>) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.quote_asset == QuoteAsset::Sol,
            LaunchpadError::InvalidQuoteAsset
        );
        require!(
            ctx.accounts.owner.key() == contributor.owner,
            LaunchpadError::Unauthorized
        );
        require!(
            presale.status == PresaleStatus::RefundOnly,
            LaunchpadError::RefundUnavailable
        );

        let refund = contributor.accepted_amount;
        require!(refund > 0, LaunchpadError::NothingToClaim);
        contributor.refundable_amount = 0;
        contributor.accepted_amount = 0;
        transfer_lamports_from_vault(
            presale,
            &ctx.accounts.quote_vault.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            refund,
        )?;
        Ok(())
    }

    pub fn claim_refund_quote_token(ctx: Context<ClaimRefundQuoteToken>) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.quote_asset == QuoteAsset::Usdc,
            LaunchpadError::InvalidQuoteAsset
        );
        require!(
            matches!(
                presale.status,
                PresaleStatus::RefundOnly | PresaleStatus::RaffleSettled | PresaleStatus::Finalized
            ),
            LaunchpadError::RefundUnavailable
        );
        require!(
            ctx.accounts.quote_vault_ata.owner == presale.key(),
            LaunchpadError::InvalidVaultOwner
        );
        require!(
            ctx.accounts.quote_vault_ata.mint == presale.quote_mint,
            LaunchpadError::InvalidQuoteMint
        );
        require!(
            ctx.accounts.contributor_quote_ata.mint == presale.quote_mint,
            LaunchpadError::InvalidQuoteMint
        );

        let refund = if presale.status == PresaleStatus::RefundOnly {
            contributor.accepted_amount
        } else {
            contributor.refundable_amount
        };
        require!(refund > 0, LaunchpadError::NothingToClaim);
        contributor.refundable_amount = 0;
        contributor.accepted_amount = contributor.accepted_amount.saturating_sub(refund);

        let id = presale.id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"presale", presale.creator.as_ref(), &id, &[presale.bump]]];

        legacy_token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                LegacyTransfer {
                    from: ctx.accounts.quote_vault_ata.to_account_info(),
                    to: ctx.accounts.contributor_quote_ata.to_account_info(),
                    authority: presale.to_account_info(),
                },
                signer_seeds,
            ),
            refund,
        )?;
        Ok(())
    }

    pub fn claim_tokens_now(ctx: Context<ClaimTokensNow>) -> Result<()> {
        let presale = &ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.status == PresaleStatus::Finalized,
            LaunchpadError::InvalidStatus
        );
        require!(
            ctx.accounts.allocation_vault_ata.owner == presale.key(),
            LaunchpadError::InvalidVaultOwner
        );
        require!(
            ctx.accounts.allocation_vault_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            ctx.accounts.recipient_token_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            ctx.accounts.recipient_token_ata.owner == ctx.accounts.owner.key(),
            LaunchpadError::InvalidVaultOwner
        );

        let allocation = calculate_allocation(presale, contributor)?;
        let vested_cap = if contributor.is_devbuy {
            devbuy_vested_token_amount(presale, allocation)?
        } else {
            allocation
        };
        let claimable = vested_cap
            .saturating_sub(contributor.token_claimed)
            .saturating_sub(contributor.locked_tokens);
        require!(claimable > 0, LaunchpadError::NothingToClaim);
        contributor.token_claimed = contributor
            .token_claimed
            .checked_add(claimable)
            .ok_or(LaunchpadError::MathOverflow)?;
        contributor.forfeited_holder_rewards = true;
        transfer_tokens_from_presale(
            presale,
            &ctx.accounts.mint,
            &ctx.accounts.allocation_vault_ata,
            &ctx.accounts.recipient_token_ata,
            &ctx.accounts.token_program,
            claimable,
        )?;
        Ok(())
    }

    pub fn claim_all(
        ctx: Context<ClaimAll>,
        proof: Vec<[u8; 32]>,
        gross_accepted: u64,
        refund: u64,
    ) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.status == PresaleStatus::Finalized,
            LaunchpadError::InvalidStatus
        );
        require!(
            presale.launch_type == LaunchType::EarlyBoostBatch,
            LaunchpadError::InvalidLaunchType
        );
        require!(
            presale.settlement_root != [0; 32],
            LaunchpadError::InvalidSettlementRoot
        );
        require!(
            !contributor.settlement_claimed,
            LaunchpadError::AlreadyClaimed
        );
        require!(
            ctx.accounts.recipient_token_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            ctx.accounts.recipient_token_ata.owner == ctx.accounts.owner.key(),
            LaunchpadError::InvalidVaultOwner
        );
        require!(
            ctx.accounts.allocation_vault_ata.owner == presale.key(),
            LaunchpadError::InvalidVaultOwner
        );
        require!(
            ctx.accounts.allocation_vault_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            gross_accepted
                .checked_add(refund)
                .ok_or(LaunchpadError::MathOverflow)?
                == contributor.accepted_amount,
            LaunchpadError::InvalidSettlement
        );

        let leaf = settlement_leaf(
            &presale.key(),
            &contributor.owner,
            contributor.accepted_amount,
            contributor.contribution_weight,
            gross_accepted,
            refund,
        );
        require!(
            verify_merkle_proof(leaf, &proof, presale.settlement_root),
            LaunchpadError::InvalidMerkleProof
        );

        contributor.settlement_claimed = true;
        contributor.refundable_amount = 0;
        contributor.settled_gross_accepted = gross_accepted;

        if refund > 0 {
            transfer_lamports_from_vault(
                presale,
                &ctx.accounts.quote_vault.to_account_info(),
                &ctx.accounts.owner.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                refund,
            )?;
        }

        let allocation = calculate_allocation(presale, contributor)?;
        let vested_cap = if contributor.is_devbuy {
            devbuy_vested_token_amount(presale, allocation)?
        } else {
            allocation
        };
        let claimable = vested_cap
            .saturating_sub(contributor.token_claimed)
            .saturating_sub(contributor.locked_tokens);
        require!(refund > 0 || claimable > 0, LaunchpadError::NothingToClaim);

        if claimable > 0 {
            contributor.token_claimed = contributor
                .token_claimed
                .checked_add(claimable)
                .ok_or(LaunchpadError::MathOverflow)?;
            contributor.forfeited_holder_rewards = true;
            transfer_tokens_from_presale(
                presale,
                &ctx.accounts.mint,
                &ctx.accounts.allocation_vault_ata,
                &ctx.accounts.recipient_token_ata,
                &ctx.accounts.token_program,
                claimable,
            )?;
        }
        Ok(())
    }

    pub fn send_tokens_to_owner_now(ctx: Context<SendTokensToOwnerNow>) -> Result<()> {
        let presale = &ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.status == PresaleStatus::Finalized,
            LaunchpadError::InvalidStatus
        );
        require!(
            ctx.accounts.owner.key() == contributor.owner,
            LaunchpadError::Unauthorized
        );
        require!(
            ctx.accounts.allocation_vault_ata.owner == presale.key(),
            LaunchpadError::InvalidVaultOwner
        );
        require!(
            ctx.accounts.allocation_vault_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            ctx.accounts.recipient_token_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            ctx.accounts.recipient_token_ata.owner == contributor.owner,
            LaunchpadError::InvalidVaultOwner
        );

        let allocation = calculate_allocation(presale, contributor)?;
        let vested_cap = if contributor.is_devbuy {
            devbuy_vested_token_amount(presale, allocation)?
        } else {
            allocation
        };
        let claimable = vested_cap
            .saturating_sub(contributor.token_claimed)
            .saturating_sub(contributor.locked_tokens);
        require!(claimable > 0, LaunchpadError::NothingToClaim);
        contributor.token_claimed = contributor
            .token_claimed
            .checked_add(claimable)
            .ok_or(LaunchpadError::MathOverflow)?;
        contributor.forfeited_holder_rewards = true;
        transfer_tokens_from_presale(
            presale,
            &ctx.accounts.mint,
            &ctx.accounts.allocation_vault_ata,
            &ctx.accounts.recipient_token_ata,
            &ctx.accounts.token_program,
            claimable,
        )?;
        Ok(())
    }

    pub fn lock_allocation_for_rewards(ctx: Context<LockAllocationForRewards>) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            presale.status == PresaleStatus::Finalized,
            LaunchpadError::InvalidStatus
        );
        require!(
            !contributor.forfeited_holder_rewards,
            LaunchpadError::HolderRewardsForfeited
        );
        require!(
            contributor.locked_tokens == 0,
            LaunchpadError::AlreadyLocked
        );

        let allocation = calculate_allocation(presale, contributor)?;
        require!(allocation > 0, LaunchpadError::NothingToClaim);
        contributor.locked_tokens = allocation;
        contributor.lock_started_ts = Clock::get()?.unix_timestamp;
        presale.total_locked_tokens = presale
            .total_locked_tokens
            .checked_add(allocation)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }

    pub fn claim_locked_tokens(ctx: Context<ClaimLockedTokens>) -> Result<()> {
        let presale = &ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            contributor.locked_tokens > 0,
            LaunchpadError::NothingToClaim
        );
        require!(
            Clock::get()?.unix_timestamp >= contributor.lock_started_ts + LOCK_SECONDS,
            LaunchpadError::LockStillActive
        );
        require!(
            ctx.accounts.allocation_vault_ata.owner == presale.key(),
            LaunchpadError::InvalidVaultOwner
        );
        require!(
            ctx.accounts.allocation_vault_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            ctx.accounts.recipient_token_ata.mint == presale.mint,
            LaunchpadError::InvalidTokenMint
        );
        require!(
            ctx.accounts.recipient_token_ata.owner == ctx.accounts.owner.key(),
            LaunchpadError::InvalidVaultOwner
        );
        let claimable = contributor.locked_tokens;
        contributor.token_claimed = contributor
            .token_claimed
            .checked_add(claimable)
            .ok_or(LaunchpadError::MathOverflow)?;
        contributor.locked_tokens = 0;
        transfer_tokens_from_presale(
            presale,
            &ctx.accounts.mint,
            &ctx.accounts.allocation_vault_ata,
            &ctx.accounts.recipient_token_ata,
            &ctx.accounts.token_program,
            claimable,
        )?;
        Ok(())
    }

    pub fn claim_creator_vested_rewards(ctx: Context<ClaimCreatorVestedRewards>) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        require!(
            ctx.accounts.creator.key() == presale.creator,
            LaunchpadError::Unauthorized
        );
        require!(
            presale.creator_reward_total > presale.creator_reward_claimed,
            LaunchpadError::NothingToClaim
        );

        let vested = vested_amount(presale)?;
        let claimable = vested.saturating_sub(presale.creator_reward_claimed);
        require!(claimable > 0, LaunchpadError::NothingToClaim);
        presale.creator_reward_claimed = presale
            .creator_reward_claimed
            .checked_add(claimable)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }

    pub fn claim_holder_rewards(ctx: Context<ClaimHolderRewards>) -> Result<()> {
        let presale = &mut ctx.accounts.presale;
        let contributor = &mut ctx.accounts.contributor_state;
        require!(
            contributor.locked_tokens == 0,
            LaunchpadError::LockStillActive
        );
        require!(
            contributor.lock_started_ts > 0,
            LaunchpadError::HolderRewardsForfeited
        );
        require!(
            presale.total_locked_tokens > 0,
            LaunchpadError::NothingToClaim
        );

        let total_entitlement = (presale.holder_reward_total as u128)
            .checked_mul(calculate_allocation(presale, contributor)? as u128)
            .ok_or(LaunchpadError::MathOverflow)?
            .checked_div(presale.total_locked_tokens as u128)
            .ok_or(LaunchpadError::MathOverflow)? as u64;
        let claimable = total_entitlement.saturating_sub(contributor.holder_rewards_claimed);
        require!(claimable > 0, LaunchpadError::NothingToClaim);
        contributor.holder_rewards_claimed = contributor
            .holder_rewards_claimed
            .checked_add(claimable)
            .ok_or(LaunchpadError::MathOverflow)?;
        presale.holder_reward_claimed = presale
            .holder_reward_claimed
            .checked_add(claimable)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(presale_id: u64)]
pub struct CreatePresale<'info> {
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = creator,
        space = 8 + Presale::INIT_SPACE,
        seeds = [b"presale", creator.key().as_ref(), &presale_id.to_le_bytes()],
        bump
    )]
    pub presale: Account<'info, Presale>,
    /// CHECK: created as a zero-data system PDA in create_presale.
    #[account(
        mut,
        seeds = [b"quote_vault", presale.key().as_ref()],
        bump
    )]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: Pump create_v2 initializes this Token-2022 mint. The PDA is checked against input.mint.
    #[account(
        mut,
        seeds = [b"mint", presale.key().as_ref()],
        bump
    )]
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(
        mut,
        seeds = [b"quote_vault", presale.key().as_ref()],
        bump
    )]
    pub quote_vault: SystemAccount<'info>,
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + ContributorState::INIT_SPACE,
        seeds = [b"contributor", presale.key().as_ref(), contributor.key().as_ref()],
        bump
    )]
    pub contributor_state: Account<'info, ContributorState>,
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ContributeQuoteToken<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + ContributorState::INIT_SPACE,
        seeds = [b"contributor", presale.key().as_ref(), contributor.key().as_ref()],
        bump
    )]
    pub contributor_state: Account<'info, ContributorState>,
    #[account(mut)]
    pub contributor: Signer<'info>,
    #[account(mut, token::authority = contributor)]
    pub contributor_quote_ata: Account<'info, LegacyTokenAccount>,
    #[account(mut)]
    pub quote_vault_ata: Account<'info, LegacyTokenAccount>,
    pub token_program: Program<'info, LegacyToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePresale<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
}

#[derive(Accounts)]
pub struct OpenPresale<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleRaffle<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
}

#[derive(Accounts)]
pub struct SetSettlement<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    pub config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct MarkRaffleContributor<'info> {
    pub presale: Account<'info, Presale>,
    #[account(mut, has_one = presale)]
    pub contributor_state: Account<'info, ContributorState>,
}

#[derive(Accounts)]
pub struct FinalizePumpRoute<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"quote_vault", presale.key().as_ref()],
        bump
    )]
    pub quote_vault: SystemAccount<'info>,
    /// CHECK: Created during Pump route CPI. Token account ownership/mint are checked after route execution.
    #[account(mut)]
    pub allocation_vault_ata: UncheckedAccount<'info>,
    /// CHECK: Pump create_v2 initializes this PDA mint during the first route CPI. Address checked in validation.
    #[account(mut, address = presale.mint)]
    pub mint: UncheckedAccount<'info>,
    pub finalizer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(
        mut,
        seeds = [b"quote_vault", presale.key().as_ref()],
        bump
    )]
    pub quote_vault: SystemAccount<'info>,
    #[account(mut, has_one = presale, has_one = owner)]
    pub contributor_state: Account<'info, ContributorState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: contributor receives lamports; checked by contributor_state.owner.
    #[account(mut, address = owner.key())]
    pub contributor: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendRefundToOwner<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(
        mut,
        seeds = [b"quote_vault", presale.key().as_ref()],
        bump
    )]
    pub quote_vault: SystemAccount<'info>,
    #[account(mut, has_one = presale)]
    pub contributor_state: Account<'info, ContributorState>,
    /// CHECK: refund recipient is checked against contributor_state.owner.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRefundQuoteToken<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(mut, has_one = presale, has_one = owner)]
    pub contributor_state: Account<'info, ContributorState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, token::authority = owner)]
    pub contributor_quote_ata: Account<'info, LegacyTokenAccount>,
    #[account(mut)]
    pub quote_vault_ata: Account<'info, LegacyTokenAccount>,
    pub token_program: Program<'info, LegacyToken>,
}

#[derive(Accounts)]
pub struct ClaimTokensNow<'info> {
    pub presale: Account<'info, Presale>,
    #[account(mut, has_one = presale, has_one = owner)]
    pub contributor_state: Account<'info, ContributorState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub allocation_vault_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub recipient_token_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(address = presale.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimAll<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(
        mut,
        seeds = [b"quote_vault", presale.key().as_ref()],
        bump
    )]
    pub quote_vault: SystemAccount<'info>,
    #[account(mut, has_one = presale, has_one = owner)]
    pub contributor_state: Account<'info, ContributorState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub allocation_vault_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub recipient_token_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(address = presale.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendTokensToOwnerNow<'info> {
    pub presale: Account<'info, Presale>,
    #[account(mut, has_one = presale)]
    pub contributor_state: Account<'info, ContributorState>,
    /// CHECK: owner is checked against contributor_state.owner.
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub allocation_vault_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub recipient_token_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(address = presale.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct LockAllocationForRewards<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(mut, has_one = presale, has_one = owner)]
    pub contributor_state: Account<'info, ContributorState>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimLockedTokens<'info> {
    pub presale: Account<'info, Presale>,
    #[account(mut, has_one = presale, has_one = owner)]
    pub contributor_state: Account<'info, ContributorState>,
    pub owner: Signer<'info>,
    #[account(mut)]
    pub allocation_vault_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub recipient_token_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(address = presale.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimCreatorVestedRewards<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimHolderRewards<'info> {
    #[account(mut)]
    pub presale: Account<'info, Presale>,
    #[account(mut, has_one = presale, has_one = owner)]
    pub contributor_state: Account<'info, ContributorState>,
    pub owner: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Presale {
    pub id: u64,
    pub creator: Pubkey,
    pub config: Pubkey,
    pub mint: Pubkey,
    pub quote_mint: Pubkey,
    #[max_len(200)]
    pub metadata_uri: String,
    pub launch_type: LaunchType,
    pub quote_asset: QuoteAsset,
    pub boost_preset: BoostPreset,
    pub reward_preset: RewardPreset,
    pub vesting_preset: VestingPreset,
    pub status: PresaleStatus,
    pub duration_seconds: u32,
    pub start_ts: i64,
    pub end_ts: i64,
    pub closed_ts: i64,
    pub min_contribution: u64,
    pub devbuy_required_amount: u64,
    pub devbuy_amount: u64,
    pub devbuy_weight: u128,
    pub dev_vesting_cliff_seconds: u32,
    pub dev_vesting_linear_seconds: u32,
    pub dev_vesting_initial_unlock_bps: u16,
    pub soft_cap: u64,
    pub hard_cap: u64,
    pub max_wallet_contribution: u64,
    pub ticket_size: u64,
    pub max_tickets_per_wallet: u16,
    pub total_accepted: u64,
    pub total_committed: u64,
    pub total_weight: u128,
    pub total_refundable: u64,
    pub settlement_gross_accepted: u64,
    pub settlement_root: [u8; 32],
    #[max_len(200)]
    pub settlement_uri: String,
    pub route_state: RouteState,
    pub pump_quote_spent: u64,
    pub pumpswap_quote_spent: u64,
    pub total_winning_quote: u64,
    pub total_tokens_purchased: u64,
    pub total_locked_tokens: u64,
    pub finalized_quote: u64,
    pub raffle_seed_slot: u64,
    pub raffle_seed: [u8; 32],
    pub winning_ticket_count: u64,
    pub creator_reward_total: u64,
    pub creator_reward_claimed: u64,
    pub holder_reward_total: u64,
    pub holder_reward_claimed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ContributorState {
    pub owner: Pubkey,
    pub presale: Pubkey,
    pub accepted_amount: u64,
    pub settled_gross_accepted: u64,
    pub contribution_weight: u128,
    pub refundable_amount: u64,
    pub tickets: u64,
    pub winning_tickets: u64,
    pub token_claimed: u64,
    pub locked_tokens: u64,
    pub lock_started_ts: i64,
    pub holder_rewards_claimed: u64,
    pub forfeited_holder_rewards: bool,
    pub settlement_claimed: bool,
    pub is_devbuy: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PresaleConfigInput {
    pub launch_type: LaunchType,
    pub quote_asset: QuoteAsset,
    pub boost_preset: BoostPreset,
    pub mint: Pubkey,
    pub quote_mint: Pubkey,
    pub duration_seconds: u32,
    pub min_contribution: u64,
    pub devbuy_required_amount: u64,
    pub dev_vesting_cliff_seconds: u32,
    pub dev_vesting_linear_seconds: u32,
    pub dev_vesting_initial_unlock_bps: u16,
    pub soft_cap: u64,
    pub hard_cap: u64,
    pub max_wallet_contribution: u64,
    pub ticket_size: u64,
    pub max_tickets_per_wallet: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum LaunchType {
    ClassicFairBatch,
    EarlyBoostBatch,
    SoftCapRefund,
    HardCapOverflow,
    RaffleAllocation,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum BoostPreset {
    Low,
    Medium,
    High,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum QuoteAsset {
    Sol,
    Usdc,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RewardPreset {
    Balanced,
    Community,
    Creator,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum VestingPreset {
    Instant,
    Linear7Days,
    Linear30Days,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PresaleStatus {
    Draft,
    Open,
    Closed,
    RefundOnly,
    RaffleSettled,
    Finalizing,
    Finalized,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RouteState {
    RouteNotStarted,
    PumpBought,
    Migrated,
    PumpSwapBought,
    Finalized,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RouteProgram {
    Pump,
    PumpSwap,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RouteInstructionInput {
    pub program_id: Pubkey,
    pub data: Vec<u8>,
    pub account_count: u8,
}

#[error_code]
pub enum LaunchpadError {
    #[msg("Metadata URI is too long")]
    MetadataUriTooLong,
    #[msg("Invalid duration")]
    InvalidDuration,
    #[msg("Invalid minimum contribution")]
    InvalidMinContribution,
    #[msg("Invalid launch type")]
    InvalidLaunchType,
    #[msg("Invalid Stick target")]
    InvalidTarget,
    #[msg("Invalid launch config")]
    InvalidLaunchConfig,
    #[msg("Soft cap is required for this launch type")]
    SoftCapRequired,
    #[msg("Hard cap is required for this launch type")]
    HardCapRequired,
    #[msg("Ticket size is required for raffle launch")]
    TicketSizeRequired,
    #[msg("Max tickets per wallet is required for raffle launch")]
    MaxTicketsRequired,
    #[msg("Presale is not open")]
    PresaleNotOpen,
    #[msg("Presale is already closed")]
    PresaleClosed,
    #[msg("Presale is still open")]
    PresaleStillOpen,
    #[msg("Contribution is too small")]
    ContributionTooSmall,
    #[msg("Hard cap is filled")]
    HardCapFilled,
    #[msg("Max raffle tickets exceeded")]
    MaxTicketsExceeded,
    #[msg("Invalid presale status")]
    InvalidStatus,
    #[msg("Launch is not a raffle")]
    NotRaffle,
    #[msg("Invalid winning ticket count")]
    InvalidWinningTicketCount,
    #[msg("Finalize exceeds available quote")]
    FinalizeExceedsQuote,
    #[msg("Finalize is incomplete")]
    IncompleteFinalize,
    #[msg("Refund is unavailable")]
    RefundUnavailable,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Holder rewards were forfeited")]
    HolderRewardsForfeited,
    #[msg("Allocation is already locked")]
    AlreadyLocked,
    #[msg("Lock is still active")]
    LockStillActive,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid quote asset for this instruction")]
    InvalidQuoteAsset,
    #[msg("Invalid quote mint")]
    InvalidQuoteMint,
    #[msg("Invalid vault owner")]
    InvalidVaultOwner,
    #[msg("Devbuy is required before opening the presale")]
    DevbuyRequired,
    #[msg("Invalid vesting config")]
    InvalidVestingConfig,
    #[msg("Wallet contribution cap exceeded")]
    WalletCapExceeded,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Allocation vault does not contain enough purchased tokens")]
    InsufficientAllocationVault,
    #[msg("Settlement URI is too long")]
    SettlementUriTooLong,
    #[msg("Invalid settlement root")]
    InvalidSettlementRoot,
    #[msg("Invalid settlement")]
    InvalidSettlement,
    #[msg("Invalid Merkle proof")]
    InvalidMerkleProof,
    #[msg("Settlement is already claimed")]
    AlreadyClaimed,
    #[msg("Invalid route state")]
    InvalidRouteState,
    #[msg("Invalid route instruction")]
    InvalidRouteInstruction,
    #[msg("Route spent more quote than allowed")]
    RouteQuoteExceeded,
    #[msg("Route produced fewer tokens than required")]
    RouteTokenOutputTooLow,
}

fn record_contribution(
    presale: &mut Account<Presale>,
    contributor: &mut Account<ContributorState>,
    owner: Pubkey,
    amount: u64,
    contributor_bump: u8,
) -> Result<u64> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        presale.status == PresaleStatus::Open,
        LaunchpadError::PresaleNotOpen
    );
    require!(now < presale.end_ts, LaunchpadError::PresaleClosed);
    require!(
        amount >= presale.min_contribution,
        LaunchpadError::ContributionTooSmall
    );

    let mut requested = amount;
    if presale.max_wallet_contribution > 0 {
        let remaining_wallet = presale
            .max_wallet_contribution
            .saturating_sub(contributor.accepted_amount);
        requested = requested.min(remaining_wallet);
    }

    let accepted = requested;
    require!(accepted > 0, LaunchpadError::ContributionTooSmall);

    if contributor.owner == Pubkey::default() {
        contributor.owner = owner;
        contributor.presale = presale.key();
        contributor.bump = contributor_bump;
    }
    require!(!contributor.is_devbuy, LaunchpadError::Unauthorized);

    if presale.launch_type == LaunchType::RaffleAllocation {
        let new_tickets = accepted / presale.ticket_size;
        require!(new_tickets > 0, LaunchpadError::ContributionTooSmall);
        require!(
            contributor
                .tickets
                .checked_add(new_tickets)
                .ok_or(LaunchpadError::MathOverflow)?
                <= presale.max_tickets_per_wallet as u64,
            LaunchpadError::MaxTicketsExceeded
        );
        contributor.tickets = contributor
            .tickets
            .checked_add(new_tickets)
            .ok_or(LaunchpadError::MathOverflow)?;
    }

    contributor.accepted_amount = contributor
        .accepted_amount
        .checked_add(accepted)
        .ok_or(LaunchpadError::MathOverflow)?;
    let weight = calculate_contribution_weight(presale, accepted, now)?;
    contributor.contribution_weight = contributor
        .contribution_weight
        .checked_add(weight)
        .ok_or(LaunchpadError::MathOverflow)?;
    presale.total_accepted = presale
        .total_accepted
        .checked_add(accepted)
        .ok_or(LaunchpadError::MathOverflow)?;
    presale.total_committed = presale
        .total_committed
        .checked_add(accepted)
        .ok_or(LaunchpadError::MathOverflow)?;
    presale.total_weight = presale
        .total_weight
        .checked_add(weight)
        .ok_or(LaunchpadError::MathOverflow)?;

    Ok(accepted)
}

fn record_devbuy(
    presale: &mut Account<Presale>,
    contributor: &mut Account<ContributorState>,
    owner: Pubkey,
    amount: u64,
    contributor_bump: u8,
) -> Result<u64> {
    require!(
        presale.status == PresaleStatus::Draft,
        LaunchpadError::InvalidStatus
    );
    require!(owner == presale.creator, LaunchpadError::Unauthorized);
    require!(presale.devbuy_amount == 0, LaunchpadError::DevbuyRequired);
    require!(
        amount >= presale.devbuy_required_amount,
        LaunchpadError::ContributionTooSmall
    );

    let accepted = amount;
    require!(
        accepted >= presale.devbuy_required_amount,
        LaunchpadError::ContributionTooSmall
    );

    if contributor.owner == Pubkey::default() {
        contributor.owner = owner;
        contributor.presale = presale.key();
        contributor.bump = contributor_bump;
    }
    require!(
        contributor.owner == presale.creator,
        LaunchpadError::Unauthorized
    );
    contributor.is_devbuy = true;
    contributor.accepted_amount = accepted;

    let weight = calculate_devbuy_weight(presale, accepted)?;
    contributor.contribution_weight = weight;
    presale.devbuy_amount = accepted;
    presale.devbuy_weight = weight;
    presale.total_accepted = presale
        .total_accepted
        .checked_add(accepted)
        .ok_or(LaunchpadError::MathOverflow)?;
    presale.total_committed = presale
        .total_committed
        .checked_add(accepted)
        .ok_or(LaunchpadError::MathOverflow)?;
    presale.total_weight = presale
        .total_weight
        .checked_add(weight)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok(accepted)
}

fn transfer_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let ix = anchor_lang::solana_program::system_instruction::transfer(from.key, to.key, amount);
    anchor_lang::solana_program::program::invoke(&ix, &[from.clone(), to.clone()])?;
    Ok(())
}

fn create_quote_vault<'info>(
    payer: &AccountInfo<'info>,
    quote_vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    presale_key: Pubkey,
) -> Result<()> {
    if quote_vault.lamports() > 0 {
        return Ok(());
    }
    let rent_lamports = Rent::get()?.minimum_balance(0);
    let bump = Pubkey::find_program_address(&[b"quote_vault", presale_key.as_ref()], &crate::ID).1;
    let bump_bytes = [bump];
    let signer_seeds: &[&[u8]] = &[b"quote_vault", presale_key.as_ref(), &bump_bytes];
    let ix = anchor_lang::solana_program::system_instruction::create_account(
        payer.key,
        quote_vault.key,
        rent_lamports,
        0,
        &system_program::ID,
    );
    invoke_signed(
        &ix,
        &[payer.clone(), quote_vault.clone(), system_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

fn transfer_lamports_from_vault<'info>(
    presale: &mut Account<'info, Presale>,
    vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let presale_key = presale.key();
    let vault_bump = Pubkey::find_program_address(&[b"quote_vault", presale_key.as_ref()], &crate::ID).1;
    let vault_bump_bytes = [vault_bump];
    let signer_seeds: &[&[u8]] = &[b"quote_vault", presale_key.as_ref(), &vault_bump_bytes];
    let ix = anchor_lang::solana_program::system_instruction::transfer(vault.key, to.key, amount);
    invoke_signed(
        &ix,
        &[vault.clone(), to.clone(), system_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

fn transfer_tokens_from_presale<'info>(
    presale: &Account<'info, Presale>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let id = presale.id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] =
        &[&[b"presale", presale.creator.as_ref(), &id, &[presale.bump]]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: presale.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        mint.decimals,
    )?;
    Ok(())
}

fn execute_route_step<'info>(
    accounts: &mut FinalizePumpRoute<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    max_quote_spend: u64,
    min_tokens_out: u64,
    route_instructions: &[RouteInstructionInput],
    route_program: RouteProgram,
) -> Result<()> {
    validate_finalize_accounts(accounts)?;
    require!(max_quote_spend > 0, LaunchpadError::FinalizeExceedsQuote);
    require!(min_tokens_out > 0, LaunchpadError::RouteTokenOutputTooLow);

    let spendable_quote = spendable_route_quote(&accounts.presale)?;
    let already_spent = accounts
        .presale
        .pump_quote_spent
        .checked_add(accounts.presale.pumpswap_quote_spent)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        already_spent
            .checked_add(max_quote_spend)
            .ok_or(LaunchpadError::MathOverflow)?
            <= spendable_quote,
        LaunchpadError::FinalizeExceedsQuote
    );

    let token_before = token_account_amount(
        &accounts.allocation_vault_ata.to_account_info(),
        accounts.presale.key(),
        accounts.presale.mint,
    )?;
    let quote_before = accounts.quote_vault.to_account_info().lamports();
    execute_route_cpis(
        &accounts.presale,
        &accounts.quote_vault,
        &accounts.mint.to_account_info(),
        remaining_accounts,
        route_instructions,
        route_program,
    )?;
    let token_after = token_account_amount(
        &accounts.allocation_vault_ata.to_account_info(),
        accounts.presale.key(),
        accounts.presale.mint,
    )?;
    let quote_after = accounts.quote_vault.to_account_info().lamports();
    let quote_spent = quote_before
        .checked_sub(quote_after)
        .ok_or(LaunchpadError::MathOverflow)?;
    let tokens_received = token_after
        .checked_sub(token_before)
        .ok_or(LaunchpadError::MathOverflow)?;

    require!(quote_spent <= max_quote_spend, LaunchpadError::RouteQuoteExceeded);
    require!(
        tokens_received >= min_tokens_out,
        LaunchpadError::RouteTokenOutputTooLow
    );

    match route_program {
        RouteProgram::Pump => {
            accounts.presale.pump_quote_spent = accounts
                .presale
                .pump_quote_spent
                .checked_add(quote_spent)
                .ok_or(LaunchpadError::MathOverflow)?;
        }
        RouteProgram::PumpSwap => {
            accounts.presale.pumpswap_quote_spent = accounts
                .presale
                .pumpswap_quote_spent
                .checked_add(quote_spent)
                .ok_or(LaunchpadError::MathOverflow)?;
        }
    }
    accounts.presale.finalized_quote = accounts
        .presale
        .finalized_quote
        .checked_add(quote_spent)
        .ok_or(LaunchpadError::MathOverflow)?;
    accounts.presale.total_tokens_purchased = accounts
        .presale
        .total_tokens_purchased
        .checked_add(tokens_received)
        .ok_or(LaunchpadError::MathOverflow)?;
    accounts.presale.status = PresaleStatus::Finalizing;
    Ok(())
}

fn validate_finalize_accounts(accounts: &FinalizePumpRoute) -> Result<()> {
    let presale = &accounts.presale;
    require!(presale.quote_asset == QuoteAsset::Sol, LaunchpadError::InvalidQuoteAsset);
    require!(accounts.config.key() == presale.config, LaunchpadError::Unauthorized);
    require!(accounts.mint.key() == presale.mint, LaunchpadError::InvalidTokenMint);
    require!(
        matches!(presale.status, PresaleStatus::Closed | PresaleStatus::Finalizing),
        LaunchpadError::InvalidStatus
    );
    Ok(())
}

fn spendable_route_quote(presale: &Presale) -> Result<u64> {
    Ok(presale.settlement_gross_accepted)
}

fn execute_route_cpis<'info>(
    presale: &Account<'info, Presale>,
    quote_vault: &SystemAccount<'info>,
    mint: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    route_instructions: &[RouteInstructionInput],
    route_program: RouteProgram,
) -> Result<()> {
    require!(
        !route_instructions.is_empty() && route_instructions.len() <= MAX_ROUTE_INSTRUCTIONS,
        LaunchpadError::InvalidRouteInstruction
    );

    let mut cursor = 0usize;
    let mut saw_route_program = false;
    for route_ix in route_instructions {
        if route_ix.program_id == expected_route_program(route_program) {
            saw_route_program = true;
        }
        require!(
            route_ix.program_id == expected_route_program(route_program)
                || is_allowed_support_program(&route_ix.program_id),
            LaunchpadError::InvalidRouteInstruction
        );
        let account_count = route_ix.account_count as usize;
        require!(
            cursor
                .checked_add(account_count)
                .ok_or(LaunchpadError::MathOverflow)?
                <= remaining_accounts.len(),
            LaunchpadError::InvalidRouteInstruction
        );
        let infos = &remaining_accounts[cursor..cursor + account_count];
        cursor += account_count;

        let metas = infos
            .iter()
            .map(|account| {
                let is_signer = account.is_signer
                    || account.key() == presale.key()
                    || account.key() == quote_vault.key()
                    || account.key() == mint.key();
                if account.is_writable {
                    AccountMeta::new(account.key(), is_signer)
                } else {
                    AccountMeta::new_readonly(account.key(), is_signer)
                }
            })
            .collect::<Vec<_>>();

        let ix = Instruction {
            program_id: route_ix.program_id,
            accounts: metas,
            data: route_ix.data.clone(),
        };
        let presale_id = presale.id.to_le_bytes();
        let presale_key = presale.key();
        let quote_vault_bump =
            Pubkey::find_program_address(&[b"quote_vault", presale_key.as_ref()], &crate::ID).1;
        let quote_vault_bump_bytes = [quote_vault_bump];
        let quote_vault_seeds: &[&[u8]] = &[
            b"quote_vault",
            presale_key.as_ref(),
            &quote_vault_bump_bytes,
        ];
        let mint_bump = Pubkey::find_program_address(&[b"mint", presale.key().as_ref()], &crate::ID).1;
        let mint_bump_bytes = [mint_bump];
        let mint_seeds: &[&[u8]] = &[b"mint", presale_key.as_ref(), &mint_bump_bytes];
        let presale_bump_bytes = [presale.bump];
        let presale_seeds: &[&[u8]] = &[
            b"presale",
            presale.creator.as_ref(),
            &presale_id,
            &presale_bump_bytes,
        ];
        invoke_signed(
            &ix,
            infos,
            &[&quote_vault_seeds, mint_seeds, presale_seeds],
        )?;
    }
    require!(
        cursor == remaining_accounts.len(),
        LaunchpadError::InvalidRouteInstruction
    );
    require!(saw_route_program, LaunchpadError::InvalidRouteInstruction);
    Ok(())
}

fn expected_route_program(route_program: RouteProgram) -> Pubkey {
    match route_program {
        RouteProgram::Pump => PUMP_PROGRAM_ID,
        RouteProgram::PumpSwap => PUMPSWAP_PROGRAM_ID,
    }
}

fn is_allowed_support_program(program_id: &Pubkey) -> bool {
    *program_id == system_program::ID
        || *program_id == anchor_spl::token_2022::ID
        || *program_id == anchor_spl::token::ID
        || *program_id == anchor_spl::associated_token::ID
        || *program_id == PUMP_FEES_PROGRAM_ID
}

fn token_account_amount(
    account: &AccountInfo,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
) -> Result<u64> {
    if account.data_is_empty() {
        return Ok(0);
    }

    let data = account.try_borrow_data()?;
    let mut data_slice: &[u8] = &data;
    let token_account = TokenAccount::try_deserialize_unchecked(&mut data_slice)?;
    require!(token_account.owner == expected_owner, LaunchpadError::InvalidVaultOwner);
    require!(token_account.mint == expected_mint, LaunchpadError::InvalidTokenMint);
    Ok(token_account.amount)
}

fn calculate_allocation(presale: &Presale, contributor: &ContributorState) -> Result<u64> {
    if presale.launch_type == LaunchType::EarlyBoostBatch {
        if contributor.settled_gross_accepted == 0 || presale.settlement_gross_accepted == 0 {
            return Ok(0);
        }
        return Ok((presale.total_tokens_purchased as u128)
            .checked_mul(contributor.settled_gross_accepted as u128)
            .ok_or(LaunchpadError::MathOverflow)?
            .checked_div(presale.settlement_gross_accepted as u128)
            .ok_or(LaunchpadError::MathOverflow)? as u64);
    }

    let eligible_quote = if presale.launch_type == LaunchType::RaffleAllocation {
        contributor
            .winning_tickets
            .checked_mul(presale.ticket_size)
            .ok_or(LaunchpadError::MathOverflow)?
    } else {
        contributor.accepted_amount
    };
    if eligible_quote == 0 || presale.finalized_quote == 0 {
        return Ok(0);
    }

    Ok((presale.total_tokens_purchased as u128)
        .checked_mul(eligible_quote as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(presale.finalized_quote as u128)
        .ok_or(LaunchpadError::MathOverflow)? as u64)
}

fn settlement_leaf(
    presale: &Pubkey,
    owner: &Pubkey,
    committed: u64,
    weight: u128,
    gross_accepted: u64,
    refund: u64,
) -> [u8; 32] {
    let committed_bytes = committed.to_le_bytes();
    let weight_bytes = weight.to_le_bytes();
    let gross_accepted_bytes = gross_accepted.to_le_bytes();
    let refund_bytes = refund.to_le_bytes();
    hashv(&[
        b"stick:settlement:v1",
        presale.as_ref(),
        owner.as_ref(),
        &committed_bytes,
        &weight_bytes,
        &gross_accepted_bytes,
        &refund_bytes,
    ])
    .to_bytes()
}

fn verify_merkle_proof(mut leaf: [u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    for sibling in proof {
        leaf = if leaf <= *sibling {
            hashv(&[&leaf, sibling]).to_bytes()
        } else {
            hashv(&[sibling, &leaf]).to_bytes()
        };
    }
    leaf == root
}

fn calculate_contribution_weight(
    presale: &Presale,
    accepted: u64,
    contribution_ts: i64,
) -> Result<u128> {
    if presale.launch_type != LaunchType::EarlyBoostBatch {
        return Ok(accepted as u128);
    }
    require!(presale.hard_cap > 0, LaunchpadError::HardCapRequired);
    let remaining_seconds = presale.end_ts.saturating_sub(contribution_ts).max(0) as u128;
    let duration_seconds = (presale.duration_seconds as u128).max(1);
    let time_bps = remaining_seconds
        .checked_mul(BASIS_POINTS as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(duration_seconds)
        .ok_or(LaunchpadError::MathOverflow)?
        .min(BASIS_POINTS as u128);
    let multiplier_bps = fill_multiplier_bps(
        presale.total_accepted,
        presale.hard_cap,
        presale.boost_preset,
    )?;
    let bonus_bps = time_bps
        .checked_mul(multiplier_bps as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(BASIS_POINTS as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok((accepted as u128)
        .checked_mul(BASE_WEIGHT_BPS.checked_add(bonus_bps).ok_or(LaunchpadError::MathOverflow)?)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(BASIS_POINTS as u128)
        .ok_or(LaunchpadError::MathOverflow)?)
}

fn calculate_devbuy_weight(presale: &Presale, accepted: u64) -> Result<u128> {
    if presale.launch_type != LaunchType::EarlyBoostBatch {
        return Ok(accepted as u128);
    }
    require!(presale.hard_cap > 0, LaunchpadError::HardCapRequired);
    let multiplier_bps = fill_multiplier_bps(0, presale.hard_cap, presale.boost_preset)?;
    let bonus_bps = multiplier_bps as u128;
    Ok((accepted as u128)
        .checked_mul(BASE_WEIGHT_BPS.checked_add(bonus_bps).ok_or(LaunchpadError::MathOverflow)?)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(BASIS_POINTS as u128)
        .ok_or(LaunchpadError::MathOverflow)?)
}

fn fill_multiplier_bps(raised_before: u64, hard_cap: u64, preset: BoostPreset) -> Result<u64> {
    require!(hard_cap > 0, LaunchpadError::HardCapRequired);
    let boost_bps = match preset {
        BoostPreset::Low => 2_500u128,
        BoostPreset::Medium => 5_000u128,
        BoostPreset::High => 10_000u128,
    };
    let fill_bps = ((raised_before as u128)
        .checked_mul(BASIS_POINTS as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(hard_cap as u128)
        .ok_or(LaunchpadError::MathOverflow)?)
    .min(BASIS_POINTS as u128);
    let sparse_bps = BASIS_POINTS as u128 - fill_bps;
    let sparse_squared_bps = sparse_bps
        .checked_mul(sparse_bps)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(BASIS_POINTS as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok((BASIS_POINTS as u128
        + boost_bps
            .checked_mul(sparse_squared_bps)
            .ok_or(LaunchpadError::MathOverflow)?
            .checked_div(BASIS_POINTS as u128)
            .ok_or(LaunchpadError::MathOverflow)?) as u64)
}

fn devbuy_vested_token_amount(presale: &Presale, total_devbuy_tokens: u64) -> Result<u64> {
    if presale.dev_vesting_cliff_seconds == 0
        && presale.dev_vesting_linear_seconds == 0
        && presale.dev_vesting_initial_unlock_bps >= BASIS_POINTS
    {
        return Ok(total_devbuy_tokens);
    }

    let initial = (total_devbuy_tokens as u128)
        .checked_mul(presale.dev_vesting_initial_unlock_bps as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(BASIS_POINTS as u128)
        .ok_or(LaunchpadError::MathOverflow)? as u64;
    let now = Clock::get()?.unix_timestamp;
    let elapsed = now.saturating_sub(presale.closed_ts).max(0);
    if elapsed < presale.dev_vesting_cliff_seconds as i64 {
        return Ok(initial);
    }
    if presale.dev_vesting_linear_seconds == 0 {
        return Ok(total_devbuy_tokens);
    }
    let linear_elapsed = elapsed.saturating_sub(presale.dev_vesting_cliff_seconds as i64);
    if linear_elapsed >= presale.dev_vesting_linear_seconds as i64 {
        return Ok(total_devbuy_tokens);
    }
    let remaining = total_devbuy_tokens.saturating_sub(initial);
    Ok(initial
        .checked_add(
            (remaining as u128)
                .checked_mul(linear_elapsed as u128)
                .ok_or(LaunchpadError::MathOverflow)?
                .checked_div(presale.dev_vesting_linear_seconds as u128)
                .ok_or(LaunchpadError::MathOverflow)? as u64,
        )
        .ok_or(LaunchpadError::MathOverflow)?)
}

fn vested_amount(presale: &Presale) -> Result<u64> {
    if presale.creator_reward_total == 0 {
        return Ok(0);
    }

    let duration = match presale.vesting_preset {
        VestingPreset::Instant => return Ok(presale.creator_reward_total),
        VestingPreset::Linear7Days => 7 * DAY_SECONDS,
        VestingPreset::Linear30Days => 30 * DAY_SECONDS,
    };
    let elapsed = Clock::get()?
        .unix_timestamp
        .saturating_sub(presale.closed_ts)
        .max(0);
    if elapsed >= duration {
        return Ok(presale.creator_reward_total);
    }
    Ok((presale.creator_reward_total as u128)
        .checked_mul(elapsed as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(duration as u128)
        .ok_or(LaunchpadError::MathOverflow)? as u64)
}

#[allow(dead_code)]
fn reward_split_bps(preset: RewardPreset) -> (u16, u16, u16) {
    match preset {
        RewardPreset::Balanced => (5_000, 2_500, 2_500),
        RewardPreset::Community => (3_000, 4_000, 3_000),
        RewardPreset::Creator => (6_000, 1_500, 2_500),
    }
}

#[allow(dead_code)]
fn assert_bps_total(preset: RewardPreset) -> bool {
    let (creator, holder, token_buyback) = reward_split_bps(preset);
    creator + holder + token_buyback == BASIS_POINTS
}
