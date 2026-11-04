#!/usr/bin/env python3
"""Ground-only UDP comparison client. No dependencies or credentials."""
import socket
import subprocess
import time


def main():
    print('\nComparison with a Python client (no flight, no network change).', flush=True)
    try:
        address = subprocess.check_output(['/usr/sbin/ipconfig', 'getifaddr', 'en0'], text=True, timeout=3).strip()
    except (OSError, subprocess.SubprocessError):
        print('Python: Wi-Fi address not found.')
        return
    if not address.startswith('192.168.10.'):
        print('Python: join the Mac to the Tello network first.')
        return
    for port in (9000, 8889, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(3)
            try:
                sock.bind(('0.0.0.0', port))
                sock.sendto(b'command', ('192.168.10.1', 8889))
                print(f'Python: sending from port {sock.getsockname()[1]}.', flush=True)
                deadline = time.monotonic() + 3
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise socket.timeout()
                    sock.settimeout(remaining)
                    data, peer = sock.recvfrom(2048)
                    if peer != ('192.168.10.1', 8889):
                        continue
                    response = data.replace(b'\x00', b'').strip().lower()
                    if response == b'ok':
                        print('Python: SDK replied ok. The drone answers this client.')
                        return
                    print('Python: UDP reply received but not recognised as ok.')
                    break
            except socket.timeout:
                print('Python: no UDP reply.')
            except OSError as exc:
                print(f'Python: network error ({exc.errno}).')
    print('Python: no SDK link confirmed.')


if __name__ == '__main__':
    main()
