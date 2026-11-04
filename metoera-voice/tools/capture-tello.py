#!/usr/bin/env python3
"""Capture only Tello UDP packet summaries; clients run without sudo."""
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
LOG = ROOT / '.tello-wire.log'
ERR = ROOT / '.tello-wire-errors.log'
TARGET = '192.168.10.1'


def main():
    try:
        address = subprocess.check_output(['/usr/sbin/ipconfig', 'getifaddr', 'en0'], text=True, timeout=3).strip()
    except (OSError, subprocess.SubprocessError):
        print('Wi-Fi address unavailable.')
        return 1
    if not address.startswith('192.168.10.'):
        print('Join the Mac to the Tello network before running this test.')
        return 1
    capture = None
    for path in (LOG, ERR):
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
    try:
        with LOG.open('w') as output, ERR.open('w') as errors:
            capture = subprocess.Popen([
                '/usr/bin/sudo', '-n', '/usr/sbin/tcpdump', '-i', 'en0',
                '-nn', '-q', '-l', 'udp and host 192.168.10.1'
            ], stdout=output, stderr=errors)
            time.sleep(1)
            if capture.poll() is not None:
                print('Capture did not start. Details in .tello-wire-errors.log.')
                return 1
            print('Capture running: Tello UDP summaries only, no packet contents.', flush=True)
            subprocess.run(['node', str(HERE / 'diagnose-tello.mjs')], cwd=HERE, timeout=35, check=False)
            subprocess.run(['python3', str(HERE / 'check-tello-python.py')], cwd=HERE, timeout=15, check=False)
    except subprocess.TimeoutExpired:
        print('Test timed out.')
    finally:
        if capture is not None and capture.poll() is None:
            subprocess.run(['/usr/bin/sudo', '-n', '/bin/kill', '-INT', str(capture.pid)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                capture.wait(timeout=4)
            except subprocess.TimeoutExpired:
                subprocess.run(['/usr/bin/sudo', '-n', '/bin/kill', '-TERM', str(capture.pid)], check=False)
                try:
                    capture.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    print('The capture did not stop: do not rerun, report the problem.')
    lines = LOG.read_text(errors='replace').splitlines()
    outgoing = sum(bool(re.search(r'> 192\.168\.10\.1\.8889:', line)) for line in lines)
    incoming = [line for line in lines if re.search(r'IP 192\.168\.10\.1\.\d+ >', line)]
    controls = [line for line in incoming if re.search(r'IP 192\.168\.10\.1\.8889 >', line)]
    print('\n=== CAPTURE SUMMARY ===')
    print(f'Packets sent to the Tello command port: {outgoing}')
    print(f'Packets from the Tello command port: {len(controls)}')
    print(f'Total UDP packets received from the Tello: {len(incoming)}')
    if controls:
        print('Control replies reach the Mac: check which local port they are addressed to and the client filters.')
    elif incoming and outgoing:
        print('The Mac sees UDP from the Tello and outgoing commands, but no reply from port 8889. Cause not confirmed.')
    else:
        print('Incomplete capture or no traffic: read the report before choosing a fix.')
    print(f'Payload-free summaries saved to: {LOG}')
    print('Done. Put the Mac back on the shared network and share the summary above.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
