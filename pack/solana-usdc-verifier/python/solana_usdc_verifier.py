import hashlib
import json
import re
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

SOLANA_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SPL_TOKEN_PROGRAMS = frozenset(
    {
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    }
)
DEFAULT_SOLANA_RPC_TIMEOUT_SECONDS = 10.0

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_MAP = {ch: idx for idx, ch in enumerate(_BASE58_ALPHABET)}
_BASE58_PUBKEY_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
_BASE58_SIG_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,128}$")
_STRICT_UINT_RE = re.compile(r"^\d+$")


@dataclass(frozen=True)
class SolanaUsdcMatch:
    signature: str
    replay_key: str
    rpc_url: str
    recipient_owner: str
    reference_key: str
    amount_atomic: int
    slot: int


def compute_solana_replay_key(signature: str) -> str:
    """Transaction-signature-scoped replay key preventing cross-invoice double-spend."""
    return hashlib.sha256(f"solana:{signature.strip()}".encode("utf-8")).hexdigest()


def decode_base58(value: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("Empty base58 string")
    num = 0
    for ch in value:
        idx = _BASE58_MAP.get(ch)
        if idx is None:
            raise ValueError(f"Invalid base58 character: {ch!r}")
        num = num * 58 + idx
    raw = num.to_bytes((num.bit_length() + 7) // 8, "big") if num > 0 else b""
    leading_zeros = len(value) - len(value.lstrip("1"))
    return (b"\x00" * leading_zeros) + raw


def encode_base58(raw: bytes) -> str:
    if not raw:
        return ""
    num = int.from_bytes(raw, "big")
    chars: list[str] = []
    while num > 0:
        num, rem = divmod(num, 58)
        chars.append(_BASE58_ALPHABET[rem])
    leading_zeros = 0
    for b in raw:
        if b == 0:
            leading_zeros += 1
        else:
            break
    return ("1" * leading_zeros) + "".join(reversed(chars))


def _require_solana_pubkey(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _BASE58_PUBKEY_RE.match(value.strip()):
        raise ValueError(f"Invalid Solana {label} public key")
    return value.strip()


def _parse_strict_atomic_amount(value: Any, label: str) -> int:
    if not isinstance(value, str) or not _STRICT_UINT_RE.match(value):
        raise ValueError(f"Invalid {label} atomic amount: {value!r}")
    return int(value, 10)


def _push_key_entries(out: list[str], entries: Any) -> None:
    if not isinstance(entries, list):
        return
    for entry in entries:
        if isinstance(entry, str) and entry:
            out.append(entry)
        elif isinstance(entry, dict) and isinstance(entry.get("pubkey"), str):
            out.append(entry["pubkey"])


def extract_solana_account_keys(tx: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    message = tx.get("transaction", {}).get("message", {})
    if isinstance(message, dict):
        _push_key_entries(keys, message.get("accountKeys"))
    meta = tx.get("meta")
    if isinstance(meta, dict):
        loaded = meta.get("loadedAddresses")
        if isinstance(loaded, dict):
            _push_key_entries(keys, loaded.get("writable"))
            _push_key_entries(keys, loaded.get("readonly"))
    return keys


def _is_reference_signer(tx: dict[str, Any], keys: list[str], reference_key: str) -> bool:
    message = tx.get("transaction", {}).get("message", {})
    raw_keys = message.get("accountKeys", []) if isinstance(message, dict) else []
    header = message.get("header") if isinstance(message, dict) else None
    num_signers = header.get("numRequiredSignatures") if isinstance(header, dict) else None
    if isinstance(num_signers, int) and not isinstance(num_signers, bool) and num_signers > 0:
        for i in range(min(num_signers, len(raw_keys))):
            if keys[i] == reference_key:
                return True
    if isinstance(raw_keys, list):
        for entry in raw_keys:
            if (
                isinstance(entry, dict)
                and entry.get("pubkey") == reference_key
                and entry.get("signer") is True
            ):
                return True
    return False


def _resolve_account_ref(ref: Any, keys: list[str]) -> Optional[str]:
    if isinstance(ref, int) and not isinstance(ref, bool):
        return keys[ref] if 0 <= ref < len(keys) else None
    return ref if isinstance(ref, str) and ref else None


def _decode_matched_spl_transfer_amount(
    ix: dict[str, Any],
    keys: list[str],
    reference_key: str,
    usdc_mint: str,
    valid_recipient_dest_keys: set[str],
) -> int:
    if isinstance(ix.get("programId"), str):
        program_id: Optional[str] = ix["programId"]
    elif isinstance(ix.get("programIdIndex"), int) and not isinstance(ix.get("programIdIndex"), bool):
        program_id = _resolve_account_ref(ix["programIdIndex"], keys)
    else:
        program_id = None

    if not program_id or program_id not in SPL_TOKEN_PROGRAMS:
        return 0
    accounts = ix.get("accounts")
    data = ix.get("data")
    if not isinstance(accounts, list) or not isinstance(data, str) or not data:
        return 0

    try:
        data_bytes = decode_base58(data)
    except ValueError:
        return 0

    resolved = [_resolve_account_ref(a, keys) for a in accounts]
    if any(a is None for a in resolved):
        return 0

    # SPL Token Transfer (opcode 3, 9 bytes): [source, destination, authority, ...referenceKeys]
    if len(data_bytes) == 9 and data_bytes[0] == 3 and len(resolved) >= 4:
        dest = resolved[1]
        if dest not in valid_recipient_dest_keys or reference_key not in resolved[3:]:
            return 0
        amt = int.from_bytes(data_bytes[1:9], "little")
        return amt if amt > 0 else 0

    # SPL Token TransferChecked (opcode 12, 10 bytes): [source, mint, destination, authority, ...referenceKeys]
    if len(data_bytes) == 10 and data_bytes[0] == 12 and len(resolved) >= 5:
        mint_arg = resolved[1]
        dest = resolved[2]
        if (
            mint_arg != usdc_mint
            or dest not in valid_recipient_dest_keys
            or reference_key not in resolved[4:]
        ):
            return 0
        amt = int.from_bytes(data_bytes[1:9], "little")
        return amt if amt > 0 else 0

    return 0


def _sum_matched_reference_transfer_amounts(
    tx: dict[str, Any],
    keys: list[str],
    reference_key: str,
    usdc_mint: str,
    valid_recipient_dest_keys: set[str],
) -> int:
    if not valid_recipient_dest_keys or reference_key not in keys:
        return 0
    if _is_reference_signer(tx, keys, reference_key):
        return 0

    message = tx.get("transaction", {}).get("message", {})
    top_ix = message.get("instructions") if isinstance(message, dict) else None
    meta = tx.get("meta")
    inner_groups = meta.get("innerInstructions") if isinstance(meta, dict) else None
    all_ix: list[dict[str, Any]] = []
    if isinstance(top_ix, list):
        all_ix.extend(ix for ix in top_ix if isinstance(ix, dict))
    if isinstance(inner_groups, list):
        for grp in inner_groups:
            if isinstance(grp, dict) and isinstance(grp.get("instructions"), list):
                all_ix.extend(ix for ix in grp["instructions"] if isinstance(ix, dict))

    # Fail-closed: require explicit decoded SPL Transfer / TransferChecked instruction binding
    if not all_ix:
        return 0

    return sum(
        _decode_matched_spl_transfer_amount(
            ix, keys, reference_key, usdc_mint, valid_recipient_dest_keys
        )
        for ix in all_ix
    )


def _default_post_json(
    url: str,
    payload: dict[str, Any],
    timeout_seconds: float = DEFAULT_SOLANA_RPC_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        return json.loads(resp.read().decode("utf-8"))


def match_solana_usdc_reference_transfer(
    tx: dict[str, Any],
    expected_recipient_owner: str,
    expected_reference_key: str,
    min_amount_atomic: int,
    usdc_mint: str = SOLANA_MAINNET_USDC_MINT,
) -> Optional[int]:
    recipient_owner = _require_solana_pubkey(expected_recipient_owner, "recipient_owner")
    reference_key = _require_solana_pubkey(expected_reference_key, "reference_key")
    mint = _require_solana_pubkey(usdc_mint, "usdc_mint")
    if reference_key == recipient_owner or reference_key == mint:
        raise ValueError(
            "expected_reference_key must be distinct from recipient_owner and usdc_mint"
        )
    if isinstance(min_amount_atomic, bool) or not isinstance(min_amount_atomic, int) or min_amount_atomic <= 0:
        raise ValueError("min_amount_atomic must be a positive integer")

    if not isinstance(tx, dict):
        return None
    meta = tx.get("meta")
    if not isinstance(meta, dict) or meta.get("err") is not None:
        return None

    keys = extract_solana_account_keys(tx)
    valid_recipient_dest_keys: set[str] = set()

    pre_map: dict[int, int] = {}
    for bal in meta.get("preTokenBalances") or []:
        if bal.get("mint") == mint and bal.get("owner") == recipient_owner:
            idx = bal.get("accountIndex")
            if isinstance(idx, bool) or not isinstance(idx, int):
                raise ValueError("Invalid preTokenBalances accountIndex")
            if idx in pre_map:
                raise ValueError(f"Duplicate preTokenBalances entry for accountIndex {idx}")
            pre_map[idx] = _parse_strict_atomic_amount(
                bal.get("uiTokenAmount", {}).get("amount"), "preTokenBalance"
            )
            if 0 <= idx < len(keys) and keys[idx]:
                valid_recipient_dest_keys.add(keys[idx])

    post_map: dict[int, int] = {}
    for bal in meta.get("postTokenBalances") or []:
        if bal.get("mint") == mint and bal.get("owner") == recipient_owner:
            idx = bal.get("accountIndex")
            if isinstance(idx, bool) or not isinstance(idx, int):
                raise ValueError("Invalid postTokenBalances accountIndex")
            if idx in post_map:
                raise ValueError(f"Duplicate postTokenBalances entry for accountIndex {idx}")
            post_map[idx] = _parse_strict_atomic_amount(
                bal.get("uiTokenAmount", {}).get("amount"), "postTokenBalance"
            )
            if 0 <= idx < len(keys) and keys[idx]:
                valid_recipient_dest_keys.add(keys[idx])

    matched_ix_total = _sum_matched_reference_transfer_amounts(
        tx, keys, reference_key, mint, valid_recipient_dest_keys
    )
    if matched_ix_total < min_amount_atomic:
        return None

    net_delta = sum(post_map.values()) - sum(pre_map.values())
    return net_delta if net_delta >= min_amount_atomic else None


def verify_solana_usdc_payment(
    signature: str,
    expected_recipient_owner: str,
    expected_reference_key: str,
    min_amount_atomic: int,
    rpc_urls: list[str],
    usdc_mint: str = SOLANA_MAINNET_USDC_MINT,
    timeout_seconds: float = DEFAULT_SOLANA_RPC_TIMEOUT_SECONDS,
    post_json: Optional[Callable[[str, dict[str, Any]], dict[str, Any]]] = None,
) -> SolanaUsdcMatch:
    clean_sig = signature.strip() if isinstance(signature, str) else ""
    if not _BASE58_SIG_RE.match(clean_sig):
        raise ValueError("Invalid Solana transaction signature")

    recipient_owner = _require_solana_pubkey(expected_recipient_owner, "recipient_owner")
    reference_key = _require_solana_pubkey(expected_reference_key, "reference_key")
    mint = _require_solana_pubkey(usdc_mint, "usdc_mint")
    if reference_key == recipient_owner or reference_key == mint:
        raise ValueError(
            "expected_reference_key must be distinct from recipient_owner and usdc_mint"
        )
    if isinstance(min_amount_atomic, bool) or not isinstance(min_amount_atomic, int) or min_amount_atomic <= 0:
        raise ValueError("min_amount_atomic must be a positive integer")
    if not rpc_urls:
        raise ValueError("At least one Solana RPC URL is required")
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
                url,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getTransaction",
                    "params": [
                        clean_sig,
                        {
                            "encoding": "json",
                            "commitment": "finalized",
                            "maxSupportedTransactionVersion": 0,
                        },
                    ],
                },
            )
            if "error" in body and body["error"]:
                errors.append(f"{url}: {body['error']}")
                continue
            tx = body.get("result")
            if not tx:
                errors.append(f"{url}: transaction not found (null result)")
                continue
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{url}: {exc}")
            continue

        received = match_solana_usdc_reference_transfer(
            tx,
            recipient_owner,
            reference_key,
            min_amount_atomic,
            usdc_mint=mint,
        )
        if received is None:
            raise ValueError("Solana USDC reference transfer mismatch or failed tx")
        return SolanaUsdcMatch(
            signature=clean_sig,
            replay_key=compute_solana_replay_key(clean_sig),
            rpc_url=url,
            recipient_owner=recipient_owner,
            reference_key=reference_key,
            amount_atomic=received,
            slot=int(tx.get("slot", 0)),
        )

    raise RuntimeError(f"All Solana RPC endpoints failed ({'; '.join(errors)})")
