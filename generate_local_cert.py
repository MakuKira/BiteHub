#!/usr/bin/env python3
"""Create a local BiteHub HTTPS certificate signed by a private development CA."""
import argparse
import ipaddress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


ROOT = Path(__file__).resolve().parent / ".local-certs"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-ip", action="append", default=[], help="LAN IP used by the phone (repeat for multiple IPs)")
    parser.add_argument("--host-name", action="append", default=[], help="PC hostname used by the phone (repeat if needed)")
    args = parser.parse_args()

    ips = {ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")}
    for value in args.host_ip:
        try:
            ips.add(ipaddress.ip_address(value))
        except ValueError as error:
            parser.error(f"Invalid --host-ip {value!r}: {error}")
    names = {"localhost"}
    for value in args.host_name:
        name = value.strip().rstrip(".")
        if not name or any(character.isspace() for character in name):
            parser.error(f"Invalid --host-name {value!r}")
        names.add(name)

    ROOT.mkdir(parents=True, exist_ok=True)
    ca_key_path, ca_cert_path = ROOT / "root-ca.key", ROOT / "root-ca.crt"
    if ca_key_path.exists() != ca_cert_path.exists():
        parser.error("The local CA files are incomplete; restore both root-ca.key and root-ca.crt from a secure backup.")
    if ca_key_path.exists():
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
        ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
    else:
        ca_key = ec.generate_private_key(ec.SECP256R1())
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        ca_subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "BiteHub Local Development CA")])
        ca_cert = (x509.CertificateBuilder().subject_name(ca_subject).issuer_name(ca_subject)
            .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                encipher_only=None, decipher_only=None), critical=True)
            .sign(ca_key, hashes.SHA256()))
        ca_key_path.write_bytes(ca_key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        ca_cert_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))

    server_key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "BiteHub local server")])
    san = [x509.IPAddress(address) for address in sorted(ips, key=str)]
    san.extend(x509.DNSName(name) for name in sorted(names, key=str.casefold))
    server_cert = (x509.CertificateBuilder().subject_name(server_name).issuer_name(ca_cert.subject)
        .public_key(server_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256()))
    (ROOT / "server.key").write_bytes(server_key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (ROOT / "server.crt").write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))
    print(f"Created HTTPS server certificate in {ROOT}")
    print("Names and IPs on this certificate:")
    for value in sorted(names | {str(address) for address in ips}, key=str.casefold):
        print(f"  {value}")
    print("Install root-ca.crt as a trusted root on each device. Keep root-ca.key private.")


if __name__ == "__main__":
    main()
