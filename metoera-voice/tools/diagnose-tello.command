#!/bin/zsh
cd "${0:A:h}" || exit 1
print '=== Tello diagnostics: no flight, no network change ==='
node diagnose-tello.mjs
python3 check-tello-python.py
print '\nDone. Put the Mac back on the shared network and share this output.'
