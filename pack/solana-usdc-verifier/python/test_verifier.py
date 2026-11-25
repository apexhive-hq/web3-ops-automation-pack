import unittest
from solana_usdc_verifier import SOLANA_MAINNET_USDC_MINT, verify_solana_usdc_payment


class TestSolanaUsdcVerifier(unittest.TestCase):
    def test_matches_reference_and_delta(self) -> None:
        vault = "4UyTxvrcqtYEsm5LQuiD5ofEJ4bMk6XJqv6G4St3GC9F"
        ref_key = "RefKey11111111111111111111111111111111111111"
        sig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"

        def fake_post(_url: str, _payload: dict) -> dict:
            return {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "slot": 310000001,
                    "transaction": {"message": {"accountKeys": ["Payer111", ref_key, vault]}},
                    "meta": {
                        "err": None,
                        "preTokenBalances": [
                            {
                                "accountIndex": 2,
                                "mint": SOLANA_MAINNET_USDC_MINT,
                                "owner": vault,
                                "uiTokenAmount": {"amount": "1000000", "decimals": 6},
                            }
                        ],
                        "postTokenBalances": [
                            {
                                "accountIndex": 2,
                                "mint": SOLANA_MAINNET_USDC_MINT,
                                "owner": vault,
                                "uiTokenAmount": {"amount": "20000000", "decimals": 6},
                            }
                        ],
                    },
                },
            }

        res = verify_solana_usdc_payment(
            signature=sig,
            expected_recipient_owner=vault,
            expected_reference_key=ref_key,
            min_amount_atomic=19_000_000,
            rpc_urls=["https://mock-solana.local"],
            post_json=fake_post,
        )
        self.assertEqual(res.amount_atomic, 19_000_000)


if __name__ == "__main__":
    unittest.main()
