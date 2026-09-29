"""Keep provisioning secrets outside source, build logs and process arguments.

init generates independent TLS identities into ignored environment files.
nvs combines the device identity with a user-edited Wi-Fi environment file.
The resulting NVS partition, unlike the firmware, is secret runtime data.
"""
import argparse
import base64
import csv
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def read_env(path):
    result = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key.strip()] = value
    return result


def write_env(path, values):
    # Refuse overwrites: rotating one side without the other strands the device.
    with path.open("x") as f:
        for key, value in values.items():
            if "\n" in value or "\r" in value:
                raise ValueError("Environment values must be single-line")
            f.write(f"{key}={value}\n")
    path.chmod(0o600)


def init(directory, host):
    if (directory / "relay.env").exists() or (directory / "device.env").exists():
        raise SystemExit("Identity exists; reuse it or rotate both endpoints deliberately")
    with tempfile.TemporaryDirectory(dir=directory) as tmp:
        work = Path(tmp)

        def openssl(*args):
            subprocess.run(["openssl", *args], cwd=work, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key")
        openssl("req", "-x509", "-new", "-sha256", "-key", "ca.key", "-days", "3650",
                "-subj", "/CN=Hibana private home relay CA", "-out", "ca.crt",
                "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        for name, usage in (("server", "serverAuth"), ("device", "clientAuth")):
            openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", name + ".key")
            openssl("req", "-new", "-key", name + ".key", "-subj", f"/CN=hibana-home-{name}", "-out", name + ".csr")
            (work / "extensions").write_text(
                "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                f"extendedKeyUsage={usage}\nsubjectAltName=DNS:hibana-home-{name}\n")
            openssl("x509", "-req", "-in", name + ".csr", "-CA", "ca.crt", "-CAkey", "ca.key",
                    "-CAcreateserial", "-days", "825", "-sha256", "-extfile", "extensions", "-out", name + ".crt")
        def b64(name):
            return base64.b64encode((work / name).read_bytes()).decode()
        write_env(directory / "relay.env", {
            "HOME_RELAY_CA_B64": b64("ca.crt"), "HOME_RELAY_CERT_B64": b64("server.crt"),
            "HOME_RELAY_KEY_B64": b64("server.key"), "HOME_RELAY_USERNAME": "hibana",
        })
        write_env(directory / "device.env", {
            "RELAY_HOST": host, "RELAY_NAME": "hibana-home-server", "RELAY_PORT": "18443",
            "CA_B64": b64("ca.crt"), "CERT_B64": b64("device.crt"), "KEY_B64": b64("device.key"),
        })
        write_env(directory / "browser.env", {
            "BROWSER_PROXY_URL": "http://172.17.0.1:18118",
            "BROWSER_PROXY_USERNAME": "hibana",
            "HOME_RELAY_CONTROL_SOCKET": "/run/hibana-home-egress/control.sock",
        })
        # Retain the CA only in an ignored owner-readable environment file for
        # renewal. It is never installed on the VPS or the ESP32.
        write_env(directory / "ca.env", {"CA_B64": b64("ca.crt"), "CA_KEY_B64": b64("ca.key")})
    print("Generated TLS identities and browser endpoint configuration (values withheld)")


def nvs(directory):
    wifi = read_env(directory / "provision.env")
    device = read_env(directory / "device.env")
    ssid, password = wifi.get("WIFI_SSID", ""), wifi.get("WIFI_PASSWORD", "")
    if not 1 <= len(ssid.encode()) <= 32 or not 8 <= len(password.encode()) <= 63:
        raise SystemExit("Enter a valid 2.4 GHz SSID and WPA2/WPA3 password in provision.env")
    values = {"ssid": ssid, "password": password, "host": device["RELAY_HOST"],
              "name": device["RELAY_NAME"], "port": device["RELAY_PORT"],
              "ca": device["CA_B64"], "cert": device["CERT_B64"], "key": device["KEY_B64"]}
    with (directory / "nvs.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["key", "type", "encoding", "value"])
        writer.writerow(["egress", "namespace", "", ""])
        for key, value in values.items():
            writer.writerow([key, "data", "string", value])
    (directory / "nvs.csv").chmod(0o600)
    print("Wrote private NVS input; generate nvs.bin with ESP-IDF nvs_partition_gen.py")


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "nvs"])
    parser.add_argument("--directory", type=Path, default=ROOT / ".local/home-egress")
    parser.add_argument("--host")
    args = parser.parse_args()
    args.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.action == "init":
        host = args.host or json.loads((ROOT / ".local/deployment.json").read_text())["sshTarget"].split("@")[-1]
        init(args.directory, host)
    else:
        nvs(args.directory)
