#!/usr/bin/env python3
"""End-to-end mainnet test of L1Bridge/L2Bridge: deposit, withdraw, prove and finalize, in minutes instead of 7 days.

  python3 script/withdrawal_e2e.py <L1 RPC>                      mainnet; prompts for a throwaway burner key
  python3 script/withdrawal_e2e.py --fork <L1 RPC> [Facet RPC]   rehearsal on anvil forks of Ethereum and Facet

Run from contracts/ after `forge build`. Needs Foundry (cast, anvil) and python3; nothing else.

Deploys a separate test instance of the unchanged bridge contracts, then:
 1. L1Bridge(current Rollup); L2Bridge on Facet through the Facet inbox; setL2Bridge
 2. deposit AMOUNT; wait until Facet has minted it
 3. initiateWithdrawal on Facet through the inbox; wait for the MessagePassed event (Facet block W)
 4. a test Rollup with the current Rollup's program and verifier but a 60-second challenge window, starting at Facet
    block W-1 (output root computed from the Facet RPC), proposal interval 1; the test L1Bridge is pointed at it
    with setRollup (the test bridge keeps its owner; the production bridge renounces it)
 5. propose the output root of block W, wait 60 seconds, resolve
 6. proveWithdrawal with the output root proof and the storage proof of the withdrawal in L2ToL1MessagePasser, then
    finalizeWithdrawal; the bridge pays AMOUNT back
Everything except the Rollup's challenge window and the setRollup call is what the production bridge does.
"""
import getpass, json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "out")
LIVE_ROLLUP = "0x026902EF5a0931F25cbB78b5dd7a72EE998569AE"
INBOX = "0x00000000000000000000000000000000000FacE7"
MESSAGE_PASSER = "0x4200000000000000000000000000000000000016"
ALIAS_OFFSET = 0x1111000000000000000000000000000000001111
AMOUNT = int(os.environ.get("AMOUNT_WEI", 10 ** 15))           # 0.001 ETH
CHALLENGE_SECS = 60
TOKEN = ("No Admin Ether (e2e test)", "naETH-test")
GAS_TOTAL = 6_000_000                                            # all L1 transactions of the test (5.7M on a fork)
PRIORITY_GWEI = os.environ.get("PRIORITY_GWEI", "0.01")
FORK_BURNER = "0x00000000000000000000000000000000E2e0e2E0"
WAIT_FACET_SECS = 20 * 60


class Chain:
    def __init__(self, l1, facet, fork):
        self.l1, self.facet, self.fork = l1, facet, fork
        self.key = None

    def rpc(self, url, method, params):
        r = json.load(urllib.request.urlopen(urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                                                    {"Content-Type": "application/json", "User-Agent": "e2e"}), timeout=120))
        if "error" in r: raise RuntimeError(r["error"])
        return r["result"]

    def cast(self, *args):
        out = subprocess.run(["cast", *args], capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError(f"cast {args[0]} exit {out.returncode}: {(out.stderr.strip() or out.stdout.strip() or '(no output)')[-600:]}")
        return out.stdout.strip()

    def call(self, url, to, sig, *args):
        return self.cast("call", to, sig, *args, "--rpc-url", url)

    def nonce(self, url, who, tag):
        return int(self.rpc(url, "eth_getTransactionCount", [who, tag]), 16)

    def mined_tx(self, url, frm, nonce, blocks=40):
        """Receipt of the transaction from `frm` with `nonce` among the latest `blocks` blocks, or None."""
        head = int(self.rpc(url, "eth_blockNumber", []), 16)
        for n in range(head, head - blocks, -1):
            for tx in self.rpc(url, "eth_getBlockByNumber", [hex(n), True])["transactions"]:
                if tx["from"].lower() == frm.lower() and int(tx["nonce"], 16) == nonce:
                    return self.rpc(url, "eth_getTransactionReceipt", [tx["hash"]])
        return None

    def send(self, url, frm, to, sig_or_data, *args, value=0, gas=None):
        # explicit fees (max fee = 2 x base fee + tip), so cast does not call eth_feeHistory, which load-balanced RPCs
        # sometimes reject ("request beyond head block")
        tip = int(float(PRIORITY_GWEI) * 1e9)
        base = int(self.rpc(url, "eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
        cmd = ["send", "--rpc-url", url, "--json", "--value", str(value), "--gas-price", str(2 * base + tip), "--priority-gas-price", str(tip)]
        if gas: cmd += ["--gas-limit", str(gas)]
        cmd += ["--unlocked", "--from", frm] if self.fork else ["--private-key", self.key]
        cmd += (["--create", sig_or_data] if to is None else [to, sig_or_data]) + list(args)
        if self.fork:
            rc = json.loads(self.cast(*cmd))
        else:
            # cast can fail without the transaction failing (RPC hiccup, receipt timeout): look at the nonce before resending
            n0 = self.nonce(url, frm, "pending")
            rc = None
            for attempt in range(4):
                try:
                    rc = json.loads(self.cast(*cmd)); break
                except RuntimeError as e:
                    print(f"   {e}; checking the chain", flush=True)
                for _ in range(25):                       # up to 10 minutes for a transaction already sent
                    time.sleep(24)
                    if self.nonce(url, frm, "latest") > n0:
                        rc = self.mined_tx(url, frm, n0)
                        if rc is None: raise RuntimeError(f"nonce {n0} was used but its transaction was not found")
                        break
                    if self.nonce(url, frm, "pending") == n0:
                        break                             # not in the mempool: resending is safe
                if rc: break
                print("   not sent; sending again", flush=True)
            if rc is None: raise RuntimeError("transaction not confirmed after 4 attempts")
        if rc["status"] not in ("0x1", 1, "1"): raise RuntimeError(f"transaction failed: {rc.get('transactionHash')}")
        if url == self.l1: self.l1_gas = getattr(self, "l1_gas", 0) + int(str(rc["gasUsed"]), 16 if str(rc["gasUsed"]).startswith("0x") else 10)
        return rc


def rlp_bytes(b):
    if len(b) == 1 and b[0] < 0x80: return b
    if len(b) <= 55: return bytes([0x80 + len(b)]) + b
    ln = len(b).to_bytes((len(b).bit_length() + 7) // 8, "big"); return bytes([0xb7 + len(ln)]) + ln + b
def rlp_int(x): return rlp_bytes(x.to_bytes((x.bit_length() + 7) // 8, "big") if x else b"")
def rlp_list(items):
    body = b"".join(items)
    if len(body) <= 55: return bytes([0xc0 + len(body)]) + body
    ln = len(body).to_bytes((len(body).bit_length() + 7) // 8, "big"); return bytes([0xf7 + len(ln)]) + ln + body
def facet_payload(to, gas, data):
    """LibFacet: 0x46 || RLP([0xface7, to, value 0, gasLimit, data, mineBoost ""])."""
    return "0x46" + rlp_list([rlp_int(0xface7), rlp_bytes(bytes.fromhex(to[2:]) if to else b""), rlp_int(0), rlp_int(gas),
                              rlp_bytes(bytes.fromhex(data[2:])), rlp_bytes(b"")]).hex()
def rlp_decode(b):
    def item(i):
        p = b[i]
        if p < 0x80: return b[i:i + 1], i + 1
        if p < 0xb8: return b[i + 1:i + 1 + p - 0x80], i + 1 + p - 0x80
        if p < 0xc0: ln = p - 0xb7; n = int.from_bytes(b[i + 1:i + 1 + ln], "big"); return b[i + 1 + ln:i + 1 + ln + n], i + 1 + ln + n
        if p < 0xf8: n, s = p - 0xc0, i + 1
        else: ln = p - 0xf7; n = int.from_bytes(b[i + 1:i + 1 + ln], "big"); s = i + 1 + ln
        out, j = [], s
        while j < s + n:
            x, j = item(j); out.append(x)
        return out, s + n
    return item(0)[0]
def facet_tx_of_event(data_hex):
    raw = bytes.fromhex(data_hex[2:]); assert raw[0] == 0x46
    _, to, _, gas, data, _ = rlp_decode(raw[1:])
    return "0x" + to.hex(), int.from_bytes(gas, "big"), "0x" + data.hex()


def creation_code(name):
    return json.load(open(os.path.join(OUT, f"{name}.sol", f"{name}.json")))["bytecode"]["object"]


def wait_for(what, check, secs=WAIT_FACET_SECS):
    t0 = time.time()
    while True:
        v = check()
        if v: return v
        if time.time() - t0 > secs: sys.exit(f"timed out waiting for {what}")
        time.sleep(6)


def main():
    args = sys.argv[1:]
    fork = bool(args) and args[0] == "--fork"
    if fork: args = args[1:]
    resume = None
    if "--resume" in args:   # --resume <test L1Bridge> <test L2Bridge> <Facet block of the withdrawal>: continue at step 4
        i = args.index("--resume"); resume = (args[i + 1], args[i + 2], int(args[i + 3])); args = args[:i] + args[i + 4:]
    if not args: sys.exit(__doc__)
    procs = []
    if fork:
        procs = [subprocess.Popen(["anvil", "--fork-url", args[0], "--port", "8570", "--silent"]),
                 subprocess.Popen(["anvil", "--fork-url", args[1] if len(args) > 1 else "https://mainnet.facet.org/", "--port", "8571", "--silent"])]
        c = Chain("http://127.0.0.1:8570", "http://127.0.0.1:8571", True)
        for url in (c.l1, c.facet):
            for _ in range(90):
                try: c.rpc(url, "eth_blockNumber", []); break
                except Exception: time.sleep(1)
        me = FORK_BURNER
        if resume:   # rehearse a mainnet resume: the test bridge's real owner on the L1 fork; Facet is only read
            me = c.call(c.l1, resume[0], "owner()(address)")
            c.facet = args[1] if len(args) > 1 else "https://mainnet.facet.org/"
        for url in ([c.l1] if resume else [c.l1, c.facet]):
            c.rpc(url, "anvil_impersonateAccount", [me]); c.rpc(url, "anvil_setBalance", [me, hex(10 ** 18)])
    else:
        c = Chain(args[0], "https://mainnet.facet.org/", False)
        c.key = getpass.getpass("burner private key (used only for this test): ").strip()
        me = c.cast("wallet", "address", "--private-key", c.key)
    try:
        run(c, me, resume)
    finally:
        for p in procs: p.terminate(); p.wait()


def run(c, me, resume=None):
    l1_start = int(c.rpc(c.l1, "eth_getBalance", [me, "latest"]), 16)
    tip = int(float(PRIORITY_GWEI) * 1e9)
    gas_total, deposit = (3_500_000, 0) if resume else (GAS_TOTAL, AMOUNT)   # resuming: steps 4-6 only, the deposit is made
    # affordable while deposit + gas_total * (1.5 * base fee + tip) fits in the balance; otherwise wait for the base fee to drop
    max_base = ((l1_start - deposit) // gas_total - tip) * 2 // 3
    if os.environ.get("MAX_BASE_GWEI"): max_base = min(max_base, int(float(os.environ["MAX_BASE_GWEI"]) * 1e9))
    print(f"burner {me}: {l1_start / 1e18:.6f} ETH on L1 ({'fork' if c.fork else 'mainnet'}); runs while the base fee is at most "
          f"{max_base / 1e9:.3f} gwei ({AMOUNT / 1e18} ETH of the balance comes back)")
    if max_base < 3 * 10 ** 8: sys.exit("not enough ETH on the burner even at a 0.3 gwei base fee")
    while True:
        base = int(c.rpc(c.l1, "eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
        if base <= max_base: break
        print(f"   {time.strftime('%H:%M:%S')} base fee {base / 1e9:.3f} gwei: waiting (Ctrl-C to stop)", flush=True)
        time.sleep(60)
    print(f"base fee {base / 1e9:.3f} gwei: starting", flush=True)

    def facet_send(to, gas, data):
        """A Facet transaction from the burner: through the inbox on mainnet; replayed on the Facet fork when rehearsing."""
        if c.fork: return c.send(c.facet, me, to, data, gas=gas) if to else c.send(c.facet, me, None, data, gas=gas)
        return c.send(c.l1, me, INBOX, facet_payload(to, gas, data))

    topic = c.cast("keccak", "MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)")
    if resume:
        l1b, l2b, W = resume
        assert c.call(c.l1, l1b, "owner()(address)").lower() == me.lower(), "the burner does not own this test bridge"
        assert c.call(c.l1, l1b, "l2Bridge()(address)").lower() == l2b.lower()
        logs = c.rpc(c.facet, "eth_getLogs", [{"address": MESSAGE_PASSER, "fromBlock": hex(W), "toBlock": hex(W),
                                               "topics": [topic, None, "0x" + "00" * 12 + l2b[2:].lower()]}])
        assert len(logs) == 1, f"{len(logs)} withdrawals from {l2b} in Facet block {W}"
        log = logs[0]
        print(f"resuming at step 4: test L1Bridge {l1b}, L2Bridge {l2b}, withdrawal in Facet block {W}")
    else:
        l1b, l2b, log = steps_1_to_3(c, me, facet_send, topic)
        W = int(log["blockNumber"], 16)
    wnonce = int(log["topics"][1], 16)
    whash = "0x" + log["data"][2 + 64 * 3:2 + 64 * 4]
    expect = c.cast("keccak", c.cast("abi-encode", "f(uint256,address,address,uint256,uint256,bytes)", str(wnonce), l2b, l1b, "0", "0",
                                    c.cast("abi-encode", "f(address,uint256)", me, str(AMOUNT))))
    assert whash == expect, f"withdrawal hash {whash} != {expect}"
    print(f"3. withdrawal on Facet block {W}: nonce {wnonce}, hash {whash[:12]}…")
    steps_4_to_6(c, me, l1b, W, wnonce, whash, l1_start)


def steps_1_to_3(c, me, facet_send, topic):
    # 1. bridges
    l1b = c.send(c.l1, me, None, creation_code("L1Bridge") + c.cast("abi-encode", "f(address)", LIVE_ROLLUP)[2:])["contractAddress"]
    nonce = int(c.rpc(c.facet, "eth_getTransactionCount", [me, "latest"]), 16)
    l2b = c.cast("compute-address", me, "--nonce", str(nonce)).split()[-1]
    init = creation_code("L2Bridge") + c.cast("abi-encode", "f(string,string,address)", TOKEN[0], TOKEN[1], l1b)[2:]
    facet_send(None, 20_000_000, init)
    wait_for("L2Bridge on Facet", lambda: c.rpc(c.facet, "eth_getCode", [l2b, "latest"]) not in ("0x", "0x0"))
    assert c.call(c.facet, l2b, "l1Bridge()(address)").lower() == l1b.lower()
    c.send(c.l1, me, l1b, "setL2Bridge(address)", l2b)
    print(f"1. L1Bridge {l1b}; L2Bridge {l2b} on Facet; linked")

    # 2. deposit
    rc = c.send(c.l1, me, l1b, "initiateDeposit(address)", me, value=AMOUNT)
    if c.fork:
        ev = [l for l in rc["logs"] if l["topics"][0] == "0x" + "00" * 29 + "0face7" and l["address"].lower() == l1b.lower()][0]
        to, gas, data = facet_tx_of_event(ev["data"])
        alias = "0x" + ((int(l1b, 16) + ALIAS_OFFSET) % 2 ** 160).to_bytes(20, "big").hex()
        c.rpc(c.facet, "anvil_impersonateAccount", [alias]); c.rpc(c.facet, "anvil_setBalance", [alias, hex(10 ** 18)])
        c.send(c.facet, alias, to, data, gas=gas)
    bal = lambda: int(c.call(c.facet, l2b, "balanceOf(address)(uint256)", me).split()[0])
    wait_for("the deposit on Facet", lambda: bal() == AMOUNT)
    print(f"2. deposited {AMOUNT / 1e18} ETH; minted on Facet")

    # 3. withdrawal on Facet
    from_block = int(c.rpc(c.facet, "eth_blockNumber", []), 16)
    facet_send(l2b, 500_000, c.cast("calldata", "initiateWithdrawal(address,uint256)", me, str(AMOUNT)))
    sender_topic = "0x" + "00" * 12 + l2b[2:].lower()

    def find():
        logs = c.rpc(c.facet, "eth_getLogs", [{"address": MESSAGE_PASSER, "fromBlock": hex(from_block), "toBlock": "latest", "topics": [topic, None, sender_topic]}])
        return logs[-1] if logs else None
    log = wait_for("the withdrawal on Facet", find)
    assert bal() == 0
    return l1b, l2b, log


def steps_4_to_6(c, me, l1b, W, wnonce, whash, l1_start):
    # 4. test Rollup from block W-1, pointed to by the test bridge
    def block(n): return c.rpc(c.facet, "eth_getBlockByNumber", [hex(n), False])
    def mp_root(n): return c.rpc(c.facet, "eth_getProof", [MESSAGE_PASSER, [], hex(n)])["storageHash"]
    def output_root(n):
        b = block(n)
        return c.cast("keccak", c.cast("abi-encode", "f(bytes32,bytes32,bytes32,bytes32)", "0x" + "00" * 32, b["stateRoot"], mp_root(n), b["hash"]))
    live = {f: c.call(c.l1, LIVE_ROLLUP, f"{f}()(bytes32)") for f in ("ROLLUP_CONFIG_HASH", "AGG_VKEY", "RANGE_VKEY_COMMITMENT")}
    verifier = c.call(c.l1, LIVE_ROLLUP, "VERIFIER()(address)")
    S = W - 1
    args = [str(CHALLENGE_SECS), str(CHALLENGE_SECS), str(10 ** 18), "0", str(14 * 86400), "1", output_root(S), str(S), str(int(block(S)["timestamp"], 16)),
            "12", verifier, live["ROLLUP_CONFIG_HASH"], live["AGG_VKEY"], live["RANGE_VKEY_COMMITMENT"]]
    enc = c.cast("abi-encode", "f(uint256,uint256,uint256,uint256,uint256,uint256,bytes32,uint256,uint256,uint256,address,bytes32,bytes32,bytes32)", *args)
    rollup = c.send(c.l1, me, None, creation_code("Rollup") + enc[2:])["contractAddress"]
    c.send(c.l1, me, rollup, "setProposer(address,bool)", me, "true")
    c.send(c.l1, me, l1b, "setRollup(address)", rollup)
    print(f"4. test Rollup {rollup} (challenge {CHALLENGE_SECS}s, start block {S}); test bridge pointed at it")

    # 5. propose block W, wait out the challenge window, resolve
    if c.fork: c.rpc(c.l1, "evm_increaseTime", [120]); c.rpc(c.l1, "evm_mine", [])
    root_w = output_root(W)
    c.send(c.l1, me, rollup, "submitProposal(bytes32,uint256,uint256)", root_w, str(W), "0")
    deadline = int(c.call(c.l1, rollup, "getProposal(uint256)((bytes32,address,uint32,uint32,uint32,uint32,uint8,uint8,address,address))", "1").strip("()").split(", ")[4].split()[0])
    if c.fork: c.rpc(c.l1, "evm_increaseTime", [CHALLENGE_SECS + 5]); c.rpc(c.l1, "evm_mine", [])
    wait_for("the challenge window", lambda: int(c.rpc(c.l1, "eth_getBlockByNumber", ["latest", False])["timestamp"], 16) > deadline, secs=600)
    c.send(c.l1, me, rollup, "resolveProposal(uint256)", "1")
    assert c.call(c.l1, rollup, "proposalIsCanonical(uint256)(bool)", "1") == "true"
    print(f"5. proposed block {W} (root {root_w[:12]}…), resolved after {CHALLENGE_SECS}s; canonical")

    # 6. prove and finalize
    b = block(W)
    slot = c.cast("keccak", c.cast("abi-encode", "f(bytes32,uint256)", whash, "0"))
    pf = c.rpc(c.facet, "eth_getProof", [MESSAGE_PASSER, [slot], hex(W)])
    assert int(pf["storageProof"][0]["value"], 16) == 1, "withdrawal not in the message passer storage"
    root_proof = f"(0x{'00' * 32},{b['stateRoot']},{pf['storageHash']},{b['hash']})"
    c.send(c.l1, me, l1b, "proveWithdrawal(address,uint256,uint256,uint256,(bytes32,bytes32,bytes32,bytes32),bytes[])",
           me, str(AMOUNT), str(wnonce), "1", root_proof, "[" + ",".join(pf["storageProof"][0]["proof"]) + "]")
    if c.fork: c.rpc(c.l1, "evm_mine", [])
    before = int(c.rpc(c.l1, "eth_getBalance", [l1b, "latest"]), 16)
    rc = c.send(c.l1, me, l1b, "finalizeWithdrawal(address,uint256,uint256)", me, str(AMOUNT), str(wnonce))
    after = int(c.rpc(c.l1, "eth_getBalance", [l1b, "latest"]), 16)
    assert before - after == AMOUNT, f"bridge paid {before - after}"
    spent = l1_start - int(c.rpc(c.l1, "eth_getBalance", [me, "latest"]), 16)
    print(f"6. proved and finalized: the bridge paid {AMOUNT / 1e18} ETH back (finalize tx {rc['transactionHash']})")
    print(f"PASS. L1 gas used {c.l1_gas:,}; burner spent {spent / 1e18:.6f} ETH")


if __name__ == "__main__":
    main()
