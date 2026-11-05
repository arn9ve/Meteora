# Station-mode cheatsheet

1. Wi-Fi → `TELLO-XXXXXX` (or `RMTT-XXXXXX`)
2. `python set_sta_mode.py` and enter the network name and password (`<venue Wi-Fi>` / `<password>`)
3. Wait about 1 minute
4. Wi-Fi → `<venue Wi-Fi>`
5. `python find_tello.py` → save `TELLO_IP`
6. Optional: `python live_video.py` (q to quit)

The network must be **2.4 GHz**. The USB cable only charges the drone; it cannot set up Wi-Fi.
