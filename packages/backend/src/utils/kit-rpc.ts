import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type Signature,
} from "@solana/kit";
import type { KitSolanaClient } from "./solana.js";

export async function kitFetchAccountBytes(
  client: KitSolanaClient,
  addr: string,
): Promise<Uint8Array | null> {
  const { value } = await client.rpc
    .getAccountInfo(addr as Parameters<typeof client.rpc.getAccountInfo>[0], { encoding: "base64" })
    .send();
  if (!value) return null;
  return new Uint8Array(Buffer.from(value.data[0] as string, "base64"));
}

export async function kitGetProgramAccounts(
  client: KitSolanaClient,
  filters: unknown[],
): Promise<Array<{ pubkey: string; data: Uint8Array }>> {
  const accounts = await (client.rpc as unknown as {
    getProgramAccounts: (
      addr: string,
      opts: unknown,
    ) => { send: () => Promise<unknown[]> };
  })
    .getProgramAccounts(client.programAddress as unknown as string, {
      encoding: "base64",
      filters,
    })
    .send();

  return (accounts as Array<{ pubkey: unknown; account: { data: [string, string] } }>).map(
    (a) => ({
      pubkey: String(a.pubkey),
      data: new Uint8Array(Buffer.from(a.account.data[0], "base64")),
    }),
  );
}

export async function kitSendTx(
  client: KitSolanaClient,
  instructions: Instruction[],
): Promise<string> {
  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();
  const base = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(client.oracleSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = instructions.reduce<any>(
    (m, ix) => appendTransactionMessageInstruction(ix, m),
    base,
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await client.rpc
    .sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" })
    .send();
  await kitWaitForConfirmation(client, sig);
  return sig as string;
}

async function kitWaitForConfirmation(
  client: KitSolanaClient,
  signature: Signature,
): Promise<void> {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    const result = await client.rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: false })
      .send();
    const status = result.value[0];
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Transaction ${signature} not confirmed after ${maxAttempts} attempts`);
}
