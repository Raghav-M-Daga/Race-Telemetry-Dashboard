# PER Vehicle Dynamics Dashboard

A live React + Vite dashboard for Penn Electric Racing car telemetry, built for the PER software subteam challenge (Fall 2026).

It connects to a replay server that streams real sensor data from the car at 20 Hz and turns it into a pit-wall view of vehicle dynamics and handling, with driver coaching as the main page.

- **Driver Coaching**: a GPS track map that marks where a lap started losing time compared with the driver's own best lap, and what they did differently there (sliding past the grip limit, jerky steering, coasting with grip left on the table)
- **Instruments**: steering angle, lateral g, yaw rate, per-corner load and heading
- **Car Setup**: understeer/oversteer analysis built from the disagreement between steering, lateral acceleration and yaw rate
- **Data Guide**: what every number means and where it comes from

The analysis has no fixed thresholds. Everything is scaled by the driver's own lap-to-lap variation (median absolute deviation), so it adapts to the car and the driver instead of relying on hardcoded numbers.

The full write-up (sensor mapping, signal conditioning, the coaching engine and tests) is in [`widget/README.md`](widget/README.md).

## Repository layout

| Folder | What it is |
| --- | --- |
| `widget/` | My submission: the dashboard and its analysis engine, with unit and live tests |
| `server/` | PER's Python replay server (FastAPI + SSE), provided with the challenge |
| `example/` | PER's example speedometer app, provided with the challenge |
| `data_replay.h5` | PER's recorded telemetry that the server replays |

The original challenge instructions are in [`CHALLENGE.md`](CHALLENGE.md). The server, example app and data come from [Penn-Electric-Racing/Software-Application](https://github.com/Penn-Electric-Racing/Software-Application).

## Running it

Start the server first:

```shell
python -m venv .venv
.venv\Scripts\activate        # Windows
source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt
uvicorn server.server:app --host 0.0.0.0 --port 8081
```

Then, in a second terminal:

```shell
cd widget
npm install
npm run dev
```

Open the link Vite prints (usually http://localhost:5173). Run `npm test` in `widget/` for the test suite.
