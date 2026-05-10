# Bynum Machine Status Grid

Bynum Machine Status Grid is a compact Cinnamon desklet for Linux machine status metrics. It draws one translucent desktop widget with CPU, RAM, GPU, disk, network, and temperature tiles.

The desklet is intentionally small: no daemon, no network access, no build step, and no runtime dependency beyond Cinnamon/GJS and normal Linux system files. Optional command-line tools enable extra metrics when available.

## Requirements

- Cinnamon desktop, tested on Cinnamon 6.6
- Linux with `/proc`
- A normal user account. Root privileges are not required.

## Optional Tools

- `nvidia-smi` for NVIDIA GPU utilization, memory, temperature, and power
- `sensors` from `lm-sensors` for CPU, NVMe, and other temperature readings
- `df` from GNU coreutils for disk usage

If an optional tool is missing or a command fails, the affected tile shows `--` or a short unavailable reason and the desklet keeps running.

## Installation

Clone this repository directly into Cinnamon's local desklet directory:

```sh
mkdir -p ~/.local/share/cinnamon/desklets
git clone https://github.com/ZacharyBynum/bynum-machine-status-grid.git ~/.local/share/cinnamon/desklets/bynum-machine-status-grid@zachary
```

Then enable it from:

```text
Cinnamon Settings -> Desklets -> Bynum Machine Status Grid
```

For development, a symlink also works:

```sh
ln -s "$PWD" ~/.local/share/cinnamon/desklets/bynum-machine-status-grid@zachary
```

Reload the desklet after code changes:

```sh
gdbus call --session \
  --dest org.Cinnamon \
  --object-path /org/Cinnamon \
  --method org.Cinnamon.ReloadXlet \
  bynum-machine-status-grid@zachary DESKLET
```

## Configuration

Open the desklet settings by clicking the desklet or using Cinnamon's desklet settings window.

Available settings include:

- Toggle CPU, RAM, GPU, disk, network, and temperatures
- Width and tile height
- Refresh interval, default `1 s`
- Graph history duration
- Light mode
- Background, text, grid, and accent colors
- Network interface selection or manual interface entry
- Disk path, default `/`

Network manual entries are sanitized to interface-name characters. Disk paths are passed to `df` as an argument array, not through a shell.

## Known Limitations

- GPU metrics currently target NVIDIA through `nvidia-smi`.
- Temperature labels are best-effort and depend on `sensors` output names.
- Disk usage is sampled through `df`, so unusual mounts may display whatever `df` reports for the configured path.
- Command-backed metrics are cached briefly to avoid blocking or excessive process launches.

## Troubleshooting

Check Cinnamon's session log:

```sh
tail -n 200 ~/.xsession-errors
```

If the desklet does not appear:

- Confirm the directory is named exactly `bynum-machine-status-grid@zachary`
- Confirm `metadata.json`, `desklet.js`, `settings-schema.json`, and `stylesheet.css` are present
- Reload the desklet with the `gdbus` command above, or disable and re-enable it in Cinnamon Settings

If GPU or temperature data is missing:

- Run `command -v nvidia-smi` or `command -v sensors`
- Run the command manually and confirm it returns data for your hardware

## Screenshots

Screenshots should be stored under `screenshots/` for release notes or a Cinnamon Spices listing.

Suggested files:

- `screenshots/dark-mode.png`
- `screenshots/light-mode.png`

## Security And Privacy

The desklet reads local system information from `/proc` and optional local commands. It does not open network connections, collect analytics, transmit data, or require elevated privileges.

External commands are launched with argument arrays rather than shell strings.

## Development Checks

Run the lightweight sanity check:

```sh
./scripts/check.sh
```

The script validates JSON, checks JavaScript syntax with `cjs`, and verifies Cinnamon's unsafe scanner strings are not present.

## License

MIT. See `LICENSE`.
