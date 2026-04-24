import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { address } from "@solana/kit";
import { generated } from "@pact-network/insurance";
const {
  decodeProtocolConfig,
  decodeCoveragePool,
  decodePolicy,
  getCoveragePoolHostname,
  findProtocolConfigPda,
  getSettlePremiumInstruction,
  COVERAGE_POOL_DISCRIMINATOR,
  POLICY_DISCRIMINATOR,
} = generated;
import {
  createKitSolanaClient,
  getSolanaConfig,
} from "../utils/solana.js";
import {
  kitFetchAccountBytes,
  kitGetProgramAccounts,
  kitSendTx,
} from "../utils/kit-rpc.js";
import { query } from "../db.js";

interface CallValueRow {
  total: string | null;
}

interface WatermarkRow {
  last_settled_at: Date;
}

const INITIAL_WATERMARK_INTERVAL = "15 minutes";

/**
 * Premium settler (post-pivot, delegation model).
 *
 * For every active policy across every coverage pool, sum the call_records
 * payment_amount for that (provider, agent) pair over the recent window and
 * call settle_premium with the aggregated call_value.
 */
export async function runPremiumSettler(app: FastifyInstance): Promise<void> {
  const config = getSolanaConfig();
  const client = await createKitSolanaClient(config);

  const [protocolConfigAddr] = await findProtocolConfigPda();
  const configBytes = await kitFetchAccountBytes(client, protocolConfigAddr as string);
  if (!configBytes) {
    app.log.warn("Premium settler: protocol config not found");
    return;
  }
  const protocolConfig = decodeProtocolConfig(configBytes);

  const treasuryAta = getAssociatedTokenAddressSync(
    new PublicKey(protocolConfig.treasury as string),
    new PublicKey(protocolConfig.usdcMint as string),
  );
  const treasuryAtaAddr = address(treasuryAta.toBase58());

  const poolAccounts = await kitGetProgramAccounts(client, [
    {
      memcmp: {
        offset: 0,
        bytes: Buffer.from([COVERAGE_POOL_DISCRIMINATOR]).toString("base64"),
        encoding: "base64",
      },
    },
  ]);
  app.log.debug({ poolCount: poolAccounts.length }, "Premium settler: fetched pools");

  for (const poolAcct of poolAccounts) {
    let pool: ReturnType<typeof decodeCoveragePool>;
    try {
      pool = decodeCoveragePool(poolAcct.data);
    } catch {
      continue;
    }

    const hostname = getCoveragePoolHostname(pool);
    const poolAddr = address(poolAcct.pubkey);
    const vaultAddr = address(pool.vault as string);

    // Policy accounts for this pool: `pool` field is at offset 8+32=40
    // (disc:1 + pad:7 + agent:32 = 40). Matches Convention #16 from port plan.
    const policyAccounts = await kitGetProgramAccounts(client, [
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from([POLICY_DISCRIMINATOR]).toString("base64"),
          encoding: "base64",
        },
      },
      {
        memcmp: {
          offset: 40,
          bytes: poolAcct.pubkey,
          encoding: "base58",
        },
      },
    ]);

    for (const policyAcct of policyAccounts) {
      let policy: ReturnType<typeof decodePolicy>;
      try {
        policy = decodePolicy(policyAcct.data);
      } catch {
        continue;
      }
      if (policy.active === 0) continue;

      const policyPdaStr = policyAcct.pubkey;
      const agentPubkey = policy.agent as string;

      const watermarkResult = await query<WatermarkRow>(
        `SELECT last_settled_at FROM policy_settlements WHERE policy_pda = $1`,
        [policyPdaStr],
      );
      const hasWatermark = watermarkResult.rows.length > 0;

      const sumSql = hasWatermark
        ? `SELECT COALESCE(SUM(cr.payment_amount), 0)::text AS total
           FROM call_records cr
           JOIN providers p ON p.id = cr.provider_id
           WHERE cr.agent_pubkey = $1
             AND p.base_url = $2
             AND cr.created_at > $3
             AND cr.payment_amount IS NOT NULL`
        : `SELECT COALESCE(SUM(cr.payment_amount), 0)::text AS total
           FROM call_records cr
           JOIN providers p ON p.id = cr.provider_id
           WHERE cr.agent_pubkey = $1
             AND p.base_url = $2
             AND cr.created_at > NOW() - INTERVAL '${INITIAL_WATERMARK_INTERVAL}'
             AND cr.payment_amount IS NOT NULL`;

      const params: unknown[] = hasWatermark
        ? [agentPubkey, hostname, watermarkResult.rows[0].last_settled_at]
        : [agentPubkey, hostname];

      const result = await query<CallValueRow>(sumSql, params);
      const callValueStr = result.rows[0]?.total ?? "0";
      const callValue = BigInt(callValueStr);

      if (callValue === 0n) {
        await query(
          `INSERT INTO policy_settlements (policy_pda, last_settled_at, updated_at)
           VALUES ($1, NOW(), NOW())
           ON CONFLICT (policy_pda)
           DO UPDATE SET last_settled_at = NOW(), updated_at = NOW()`,
          [policyPdaStr],
        );
        continue;
      }

      try {
        const agentAtaAddr = address(policy.agentTokenAccount as string);

        const settlePremiumInput: Parameters<typeof getSettlePremiumInstruction>[0] = {
          config: protocolConfigAddr,
          pool: poolAddr,
          vault: vaultAddr,
          policy: address(policyPdaStr),
          treasuryAta: treasuryAtaAddr,
          agentAta: agentAtaAddr,
          oracleSigner: client.oracleSigner,
          callValue,
        };

        // Phase 5 F1: append referrer ATA when referrer is present.
        if (policy.referrerPresent !== 0) {
          const referrerPk = new PublicKey(
            Buffer.from(policy.referrer as number[]),
          );
          const usdcMintPk = new PublicKey(protocolConfig.usdcMint as string);
          const referrerAta = getAssociatedTokenAddressSync(usdcMintPk, referrerPk);
          settlePremiumInput.referrerTokenAccount = address(referrerAta.toBase58());
        }

        const ix = getSettlePremiumInstruction(settlePremiumInput);
        const sig = await kitSendTx(client, [ix]);

        await query(
          `INSERT INTO policy_settlements (policy_pda, last_settled_at, updated_at)
           VALUES ($1, NOW(), NOW())
           ON CONFLICT (policy_pda)
           DO UPDATE SET last_settled_at = NOW(), updated_at = NOW()`,
          [policyPdaStr],
        );

        app.log.info(
          {
            hostname,
            policy: policyPdaStr,
            callValue: callValue.toString(),
            sig,
          },
          "Premium settled",
        );
      } catch (err) {
        app.log.warn(
          {
            err,
            hostname,
            policy: policyPdaStr,
            callValue: callValue.toString(),
          },
          "settle_premium failed for policy",
        );
      }
    }
  }
}
