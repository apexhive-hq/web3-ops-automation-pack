import http.server
import json
import threading
import time
import unittest
from solana_usdc_verifier import (
    SOLANA_MAINNET_USDC_MINT,
    compute_solana_replay_key,
    decode_base58,
    encode_base58,
    match_solana_usdc_reference_transfer,
    verify_solana_usdc_payment,
)

SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
VAULT = "4UyTxvrcqtYEsm5LQuiD5ofEJ4bMk6XJqv6G4St3GC9F"
REF_KEY = "RefKey11111111111111111111111111111111111111"
REF_KEY_2 = "RefKey22222222222222222222222222222222222222"
OTHER_KEY = "OtherKey111111111111111111111111111111111111"
ATTACKER_ATA = "AttackerAta111111111111111111111111111111111"
SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"

VALID_TRANSFER_CHECKED_DATA = encode_base58(
    bytes([12]) + (10_000_000).to_bytes(8, "little") + bytes([6])
)
ZERO_TRANSFER_CHECKED_DATA = encode_base58(
    bytes([12]) + (0).to_bytes(8, "little") + bytes([6])
)
VALID_TRANSFER_DATA = encode_base58(bytes([3]) + (10_000_000).to_bytes(8, "little"))


def _make_tx(
    account_keys=None,
    num_required_signatures=1,
    instructions=None,
    loaded_addresses=None,
    pre=None,
    post=None,
    omit_instructions=False,
):
    message: dict = {
        "header": {"numRequiredSignatures": num_required_signatures},
        "accountKeys": account_keys
        if account_keys is not None
        else [
            "Payer111111111111111111111111111111111111111",
            "SourceAta11111111111111111111111111111111111",
            "DestAta1111111111111111111111111111111111111",
            SOLANA_MAINNET_USDC_MINT,
            VAULT,
            SPL_TOKEN_PROGRAM,
            REF_KEY,
        ],
    }
    if not omit_instructions:
        message["instructions"] = (
            instructions
            if instructions is not None
            else [
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 2, 0, 6],
                    "data": VALID_TRANSFER_CHECKED_DATA,
                }
            ]
        )
    return {
        "slot": 310000001,
        "transaction": {"message": message},
        "meta": {
            "err": None,
            "loadedAddresses": loaded_addresses,
            "preTokenBalances": pre
            if pre is not None
            else [
                {
                    "accountIndex": 2,
                    "mint": SOLANA_MAINNET_USDC_MINT,
                    "owner": VAULT,
                    "uiTokenAmount": {"amount": "1000000", "decimals": 6},
                }
            ],
            "postTokenBalances": post
            if post is not None
            else [
                {
                    "accountIndex": 2,
                    "mint": SOLANA_MAINNET_USDC_MINT,
                    "owner": VAULT,
                    "uiTokenAmount": {"amount": "11000000", "decimals": 6},
                }
            ],
        },
    }


class TestSolanaUsdcVerifier(unittest.TestCase):
    def test_canonical_base58_leading_zero(self) -> None:
        self.assertEqual(decode_base58("1"), b"\x00")
        self.assertEqual(decode_base58("11"), b"\x00\x00")
        self.assertEqual(encode_base58(b"\x00"), "1")
        self.assertEqual(encode_base58(b"\x00\x00"), "11")

    def test_encoding_json_finalized_and_null_rpc_failover(self) -> None:
        seen_params: list[dict] = []

        def fake_post(url: str, payload: dict) -> dict:
            seen_params.append(payload["params"][1])
            if "lagging" in url:
                return {"jsonrpc": "2.0", "id": 1, "result": None}
            return {"jsonrpc": "2.0", "id": 1, "result": _make_tx()}

        res = verify_solana_usdc_payment(
            signature=SIG,
            expected_recipient_owner=VAULT,
            expected_reference_key=REF_KEY,
            min_amount_atomic=10_000_000,
            rpc_urls=["https://lagging-solana.local", "https://mock-solana.local"],
            post_json=fake_post,
        )
        self.assertEqual(res.amount_atomic, 10_000_000)
        self.assertEqual(res.rpc_url, "https://mock-solana.local")
        self.assertEqual(res.replay_key, compute_solana_replay_key(SIG))
        self.assertEqual(len(seen_params), 2)
        self.assertEqual(seen_params[0]["encoding"], "json")
        self.assertEqual(seen_params[0]["commitment"], "finalized")
        self.assertEqual(seen_params[1]["encoding"], "json")
        self.assertEqual(seen_params[1]["commitment"], "finalized")

    def test_fail_closed_decoy_wrong_dest_empty_ix_and_cross_invoice_replay(self) -> None:
        # Empty / missing instructions MUST fail-closed
        self.assertIsNone(
            match_solana_usdc_reference_transfer(
                _make_tx(instructions=[]), VAULT, REF_KEY, 10_000_000
            )
        )
        self.assertIsNone(
            match_solana_usdc_reference_transfer(
                _make_tx(omit_instructions=True), VAULT, REF_KEY, 10_000_000
            )
        )

        # 0-amount decoy TransferChecked carrying REF_KEY alongside real payment without REF_KEY MUST fail-closed
        zero_decoy_tx = _make_tx(
            instructions=[
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 2, 0],
                    "data": VALID_TRANSFER_CHECKED_DATA,
                },
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 2, 0, 6],
                    "data": ZERO_TRANSFER_CHECKED_DATA,
                },
            ]
        )
        self.assertIsNone(
            match_solana_usdc_reference_transfer(zero_decoy_tx, VAULT, REF_KEY, 10_000_000)
        )

        # Wrong destination ATA carrying REF_KEY alongside real payment without REF_KEY MUST fail-closed
        wrong_dest_tx = _make_tx(
            account_keys=[
                "Payer111111111111111111111111111111111111111",
                "SourceAta11111111111111111111111111111111111",
                "DestAta1111111111111111111111111111111111111",
                SOLANA_MAINNET_USDC_MINT,
                VAULT,
                SPL_TOKEN_PROGRAM,
                REF_KEY,
                ATTACKER_ATA,
            ],
            instructions=[
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 2, 0],
                    "data": VALID_TRANSFER_CHECKED_DATA,
                },
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 7, 0, 6],
                    "data": VALID_TRANSFER_CHECKED_DATA,
                },
            ],
        )
        self.assertIsNone(
            match_solana_usdc_reference_transfer(wrong_dest_tx, VAULT, REF_KEY, 10_000_000)
        )

        # Spoofed reference in Memo instruction while SPL TransferChecked omits REF_KEY MUST fail-closed
        spoofed_tx = _make_tx(
            account_keys=[
                "Payer111111111111111111111111111111111111111",
                "SourceAta11111111111111111111111111111111111",
                "DestAta1111111111111111111111111111111111111",
                SOLANA_MAINNET_USDC_MINT,
                VAULT,
                SPL_TOKEN_PROGRAM,
                MEMO_PROGRAM,
                REF_KEY,
            ],
            instructions=[
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 2, 0],
                    "data": VALID_TRANSFER_CHECKED_DATA,
                },
                {
                    "programIdIndex": 6,
                    "accounts": [7],
                    "data": encode_base58(b"memo"),
                },
            ],
        )
        self.assertIsNone(
            match_solana_usdc_reference_transfer(spoofed_tx, VAULT, REF_KEY, 10_000_000)
        )

        # Signer reference rejected via header.numRequiredSignatures
        self.assertIsNone(
            match_solana_usdc_reference_transfer(
                _make_tx(
                    account_keys=[
                        REF_KEY,
                        "SourceAta11111111111111111111111111111111111",
                        "DestAta1111111111111111111111111111111111111",
                        SOLANA_MAINNET_USDC_MINT,
                        VAULT,
                        SPL_TOKEN_PROGRAM,
                    ],
                    num_required_signatures=1,
                    instructions=[
                        {
                            "programIdIndex": 5,
                            "accounts": [1, 3, 2, 0, 0],
                            "data": VALID_TRANSFER_CHECKED_DATA,
                        }
                    ],
                ),
                VAULT,
                REF_KEY,
                10_000_000,
            )
        )

        # Reference equal to vault or mint is rejected fail-closed
        with self.assertRaises(ValueError):
            match_solana_usdc_reference_transfer(_make_tx(), VAULT, VAULT, 10_000_000)
        with self.assertRaises(ValueError):
            match_solana_usdc_reference_transfer(
                _make_tx(), VAULT, SOLANA_MAINNET_USDC_MINT, 10_000_000
            )

        # SPL Transfer (opcode 3) with valid destination ATA + trailing reference passes
        self.assertEqual(
            match_solana_usdc_reference_transfer(
                _make_tx(
                    instructions=[
                        {
                            "programIdIndex": 5,
                            "accounts": [1, 2, 0, 6],
                            "data": VALID_TRANSFER_DATA,
                        }
                    ]
                ),
                VAULT,
                REF_KEY,
                10_000_000,
            ),
            10_000_000,
        )

        # v0 loadedAddresses matches reference in TransferChecked
        v0_tx = _make_tx(
            account_keys=[
                "Payer111111111111111111111111111111111111111",
                "SourceAta11111111111111111111111111111111111",
                "DestAta1111111111111111111111111111111111111",
                SOLANA_MAINNET_USDC_MINT,
                VAULT,
                SPL_TOKEN_PROGRAM,
            ],
            loaded_addresses={"writable": [], "readonly": [REF_KEY]},
            instructions=[
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 2, 0, 6],
                    "data": VALID_TRANSFER_CHECKED_DATA,
                }
            ],
        )
        self.assertEqual(
            match_solana_usdc_reference_transfer(v0_tx, VAULT, REF_KEY, 10_000_000),
            10_000_000,
        )

        # Cross-invoice double-spend prevention: dual-reference tx yields identical tx-scoped replay_key
        dual_tx = _make_tx(
            account_keys=[
                "Payer111111111111111111111111111111111111111",
                "SourceAta11111111111111111111111111111111111",
                "DestAta1111111111111111111111111111111111111",
                SOLANA_MAINNET_USDC_MINT,
                VAULT,
                SPL_TOKEN_PROGRAM,
                REF_KEY,
                REF_KEY_2,
            ],
            instructions=[
                {
                    "programIdIndex": 5,
                    "accounts": [1, 3, 2, 0, 6, 7],
                    "data": VALID_TRANSFER_CHECKED_DATA,
                }
            ],
        )
        m1 = verify_solana_usdc_payment(
            SIG,
            VAULT,
            REF_KEY,
            10_000_000,
            ["https://mock-solana.local"],
            post_json=lambda _u, _p: {"jsonrpc": "2.0", "id": 1, "result": dual_tx},
        )
        m2 = verify_solana_usdc_payment(
            SIG,
            VAULT,
            REF_KEY_2,
            10_000_000,
            ["https://mock-solana.local"],
            post_json=lambda _u, _p: {"jsonrpc": "2.0", "id": 1, "result": dual_tx},
        )
        self.assertEqual(m1.replay_key, m2.replay_key)

        # Self-transfer between two ATAs of same owner => 0 net delta => rejected
        self_tx = _make_tx(
            pre=[
                {
                    "accountIndex": 2,
                    "mint": SOLANA_MAINNET_USDC_MINT,
                    "owner": VAULT,
                    "uiTokenAmount": {"amount": "20000000", "decimals": 6},
                },
                {
                    "accountIndex": 3,
                    "mint": SOLANA_MAINNET_USDC_MINT,
                    "owner": VAULT,
                    "uiTokenAmount": {"amount": "0", "decimals": 6},
                },
            ],
            post=[
                {
                    "accountIndex": 2,
                    "mint": SOLANA_MAINNET_USDC_MINT,
                    "owner": VAULT,
                    "uiTokenAmount": {"amount": "10000000", "decimals": 6},
                },
                {
                    "accountIndex": 3,
                    "mint": SOLANA_MAINNET_USDC_MINT,
                    "owner": VAULT,
                    "uiTokenAmount": {"amount": "10000000", "decimals": 6},
                },
            ],
        )
        self.assertIsNone(
            match_solana_usdc_reference_transfer(self_tx, VAULT, REF_KEY, 10_000_000)
        )

        # Float atomic string rejected
        float_tx = _make_tx(
            post=[
                {
                    "accountIndex": 2,
                    "mint": SOLANA_MAINNET_USDC_MINT,
                    "owner": VAULT,
                    "uiTokenAmount": {"amount": "10.5", "decimals": 6},
                }
            ]
        )
        with self.assertRaises(ValueError):
            match_solana_usdc_reference_transfer(float_tx, VAULT, REF_KEY, 1)

    def test_http_timeout_failover(self) -> None:
        class SlowHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                time.sleep(0.6)
                self.send_response(200)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                return

        class FastHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                raw = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": _make_tx()}).encode("utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, format: str, *args: object) -> None:
                return

        slow_srv = http.server.HTTPServer(("127.0.0.1", 0), SlowHandler)
        fast_srv = http.server.HTTPServer(("127.0.0.1", 0), FastHandler)
        t1 = threading.Thread(target=slow_srv.serve_forever, daemon=True)
        t2 = threading.Thread(target=fast_srv.serve_forever, daemon=True)
        t1.start()
        t2.start()
        try:
            slow_url = f"http://127.0.0.1:{slow_srv.server_address[1]}"
            fast_url = f"http://127.0.0.1:{fast_srv.server_address[1]}"
            res = verify_solana_usdc_payment(
                signature=SIG,
                expected_recipient_owner=VAULT,
                expected_reference_key=REF_KEY,
                min_amount_atomic=10_000_000,
                rpc_urls=[slow_url, fast_url],
                timeout_seconds=0.2,
            )
            self.assertEqual(res.rpc_url, fast_url)
            self.assertEqual(res.amount_atomic, 10_000_000)
        finally:
            slow_srv.shutdown()
            fast_srv.shutdown()
            slow_srv.server_close()
            fast_srv.server_close()


if __name__ == "__main__":
    unittest.main()
