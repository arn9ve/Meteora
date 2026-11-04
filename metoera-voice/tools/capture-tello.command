#!/bin/zsh
cd "${0:A:h}" || exit 1
print 'This test only observes Tello UDP addresses and ports. It sends no flight or configuration command.'
if ! /usr/sbin/ipconfig getifaddr en0 | /usr/bin/grep -q '^192\.168\.10\.'; then
  print 'Join the Mac to the Tello network first.'
  exit 1
fi
print 'macOS will ask for your Mac password to start tcpdump. The script never shows or stores it.'
sudo -v || exit 1
python3 capture-tello.py
