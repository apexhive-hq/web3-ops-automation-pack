import unittest
from base_usdc_watcher import (
    BASE_MAINNET_USDC,
    ERC20_TRANSFER_TOPIC,
    verify_base_usdc_payment,
)


def _pad_addr(addr: str) -> str:
    return "0x" + addr.lower().replace("0x", "").rjust(64, "0")


def _pad_uint(val: int) -> str:
    return "0x" + hex(val)[2:].rjust(64, "0")


class TestBaseUsdcWatcher(unittest.TestCase):
    def test_failover_and_exact_amount(self) -> None:
        recipient = "0x32eceac45dbed9e555dab80346abd4ab9c676206"
        sender = "0x1111111111111111111111111111111111111111"
        tx_hash = "0x" + "bb" * 32

        def fake_post(url: str, payload: dict) -> dict:
            if "bad-rpc" in url:
                raise ConnectionError("RPC offline")
            if payload["method"] == "eth_blockNumber":
                return {"jsonrpc": "2.0", "id": 1, "result": "0x66"}
            return {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "status": "0x1",
                    "blockNumber": "0x64",
                    "logs": [
                        {
                            "address": BASE_MAINNET_USDC,
                            "topics": [
                                ERC20_TRANSFER_TOPIC,
                                _pad_addr(sender),
                                _pad_addr(recipient),
                            ],
                            "data": _pad_uint(19_000_000),
                        }
                    ],
                },
            }

        res = verify_base_usdc_payment(
            tx_hash=tx_hash,
            expected_recipient=recipient,
            min_amount_atomic=19_000_000,
            rpc_urls=["https://bad-rpc.local", "https://good-rpc.local"],
            post_json=fake_post,
        )
        self.assertEqual(res.amount_atomic, 19_000_000)
        self.assertEqual(res.confirmations, 3)

        with self.assertRaises(ValueError):
            verify_base_usdc_payment(
                tx_hash=tx_hash,
                expected_recipient=recipient,
                min_amount_atomic=39_000_000,
                rpc_urls=["https://good-rpc.local"],
                post_json=fake_post,
            )


if __name__ == "__main__":
    unittest.main()
