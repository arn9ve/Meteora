# Space pads (room positions)

Six physical space-themed pads stood in for LiDAR waypoints in the first demo, the pad-to-pad mission. That mission is now off by default (`PAD_NAV=1` turns it on); the current zone mission uses the room plan instead. Resized ORB reference images are in `refs/` (from Masoud's photos).

| ID | Position | First-demo role |
| --- | --- | --- |
| pad-01 | P1 | **Home** for Black on phone 1 (cam1) |
| pad-02 | P2 | **Target** for Black on phone 1 (cam1) |
| pad-03…06 | P3–P6 | Reserved |

Config: `../pad-nav.json`. Recognition demo: `../tools/pad_recognize.py`.
