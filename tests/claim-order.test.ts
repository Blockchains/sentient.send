import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

// Experiment: out-of-order and repeated claim flows on localnet; every attempt
// is recorded so the identical script can be diffed against the upstream baseline.
describe("experiment: claim order and duplicate claims", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PredictionMarket as any;
  const ledger: string[] = [];
  let treasury: PublicKey;
  let marketPda: PublicKey;

  const posPda = (m: PublicKey, u: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer()], program.programId)[0];

  async function attempt(step: string, claimant: PublicKey, fn: any) {
    let error: string | null = null;
    try { await fn(); } catch (e: any) { error = e.error?.errorCode?.code || e.message || String(e); }
    const row = { step, ok: error === null, error, claimant: await provider.connection.getBalance(claimant), market: await provider.connection.getBalance(marketPda) };
    ledger.push(JSON.stringify(row));
    console.log("[claim-experiment]", JSON.stringify(row));
    return error;
  }

  const feeArgs = () =>
    program.methods.claimCreatorFees().accounts({
      market: marketPda,
      treasury,
      creator: provider.wallet.publicKey,
      protocolAuthority: provider.wallet.publicKey,
    });

  before(async () => {
    [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
    try {
      await program.methods.initializeTreasury().accounts({ treasury, authority: provider.wallet.publicKey, systemProgram: SystemProgram.programId }).rpc();
      console.log("[claim-experiment] treasury initialized");
    } catch (e) {
      console.log("[claim-experiment] treasury already initialized");
    }
  });

  it("records early, normal and duplicate claim outcomes", async () => {
    const creator = provider.wallet.publicKey;
    const question = `claim-order ${Date.now()}`;
    const blockTime = await provider.connection.getBlockTime(await provider.connection.getSlot());
    const end = new anchor.BN(blockTime + 25);
    marketPda = PublicKey.findProgramAddressSync([Buffer.from("market"), creator.toBuffer(), Buffer.from(question)], program.programId)[0];
    const creatorPos = posPda(marketPda, creator);

    // create_market: 1 SOL, creation fee 20,000,000 lamports.
    await program.methods.createMarket(question, "", end, ["Side A", "Side B"], new anchor.BN(LAMPORTS_PER_SOL)).accounts({
      market: marketPda,
      position: creatorPos,
      treasury,
      creator,
      systemProgram: SystemProgram.programId,
    }).rpc();

    // place_bet 10,000,050 lamports: bet fee 200,001 (odd), fee_pool 20,200,001 (odd).
    const bettor = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(bettor.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    const bettorPos = posPda(marketPda, bettor.publicKey);
    await program.methods.placeBet(0, new anchor.BN(10_000_050)).accounts({
      market: marketPda,
      position: bettorPos,
      user: bettor.publicKey,
      systemProgram: SystemProgram.programId,
    }).signers([bettor]).rpc();

    // Early claim_winnings before market end.
    let err = await attempt("early-claim-winnings", bettor.publicKey, () =>
      program.methods.claimWinnings().accounts({ market: marketPda, position: bettorPos, user: bettor.publicKey }).signers([bettor]).rpc());
    expect(err || "", "early claim_winnings").to.include("MarketNotEnded");

    // Early claim_creator_fees before market end.
    err = await attempt("early-claim-creator-fees", creator, () => feeArgs().rpc());
    expect(err || "", "early claim_creator_fees").to.include("MarketNotEnded");

    // Wait past end_timestamp, then resolve explicitly.
    await new Promise((r) => setTimeout(r, 27000));
    await program.methods.resolveMarket().accounts({ market: marketPda, resolver: creator }).rpc();

    // One normal claim after resolution.
    err = await attempt("normal-claim-winnings", bettor.publicKey, () =>
      program.methods.claimWinnings().accounts({ market: marketPda, position: bettorPos, user: bettor.publicKey }).signers([bettor]).rpc());
    expect(err, "normal claim_winnings").to.be.null;
    const pos = await program.account.userPosition.fetch(bettorPos);
    expect(pos.claimed, "position claimed").to.be.true;

    // Duplicate claim_winnings, same market and beneficiary.
    err = await attempt("duplicate-claim-winnings", bettor.publicKey, () =>
      program.methods.claimWinnings().accounts({ market: marketPda, position: bettorPos, user: bettor.publicKey }).signers([bettor]).rpc());
    expect(err || "", "duplicate claim_winnings").to.include("AlreadyClaimed");

    // claim_creator_fees once; split checked against independent floor and ceil on odd fee_pool.
    const m = await program.account.market.fetch(marketPda);
    const feePool = m.feePool.toNumber();
    const expCreator = Math.floor(feePool / 2);
    const expProtocol = feePool - expCreator;
    err = await attempt("normal-claim-creator-fees", creator, () => feeArgs().rpc());
    expect(err, "normal claim_creator_fees").to.be.null;
    const m2 = await program.account.market.fetch(marketPda);
    expect(m2.creatorFeesDistributed.toNumber()).to.equal(expCreator);
    expect(m2.protocolFeesDistributed.toNumber()).to.equal(expProtocol);
    if (feePool % 2 !== 0) console.log(`[claim-experiment] odd fee_pool=${feePool} creator=${expCreator} protocol=${expProtocol} asymmetry=${expProtocol - expCreator}`);

    // Duplicate claim_creator_fees.
    err = await attempt("duplicate-claim-creator-fees", creator, () => feeArgs().rpc());
    expect(err || "", "duplicate claim_creator_fees").to.include("FeesAlreadyClaimed");

    console.log(`[claim-experiment] market final=${await provider.connection.getBalance(marketPda)} ledger=${JSON.stringify(ledger)}`);
  });
});
