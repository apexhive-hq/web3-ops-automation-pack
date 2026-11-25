import json
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

SOLANA_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


@dataclass(frozen=True)
class SolanaUsdcMatch:
    signature: str
    rpc_url: str
    recipient_owner: str
    reference_key: str
    amount_atomic: int
    slot: int


def _default_post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def match_solana_usdc_reference_transfer(
    tx: dict[str, Any],
    expected_recipient_owner: str,
    expected_reference_key: str,
    min_amount_atomic: int,
    usdc_mint: str = SOLANA_MAINNET_USDC_MINT,
) -> Optional[int]:
    meta = tx.get("meta")
    if not meta or meta.get("err") is not None:
        return None

    raw_keys = tx.get("transaction", {}).get("message", {}).get("accountKeys", [])
    keys = [k if isinstance(k, str) else k.get("pubkey", "") for k in raw_keys]
    if expected_reference_key not in keys:
        return None

    pre_map: dict[int, int] = {}
    for bal in meta.get("preTokenBalances", []):
        if bal.get("mint") == usdc_mint and bal.get("owner") == expected_recipient_owner:
            pre_map[int(bal["accountIndex"])] = int(
                bal.get("uiTokenAmount", {}).get("amount", "0")
            )

    total_received = 0
    for bal in meta.get("postTokenBalances", []):
        if bal.get("mint") == usdc_mint and bal.get("owner") == expected_recipient_owner:
            idx = int(bal["accountIndex"])
            post_amt = int(bal.get("uiTokenAmount", {}).get("amount", "0"))
            pre_amt = pre_map.get(idx, 0)
            if post_amt > pre_amt:
                total_received += post_amt - pre_amt

    return total_received if total_received >= min_amount_atomic else None


def verify_solana_usdc_payment(
    signature: str,
    expected_recipient_owner: str,
    expected_reference_key: str,
    min_amount_atomic: int,
    rpc_urls: list[str],
    usdc_mint: str = SOLANA_MAINNET_USDC_MINT,
    post_json: Callable[[str, dict[str, Any]], dict[str, Any]] = _default_post_json,
) -> SolanaUsdcMatch:
    clean_sig = signature.strip()
    if len(clean_sig) < 32:
        raise ValueError("Invalid Solana transaction signature")

    errors: list[str] = []
    for url in rpc_urls:
        try:
            body = post_json(
                url,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getTransaction",
                    "params": [
                        clean_sig,
                        {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0},
                    ],
                },
            )
            if "error" in body and body["error"]:
                errors.append(f"{url}: {body['error']}")
                continue
            tx = body.get("result")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{url}: {exc}")
            continue

        if not tx:
            raise ValueError("Solana transaction not found")
        received = match_solana_usdc_reference_transfer(
            tx,
            expected_recipient_owner,
            expected_reference_key,
            min_amount_atomic,
            usdc_mint=usdc_mint,
        )
        if received is None:
            raise ValueError("Solana USDC reference transfer mismatch or failed tx")
        return SolanaUsdcMatch(
            signature=clean_sig,
            rpc_url=url,
            recipient_owner=expected_recipient_owner,
            reference_key=expected_reference_key,
            amount_atomic=received,
            slot=int(tx.get("slot", 0)),
        )

    raise RuntimeError(f"All Solana RPC endpoints failed ({'; '.join(errors)})")
