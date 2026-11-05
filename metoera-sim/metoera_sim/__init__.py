"""metoera-sim: the room as a Gaussian splat, seen from a simulated Tello's camera.

World frame used everywhere in this package (after the scene is aligned, see viewer.py):
metres, z up, the takeoff pad at (0, 0, 0) on the floor, x = the drone's heading at takeoff,
y = to its left. Yaw is in degrees, counterclockwise seen from above (the Tello's `ccw`
adds to it, `cw` subtracts).
"""

__version__ = "0.1.0"
