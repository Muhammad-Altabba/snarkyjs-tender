import {
  Bool,
  Field,
  PrivateKey,
  PublicKey,
  SmartContract,
  method,
  UInt64,
  Mina,
  Party,
  Ledger,
  Circuit,
} from 'snarkyjs';

export {
  deploy,
  bid,
  revealWinner,
  generateDummyBidders,
  updateBiddersBalances,
};

function containsPublicKey(xs: Array<PublicKey>, x: PublicKey): Bool {
  return new Bool(xs.some((pub) => pub.equals(x).toBoolean()));
}

// This implements a sealed bid auction where the proposals are secret
//  A sealed-bid auction is a type of auction process in which all bidders simultaneously
//    submit sealed bids to the auctioneer so that no bidder knows how much the other auction
//    participants have bid. Sealed bid refers to a written bid placed in a sealed envelope.
//    The sealed bid is not opened until the stated date, at which time all bids are opened
//    together. (Ref: https://www.investopedia.com/terms/s/sealed-bid-auction.asp)
class SealedBidAuctionSnapp extends SmartContract {
  biddersWhitelist: Array<PublicKey>;
  participationCost: UInt64;

  winner: PublicKey = this.address;
  lowestBid: UInt64;

  constructor(
    address: PublicKey,
    initialBalance: UInt64,
    biddersWhitelist: Array<PublicKey>,
    participationCost: number,
    bidThreshold: UInt64
  ) {
    super(address);
    this.biddersWhitelist = biddersWhitelist;
    this.balance.addInPlace(initialBalance);
    this.lowestBid = bidThreshold;
    console.log('bidThreshold', bidThreshold);
    console.log('this.lowestBid', this.lowestBid);
    this.participationCost = UInt64.fromNumber(participationCost);
  }

  // requires a bid from one of the keys in the list
  @method async bid(amount: UInt64) {
    if (!Mina.currentTransaction?.sender.toPublicKey()) {
      throw new Error('Not able to get Mina.currentTransaction');
    }

    // Check that the bidder is in the whitelist
    const isWhiteListed = containsPublicKey(
      this.biddersWhitelist,
      Mina.currentTransaction?.sender.toPublicKey()
    );

    // equivalent to: `isWhiteListed.assertEquals(true);`
    if (!isWhiteListed.toBoolean()) {
      throw new Error('Only whitelisted can bid');
    } else {
      console.log('Received a bid');
    }
    const publicKey = Mina.currentTransaction?.sender.toPublicKey();

    // The following commented code produce an exception:
    //  Error happened when trying to bid! Error: rangeCheckHelper:
    //  Expected 28948022309329048855892746252171976963363056481941560715954676764349966633661 to fit in 64 bits
    // Because of the exception, the code is commented and replaced with the next if
    // this.lowestBid = Circuit.if(
    //   amount.lt(this.lowestBid),
    //   amount,
    //   this.lowestBid
    // );
    // this.winner = Circuit.if(amount.lt(this.lowestBid), publicKey, this.winner);

    // Note: the following seems to be a hack and the previous commented code sounds better but produce an exception
    const lowestBid = Number.parseInt(this.lowestBid.toString());
    const bidAmount = Number.parseInt(amount.toString());
    if (bidAmount < lowestBid) {
      this.lowestBid = UInt64.fromNumber(bidAmount);
      this.winner = publicKey;
    }

    // Deduct the Participation Cost from the bidder
    Party.createUnsigned(
      Mina.currentTransaction?.sender.toPublicKey()
    ).balance.subInPlace(this.participationCost);
    this.balance.addInPlace(this.participationCost);
  }
  @method async revealWinner(): Promise<{
    lowestBid: string;
    winner: PublicKey;
  }> {
    if (!Mina.currentTransaction?.sender.toPublicKey()) {
      throw new Error('Not able to get Mina.currentTransaction');
    }

    const publicKey = Mina.currentTransaction?.sender.toPublicKey();

    // Assert the method is called by the winner or the SmartContract owner
    Bool.or(
      publicKey.equals(this.winner),
      publicKey.equals(this.address)
    ).assertEquals(true);

    // Pay the best bidder to do the work
    this.balance.subInPlace(this.lowestBid);
    Party.createUnsigned(this.winner).balance.addInPlace(this.lowestBid);

    return { lowestBid: this.lowestBid.toString(), winner: this.winner };
  }
}

// setup
const Local = Mina.LocalBlockchain();
Mina.setActiveInstance(Local);

const generateDummyBidders = async () => {
  const bidders = [];
  for (let index = 5; index < 10; index++) {
    bidders.push(Local.testAccounts[index]);
    const account = await Mina.getAccount(Local.testAccounts[index].publicKey);
    bidders[bidders.length - 1].initialBalance = bidders[
      bidders.length - 1
    ].currentBalance = account.balance.toString();
    console.log(
      `Bidder ${bidders.length} initial balance`,
      account.balance.toString()
    );
  }
  bidders[0].name = 'Tim Burgess';
  bidders[1].name = 'Emily Poole';
  bidders[2].name = 'Jack Campbell';
  bidders[3].name = 'Amelia Smith';
  bidders[4].name = 'Megan Carr';

  return bidders;
};

const updateBiddersBalances = async (bidders) => {
  for (let index = 0; index < bidders.length; index++) {
    const account = await Mina.getAccount(bidders[index].publicKey);
    bidders[index].currentBalance = account.balance.toString();
  }

  return bidders.map((bidder) => bidder);
};

let snappInstance: SealedBidAuctionSnapp;
let isDeploying = false;
let snappAddress: PublicKey;
let snappPrivkey: PrivateKey;

async function deploy(
  bidders: Array<PublicKey>,
  participationCost: number,
  bidThreshold: number
) {
  if (isDeploying) return;
  isDeploying = true;

  const deployer = Local.testAccounts[0].privateKey;
  const deploymentPayer = Local.testAccounts[1].privateKey;

  snappPrivkey = PrivateKey.random();
  snappAddress = snappPrivkey.toPublicKey();

  try {
    let tx = Mina.transaction(deployer, async () => {
      console.log('Deploying snapp instance...');
      const initialBalance = UInt64.fromNumber(1000000000);
      const p = await Party.createSigned(deploymentPayer);
      p.balance.subInPlace(initialBalance);
      snappInstance = new SealedBidAuctionSnapp(
        snappAddress,
        initialBalance,
        bidders,
        participationCost,
        UInt64.fromNumber(bidThreshold)
      );
    });
    await tx.send().wait();
  } catch (err) {
    console.log('Error happened deploying!', err);
  }

  isDeploying = false;
}

async function bid(account: PrivateKey, amount: number) {
  const accoutnBalance = (
    await Mina.getAccount(account.toPublicKey())
  ).balance.toString();
  console.log(accoutnBalance);

  let tx = Mina.transaction(account, async () => {
    console.log('bidding...');
    await snappInstance.bid(UInt64.fromNumber(amount));
  });
  try {
    await tx.send().wait();
  } catch (err) {
    console.log('amount', amount);
    console.log('Error happened when trying to bid!', err);
  }
}

async function revealWinner() {
  let lowestBid, winner;
  let tx = Mina.transaction(snappPrivkey, async () => {
    ({ lowestBid, winner } = await snappInstance.revealWinner());
    console.log('Lowest bid', lowestBid.toString());
    console.log('Winner', winner);
  });
  try {
    await tx.send().wait();
  } catch (err) {
    console.log('Error happened when trying to reveal the winner!', err);
  }
  return { lowestBid, winner };
}
