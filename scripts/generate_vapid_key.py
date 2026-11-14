#!/usr/bin/env python3
"""Generate the stable P-256 key used by BiteHub Web Push in production."""

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def main():
    private_key = ec.generate_private_key(ec.SECP256R1())
    pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    encoded = base64.urlsafe_b64encode(pem).decode("ascii").rstrip("=")
    print("Generate this once, then save it as Render's BITEHUB_VAPID_PRIVATE_KEY_B64 secret.")
    print("Keep the same value for future deployments; changing it makes existing device subscriptions stop working.")
    print()
    print(encoded)


if __name__ == "__main__":
    main()
