import json
import re
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
ERC20_TRANSFER_TOPIC = (
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
)
DEFAULT_RPC_TIMEOUT_SECONDS = 10.0

_ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")
_TX_RE = re.compile(r"^0x[0-9a-f]{64}$")
_HEX_QTY_RE = re.compile(r"^0x[0-9a-fA-F]+$")
_TOPIC_WORD_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


@dataclass(frozen=True)
class BaseUsdcMatch:
    tx_hash: str
    rpc_url: str
    sender: Optional[str]
    senders: tuple[str, ...]
    transfers: tuple[tuple[str, int], ...]
    recipient: str
    amount_atomic: int
    confirmations: int
    block_number: int


def _normalize_address(addr: str) -> str:
    if not isinstance(addr, str) or not addr.strip():
        raise ValueError("Expected non-empty EVM address")
    clean = addr.strip().lower()
    if not _ADDR_RE.match(clean):
        raise ValueError(f"Invalid EVM address: {addr}")
    return clean


def require_non_empty_recipient(addr: str) -> str:
    if not isinstance(addr, str) or not addr.strip():
        raise ValueError("Expected non-empty EVM recipient address")
    return _normalize_address(addr)


def parse_strict_hex_int(value: Any, label: str) -> int:
    if not isinstance(value, str):
        raise ValueError(f"Invalid {label}: expected hex string")
    trimmed = value.strip()
    if not _HEX_QTY_RE.match(trimmed):
        raise ValueError(f"Invalid {label} hex quantity: {value}")
    return int(trimmed, 16)


def _default_post_json(
    url: str, payload: dict[str, Any], timeout_seconds: float = DEFAULT_RPC_TIMEOUT_SECONDS
) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        return json.loads(resp.read().decode("utf-8"))


def rpc_call_with_failover(
    rpc_urls: list[str],
    method: str,
    params: list[Any],
    post_json: Optional[Callable[[str, dict[str, Any]], dict[str, Any]]] = None,
    timeout_seconds: float = DEFAULT_RPC_TIMEOUT_SECONDS,
    accept_result: Optional[Callable[[Any], bool]] = None,
) -> tuple[Any, str]:
    if not rpc_urls:
        raise ValueError("At least one RPC URL is required")
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or timeout_seconds <= 0
    ):
        raise ValueError("timeout_seconds must be a positive number")

    caller = post_json or (
        lambda url, payload: _default_post_json(
            url, payload, timeout_seconds=timeout_seconds
        )
    )
    errors: list[str] = []
    for url in rpc_urls:
        if not isinstance(url, str) or not url.strip():
            errors.append("<empty>: invalid RPC URL")
            continue
        try:
            body = caller(
                url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
            )
            if "error" in body and body["error"]:
                errors.append(f"{url}: {body['error']}")
                continue
            result = body.get("result")
            if accept_result is not None and not accept_result(result):
                errors.append(f"{url}: rejected empty or invalid result")
                continue
            return result, url
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{url}: {exc}")
    raise RuntimeError(f"All RPC endpoints failed ({'; '.join(errors)})")


def find_matching_base_usdc_transfer(
    receipt: dict[str, Any],
    expected_recipient: str,
    min_amount_atomic: int,
    usdc_contract: str = BASE_MAINNET_USDC,
    expected_sender: Optional[str] = None,
) -> Optional[tuple[Optional[str], str, int, tuple[str, ...], tuple[tuple[str, int], ...]]]:
    if not isinstance(receipt, dict) or str(receipt.get("status", "")).lower() != "0x1":
        return None
    if isinstance(min_amount_atomic, bool) or not isinstance(min_amount_atomic, int) or min_amount_atomic <= 0:
        raise ValueError("min_amount_atomic must be a positive integer")

    target_recipient = require_non_empty_recipient(expected_recipient)
    target_token = _normalize_address(usdc_contract)
    target_sender = _normalize_address(expected_sender) if expected_sender is not None else None

    total_amount_atomic = 0
    senders_ordered: list[str] = []
    seen_senders: set[str] = set()
    transfers: list[tuple[str, int]] = []

    for log in receipt.get("logs", []):
        if not isinstance(log, dict):
            continue
        if str(log.get("address", "")).strip().lower() != target_token:
            continue
        topics = log.get("topics", [])
        if (
            not isinstance(topics, list)
            or len(topics) < 3
            or str(topics[0]).lower() != ERC20_TRANSFER_TOPIC
        ):
            continue
        if not isinstance(topics[1], str) or not isinstance(topics[2], str):
            raise ValueError("Malformed ERC-20 Transfer topic in matching token log")
        if not _TOPIC_WORD_RE.match(topics[1]) or not _TOPIC_WORD_RE.match(topics[2]):
            raise ValueError("Malformed ERC-20 Transfer topic in matching token log")

        sender = f"0x{topics[1][-40:].lower()}"
        recipient = f"0x{topics[2][-40:].lower()}"
        if recipient != target_recipient:
            continue
        if target_sender is not None and sender != target_sender:
            continue

        amount_atomic = parse_strict_hex_int(log.get("data"), "Transfer log data")
        total_amount_atomic += amount_atomic
        transfers.append((sender, amount_atomic))
        if sender not in seen_senders:
            seen_senders.add(sender)
            senders_ordered.append(sender)

    if not transfers or total_amount_atomic < min_amount_atomic:
        return None
    single_sender = senders_ordered[0] if len(senders_ordered) == 1 else None
    return (
        single_sender,
        target_recipient,
        total_amount_atomic,
        tuple(senders_ordered),
        tuple(transfers),
    )


def verify_base_usdc_payment(
    tx_hash: str,
    expected_recipient: str,
    min_amount_atomic: int,
    rpc_urls: list[str],
    usdc_contract: str = BASE_MAINNET_USDC,
    min_confirmations: int = 2,
    timeout_seconds: float = DEFAULT_RPC_TIMEOUT_SECONDS,
    post_json: Optional[Callable[[str, dict[str, Any]], dict[str, Any]]] = None,
    expected_sender: Optional[str] = None,
) -> BaseUsdcMatch:
    clean_tx = tx_hash.strip().lower() if isinstance(tx_hash, str) else ""
    if not _TX_RE.match(clean_tx):
        raise ValueError("Invalid tx_hash format")

    target_recipient = require_non_empty_recipient(expected_recipient)
    target_token = _normalize_address(usdc_contract)
    if expected_sender is not None:
        _normalize_address(expected_sender)
    if isinstance(min_amount_atomic, bool) or not isinstance(min_amount_atomic, int) or min_amount_atomic <= 0:
        raise ValueError("min_amount_atomic must be a positive integer")
    if isinstance(min_confirmations, bool) or not isinstance(min_confirmations, int) or min_confirmations < 1:
        raise ValueError("min_confirmations must be a positive integer >= 1")

    receipt, active_url = rpc_call_with_failover(
        rpc_urls,
        "eth_getTransactionReceipt",
        [clean_tx],
        post_json=post_json,
        timeout_seconds=timeout_seconds,
        accept_result=lambda r: isinstance(r, dict),
    )
    if not receipt:
        raise ValueError("Transaction receipt not found")
    if str(receipt.get("status", "")).lower() != "0x1":
        raise ValueError("Transaction reverted on-chain")

    tx_block = parse_strict_hex_int(receipt.get("blockNumber"), "receipt.blockNumber")

    ordered_urls = [active_url] + [u for u in rpc_urls if u != active_url]
    latest_hex, _ = rpc_call_with_failover(
        ordered_urls,
        "eth_blockNumber",
        [],
        post_json=post_json,
        timeout_seconds=timeout_seconds,
        accept_result=lambda v: isinstance(v, str) and bool(_HEX_QTY_RE.match(v.strip())),
    )
    latest_block = parse_strict_hex_int(latest_hex, "eth_blockNumber")
    if latest_block < tx_block:
        raise ValueError(
            f"Insufficient confirmations: receipt block {tx_block} ahead of latest block {latest_block}"
        )
    confirmations = latest_block - tx_block + 1
    if confirmations < min_confirmations:
        raise ValueError(
            f"Insufficient confirmations: {confirmations} < {min_confirmations}"
        )

    matched = find_matching_base_usdc_transfer(
        receipt,
        target_recipient,
        min_amount_atomic,
        target_token,
        expected_sender=expected_sender,
    )
    if not matched:
        raise ValueError("No matching Base USDC Transfer log found")

    sender, recipient, amount_atomic, senders, transfers = matched
    return BaseUsdcMatch(
        tx_hash=clean_tx,
        rpc_url=active_url,
        sender=sender,
        senders=senders,
        transfers=transfers,
        recipient=recipient,
        amount_atomic=amount_atomic,
        confirmations=confirmations,
        block_number=tx_block,
    )
