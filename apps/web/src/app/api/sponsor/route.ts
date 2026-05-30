import { NextResponse } from "next/server";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DEFAULT_PROGRAM_ID,
  deserializeTransaction,
  loadKeypairFromJson,
  serializeTransaction
} from "@fair/launchpad-client";

const PHANTOM_LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const MEMO_V2_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MEMO_V1_PROGRAM_ID = new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");

export async function GET() {
  const sponsor = getSponsor();
  if (!sponsor) {
    return NextResponse.json({ enabled: false }, { status: 404 });
  }
  return NextResponse.json({ enabled: true, publicKey: sponsor.publicKey.toBase58() });
}

export async function POST(request: Request) {
  const sponsor = getSponsor();
  if (!sponsor) {
    return NextResponse.json({ error: "Sponsored transactions are not configured." }, { status: 500 });
  }

  const { transaction } = await request.json() as { transaction?: string };
  if (!transaction) {
    return NextResponse.json({ error: "Missing serialized transaction." }, { status: 400 });
  }

  const tx = deserializeTransaction(transaction);
  const sponsorKey = sponsor.publicKey.toBase58();
  const staticKeys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  if (staticKeys[0] !== sponsorKey) {
    return NextResponse.json({ error: "Sponsor must be the fee payer." }, { status: 400 });
  }

  const allowedProgramIds = getAllowedProgramIds();
  for (const instruction of tx.message.compiledInstructions) {
    const programId = tx.message.staticAccountKeys[instruction.programIdIndex]?.toBase58();
    if (!programId || !allowedProgramIds.has(programId)) {
      return NextResponse.json({ error: `Instruction program is not sponsor-allowed: ${programId ?? "unknown"}` }, { status: 400 });
    }
  }

  tx.sign([sponsor]);
  return NextResponse.json({ transaction: serializeTransaction(tx) });
}

function getSponsor() {
  if (process.env.SPONSORED_TX_ENABLED !== "true") {
    return null;
  }
  const secret = process.env.SPONSOR_KEYPAIR_JSON;
  if (!secret) {
    return null;
  }
  return loadKeypairFromJson(secret);
}

function getAllowedProgramIds(): Set<string> {
  const programId = process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID
    ? new PublicKey(process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID)
    : DEFAULT_PROGRAM_ID;
  return new Set([
    programId.toBase58(),
    SystemProgram.programId.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
    PHANTOM_LIGHTHOUSE_PROGRAM_ID.toBase58(),
    MEMO_V2_PROGRAM_ID.toBase58(),
    MEMO_V1_PROGRAM_ID.toBase58()
  ]);
}
