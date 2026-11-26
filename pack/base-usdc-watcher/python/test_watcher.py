import http.server
import json
import threading
import time
import unittest
from base_usdc_watcher import (
    BASE_MAINNET_USDC,
    ERC20_TRANSFER_TOPIC,
    find_matching_base_usdc_transfer,
    parse_strict_hex_int,
    require_non_empty_recipient,
    verify_base_usdc_payment,
)


def _pad_addr(addr: str) -> str:
    return "0x" + addr.lower().replace("0x", "").rjust(64, "0")


def _pad_uint(val: int) -> str:
    return "0x" + hex(val)[2:].rjust(64, "0")


class TestBaseUsdcWatcher(unittest.TestCase):
    def test_failover_and_multi_transfer_sum(self) -> None:
        recipient = "0x2222222222222222222222222222222222222222"
        other = "0x3333333333333333333333333333333333333333"
        sender = "0x1111111111111111111111111111111111111111"
        tx_hash = "0x" + "bb" * 32

        def fake_post(url: str, payload: dict) -> dict:
            if "bad-rpc" in url:
                raise ConnectionError("RPC offline")
            if "lagging-rpc" in url:
                return {"jsonrpc": "2.0", "id": 1, "result": None}
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
                                _pad_addr(other),
                            ],
                            "data": _pad_uint(50_000_000),
                        },
                        {
                            "address": BASE_MAINNET_USDC,
                            "topics": [
                                ERC20_TRANSFER_TOPIC,
                                _pad_addr(sender),
                                _pad_addr(recipient),
                            ],
                            "data": _pad_uint(4_000_000),
                        },
                        {
                            "address": BASE_MAINNET_USDC,
                            "topics": [
                                ERC20_TRANSFER_TOPIC,
                                _pad_addr(sender),
                                _pad_addr(recipient),
                            ],
                            "data": _pad_uint(6_000_000),
                        },
                    ],
                },
            }

        res = verify_base_usdc_payment(
            tx_hash=tx_hash,
            expected_recipient=recipient,
            min_amount_atomic=10_000_000,
            rpc_urls=["https://bad-rpc.local", "https://lagging-rpc.local", "https://good-rpc.local"],
            post_json=fake_post,
        )
        self.assertEqual(res.amount_atomic, 10_000_000)
        self.assertEqual(res.confirmations, 3)
        self.assertEqual(res.sender, sender)
        self.assertEqual(res.senders, (sender,))
        self.assertEqual(res.rpc_url, "https://good-rpc.local")

        with self.assertRaises(ValueError):
            verify_base_usdc_payment(
                tx_hash=tx_hash,
                expected_recipient=recipient,
                min_amount_atomic=25_000_000,
                rpc_urls=["https://good-rpc.local"],
                post_json=fake_post,
            )

    def test_multi_payer_logs_do_not_misattribute_to_first_sender(self) -> None:
        recipient = "0x2222222222222222222222222222222222222222"
        sender_a = "0x1111111111111111111111111111111111111111"
        sender_b = "0x4444444444444444444444444444444444444444"
        receipt = {
            "status": "0x1",
            "blockNumber": "0x64",
            "logs": [
                {
                    "address": BASE_MAINNET_USDC,
                    "topics": [ERC20_TRANSFER_TOPIC, _pad_addr(sender_a), _pad_addr(recipient)],
                    "data": _pad_uint(4_000_000),
                },
                {
                    "address": BASE_MAINNET_USDC,
                    "topics": [ERC20_TRANSFER_TOPIC, _pad_addr(sender_b), _pad_addr(recipient)],
                    "data": _pad_uint(6_000_000),
                },
            ],
        }

        matched = find_matching_base_usdc_transfer(receipt, recipient, 10_000_000)
        self.assertIsNotNone(matched)
        assert matched is not None
        single_sender, _, total_atomic, senders, transfers = matched
        self.assertIsNone(single_sender)
        self.assertEqual(total_atomic, 10_000_000)
        self.assertEqual(senders, (sender_a, sender_b))
        self.assertEqual(transfers, ((sender_a, 4_000_000), (sender_b, 6_000_000)))

        self.assertIsNone(
            find_matching_base_usdc_transfer(
                receipt, recipient, 10_000_000, expected_sender=sender_a
            )
        )

    def test_fail_closed_invalid_blocks_and_empty_recipient(self) -> None:
        recipient = "0x2222222222222222222222222222222222222222"
        sender = "0x1111111111111111111111111111111111111111"
        tx_hash = "0x" + "cc" * 32

        with self.assertRaises(ValueError):
            require_non_empty_recipient("")
        with self.assertRaises(ValueError):
            parse_strict_hex_int("NaN", "blockNumber")
        with self.assertRaises(ValueError):
            parse_strict_hex_int("0x", "blockNumber")
        with self.assertRaises(ValueError):
            find_matching_base_usdc_transfer({"status": "0x1", "logs": []}, "", 10_000_000)

        for bad_block in ("NaN", "", "0xZZ", None):
            def bad_block_post(_url: str, payload: dict, blk=bad_block) -> dict:
                if payload["method"] == "eth_blockNumber":
                    return {"jsonrpc": "2.0", "id": 1, "result": "0x68"}
                return {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "status": "0x1",
                        "blockNumber": blk,
                        "logs": [
                            {
                                "address": BASE_MAINNET_USDC,
                                "topics": [
                                    ERC20_TRANSFER_TOPIC,
                                    _pad_addr(sender),
                                    _pad_addr(recipient),
                                ],
                                "data": _pad_uint(10_000_000),
                            }
                        ],
                    },
                }

            with self.assertRaises(ValueError):
                verify_base_usdc_payment(
                    tx_hash=tx_hash,
                    expected_recipient=recipient,
                    min_amount_atomic=10_000_000,
                    rpc_urls=["https://good-rpc.local"],
                    post_json=bad_block_post,
                )

    def test_http_timeout_failover(self) -> None:
        recipient = "0x2222222222222222222222222222222222222222"
        sender = "0x1111111111111111111111111111111111111111"
        tx_hash = "0x" + "dd" * 32

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
                if body["method"] == "eth_blockNumber":
                    out = {"jsonrpc": "2.0", "id": 1, "result": "0x66"}
                else:
                    out = {
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
                                    "data": _pad_uint(10_000_000),
                                }
                            ],
                        },
                    }
                raw = json.dumps(out).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
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
            res = verify_base_usdc_payment(
                tx_hash=tx_hash,
                expected_recipient=recipient,
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
