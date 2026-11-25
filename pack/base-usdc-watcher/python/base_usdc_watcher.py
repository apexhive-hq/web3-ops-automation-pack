import json
import re
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
ERC20_TRANSFER_TOPIC = (
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
)
_ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")
_TX_RE = re.compile(r"^0x[0-9a-f]{64}$")


@dataclass(frozen=True)
class BaseUsdcMatch:
    tx_hash: str
    rpc_url: str
    sender: str
    recipient: str
    amount_atomic: int
    confirmations: int
    block_number: int


def _default_post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def rpc_call_with_failover(
    rpc_urls: list[str],
    method: str,
    params: list[Any],
    post_json: Callable[[str, dict[str, Any]], dict[str, Any]] = _default_post_json,
) -> tuple[Any, str]:
    if not rpc_urls:
        raise ValueError("At least one RPC URL is required")
    errors: list[str] = []
    for url in rpc_urls:
        try:
            body = post_json(
                url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
            )
            if "error" in body and body["error"]:
                errors.append(f"{url}: {body['error']}")
                continue
            return body.get("result"), url
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{url}: {exc}")
    raise RuntimeError(f"All RPC endpoints failed ({'; '.join(errors)})")


def find_matching_base_usdc_transfer(
    receipt: dict[str, Any],
    expected_recipient: str,
    min_amount_atomic: int,
    usdc_contract: str = BASE_MAINNET_USDC,
) -> Optional[tuple[str, str, int]]:
    if receipt.get("status") != "0x1":
        return None
    target_recipient = expected_recipient.strip().lower()
    target_token = usdc_contract.strip().lower()
    if not _ADDR_RE.match(target_recipient) or not _ADDR_RE.match(target_token):
        raise ValueError("Invalid EVM address")

    for log in receipt.get("logs", []):
        if str(log.get("address", "")).lower() != target_token:
            continue
        topics = log.get("topics", [])
        if len(topics) < 3 or str(topics[0]).lower() != ERC20_TRANSFER_TOPIC:
            continue
        sender = f"0x{str(topics[1])[-40:].lower()}"
        recipient = f"0x{str(topics[2])[-40:].lower()}"
        if recipient != target_recipient:
            continue
        amount_atomic = int(str(log.get("data", "0x0")), 16)
        if amount_atomic >= min_amount_atomic:
            return sender, recipient, amount_atomic
    return None


def verify_base_usdc_payment(
    tx_hash: str,
    expected_recipient: str,
    min_amount_atomic: int,
    rpc_urls: list[str],
    usdc_contract: str = BASE_MAINNET_USDC,
    min_confirmations: int = 2,
    post_json: Callable[[str, dict[str, Any]], dict[str, Any]] = _default_post_json,
) -> BaseUsdcMatch:
    clean_tx = tx_hash.strip().lower()
    if not _TX_RE.match(clean_tx):
        raise ValueError("Invalid tx_hash format")

    receipt, active_url = rpc_call_with_failover(
        rpc_urls, "eth_getTransactionReceipt", [clean_tx], post_json=post_json
    )
    if not receipt:
        raise ValueError("Transaction receipt not found")
    if receipt.get("status") != "0x1":
        raise ValueError("Transaction reverted on-chain")

    ordered_urls = [active_url] + [u for u in rpc_urls if u != active_url]
    latest_hex, _ = rpc_call_with_failover(
        ordered_urls, "eth_blockNumber", [], post_json=post_json
    )
    tx_block = int(str(receipt["blockNumber"]), 16)
    latest_block = int(str(latest_hex), 16)
    confirmations = max(0, latest_block - tx_block + 1)
    if confirmations < min_confirmations:
        raise ValueError(
            f"Insufficient confirmations: {confirmations} < {min_confirmations}"
        )

    matched = find_matching_base_usdc_transfer(
        receipt, expected_recipient, min_amount_atomic, usdc_contract
    )
    if not matched:
        raise ValueError("No matching Base USDC Transfer log found")

    sender, recipient, amount_atomic = matched
    return BaseUsdcMatch(
        tx_hash=clean_tx,
        rpc_url=active_url,
        sender=sender,
        recipient=recipient,
        amount_atomic=amount_atomic,
        confirmations=confirmations,
        block_number=tx_block,
    )
