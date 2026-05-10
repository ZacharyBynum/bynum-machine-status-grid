const ByteArray = imports.byteArray;
const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const Desklet = imports.ui.desklet;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Settings = imports.ui.settings;
const St = imports.gi.St;

const UUID = "bynum-machine-status-grid@zachary";
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_WIDTH = 680;
const DEFAULT_TILE_HEIGHT = 118;
const DEFAULT_REFRESH_SECONDS = 1;
const DEFAULT_HISTORY_SECONDS = 120;
const SLOW_COMMAND_SECONDS = 5;
const MAX_LABEL_LENGTH = 36;

function main(metadata, desklet_id) {
    return new HealthGridDesklet(metadata, desklet_id);
}

function readTextFile(path) {
    try {
        let [ok, bytes] = GLib.file_get_contents(path);
        return ok ? ByteArray.toString(bytes) : null;
    } catch (e) {
        return null;
    }
}

function runCommandAsync(argv, callback) {
    try {
        let proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );

        proc.communicate_utf8_async(null, null, (subprocess, result) => {
            try {
                let [, stdout] = subprocess.communicate_utf8_finish(result);
                let output = stdout ? stdout.trim() : "";
                callback(subprocess.get_successful() && output !== "", output || null);
            } catch (e) {
                callback(false, null);
            }
        });
    } catch (e) {
        callback(false, null);
    }
}

function clamp(value, min, max) {
    if (isNaN(value)) {
        return min;
    }

    return Math.max(min, Math.min(max, value));
}

function roundRect(ctx, x, y, width, height, radius) {
    let degrees = Math.PI / 180;
    ctx.newSubPath();
    ctx.arc(x + width - radius, y + radius, radius, -90 * degrees, 0);
    ctx.arc(x + width - radius, y + height - radius, radius, 0, 90 * degrees);
    ctx.arc(x + radius, y + height - radius, radius, 90 * degrees, 180 * degrees);
    ctx.arc(x + radius, y + radius, radius, 180 * degrees, 270 * degrees);
    ctx.closePath();
}

class HealthGridDesklet extends Desklet.Desklet {
    constructor(metadata, desklet_id) {
        super(metadata, desklet_id);

        this._timerId = 0;
        this._history = {};
        this._lastCpu = null;
        this._lastNet = null;
        this._lastRefreshMs = 0;
        this._lastMetrics = [];
        this._commandCache = {};
        this._lastGpuMetric = null;
        this._commands = {
            df: GLib.find_program_in_path("df"),
            nvidiaSmi: GLib.find_program_in_path("nvidia-smi"),
            sensors: GLib.find_program_in_path("sensors")
        };
        this._ready = false;
        this._destroyed = false;

        this.settings = new Settings.DeskletSettings(this, UUID, desklet_id);
        this._bindSettings();

        this.setHeader("Bynum Machine Status Grid");
        this._menu.addAction("Open System Health Settings", () => this.configureDesklet());

        this._root = new St.Bin({style_class: "bynum-machine-status-grid-root", reactive: true});
        this._canvasActor = new Clutter.Actor({reactive: true});
        this._root.set_child(this._canvasActor);
        this.setContent(this._root);

        this._ready = true;
        this._rebuild();
    }

    _bindSettings() {
        let changed = () => {
            if (this._ready) {
                this._onSettingsChanged();
            }
        };

        this.settings.bind("show-cpu", "showCpu", changed);
        this.settings.bind("show-ram", "showRam", changed);
        this.settings.bind("show-gpu", "showGpu", changed);
        this.settings.bind("show-disk", "showDisk", changed);
        this.settings.bind("show-network", "showNetwork", changed);
        this.settings.bind("show-temperatures", "showTemperatures", changed);
        this.settings.bind("desklet-width", "deskletWidth", changed);
        this.settings.bind("tile-height", "tileHeight", changed);
        this.settings.bind("refresh-interval", "refreshInterval", changed);
        this.settings.bind("history-duration", "historyDuration", changed);
        this.settings.bind("network-interface-mode", "networkInterfaceMode", changed);
        this.settings.bind("network-interface-manual", "networkInterfaceManual", changed);
        this.settings.bind("disk-path", "diskPath", changed);
        this.settings.bind("light-mode", "lightMode", changed);
        this.settings.bind("background-color", "backgroundColor", changed);
        this.settings.bind("background-opacity", "backgroundOpacity", changed);
        this.settings.bind("text-color", "textColor", changed);
        this.settings.bind("grid-line-color", "gridLineColor", changed);
        this.settings.bind("cpu-color", "cpuColor", changed);
        this.settings.bind("ram-color", "ramColor", changed);
        this.settings.bind("gpu-color", "gpuColor", changed);
        this.settings.bind("disk-color", "diskColor", changed);
        this.settings.bind("network-color", "networkColor", changed);
        this.settings.bind("temperature-color", "temperatureColor", changed);
    }

    on_desklet_clicked(event) {
        this.configureDesklet();
    }

    on_desklet_removed() {
        this._destroyed = true;
        this._removeTimer();
    }

    on_desklet_reloaded() {
        this._destroyed = true;
        this._removeTimer();
    }

    _onSettingsChanged() {
        this._rebuild();
    }

    _removeTimer() {
        if (this._timerId !== 0) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _startTimer() {
        this._removeTimer();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._refreshInterval(), () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _rebuild() {
        this._resizeHistories();
        this._refresh();
        this._startTimer();
    }

    _refreshInterval() {
        return clamp(parseInt(this.refreshInterval, 10) || DEFAULT_REFRESH_SECONDS, 1, 60);
    }

    _historyLimit() {
        let duration = Math.max(30, parseInt(this.historyDuration, 10) || DEFAULT_HISTORY_SECONDS);
        return Math.max(2, Math.floor(duration / this._refreshInterval()) + 1);
    }

    _resizeHistories() {
        let limit = this._historyLimit();
        for (let key in this._history) {
            while (this._history[key].length > limit) {
                this._history[key].shift();
            }
        }
    }

    _pushHistory(key, value) {
        let limit = this._historyLimit();
        if (!this._history[key]) {
            this._history[key] = [];
        }

        this._history[key].push(value);
        while (this._history[key].length > limit) {
            this._history[key].shift();
        }
    }

    _refresh() {
        let nowMs = GLib.get_monotonic_time() / 1000;
        let elapsedSeconds = this._lastRefreshMs > 0 ? Math.max(0.1, (nowMs - this._lastRefreshMs) / 1000) : this._refreshInterval();
        this._lastRefreshMs = nowMs;

        let cpu = this._collectCpu();
        let ram = this._collectRam();
        let gpu = this._collectGpu();
        let disk = this._collectDisk();
        let network = this._collectNetwork(elapsedSeconds);
        let temps = this._collectTemperatures(gpu);

        let metrics = [];
        if (this.showCpu) {
            metrics.push(cpu);
        }
        if (this.showRam) {
            metrics.push(ram);
        }
        if (this.showGpu) {
            metrics.push(gpu);
        }
        if (this.showDisk) {
            metrics.push(disk);
        }
        if (this.showNetwork) {
            metrics.push(network);
        }
        if (this.showTemperatures) {
            metrics.push(temps);
        }

        this._lastMetrics = metrics;
        this._draw(metrics);

        return GLib.SOURCE_CONTINUE;
    }

    _collectCpu() {
        let text = readTextFile("/proc/stat");
        let percent = NaN;
        let secondary = "--";

        if (text) {
            let line = text.split("\n")[0].trim();
            let parts = line.split(/\s+/).slice(1).map(v => parseInt(v, 10) || 0);
            let idle = (parts[3] || 0) + (parts[4] || 0);
            let total = parts.reduce((sum, value) => sum + value, 0);

            if (this._lastCpu && total > this._lastCpu.total) {
                let totalDelta = total - this._lastCpu.total;
                let idleDelta = idle - this._lastCpu.idle;
                percent = clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100);
            }

            this._lastCpu = {total: total, idle: idle};
        }

        let load = readTextFile("/proc/loadavg");
        if (load) {
            secondary = "load " + load.trim().split(/\s+/).slice(0, 3).join(" ");
        }

        this._pushHistory("cpu", isNaN(percent) ? NaN : percent / 100);

        return {
            key: "cpu",
            label: "CPU",
            value: isNaN(percent) ? "--" : percent.toFixed(0) + "%",
            secondary: secondary,
            color: this.cpuColor,
            history: this._history.cpu || [],
            unavailable: isNaN(percent)
        };
    }

    _collectRam() {
        let text = readTextFile("/proc/meminfo");
        let total = NaN;
        let available = NaN;

        if (text) {
            let totalMatch = text.match(/^MemTotal:\s+(\d+)/m);
            let availableMatch = text.match(/^MemAvailable:\s+(\d+)/m);
            if (totalMatch) {
                total = parseInt(totalMatch[1], 10) * 1024;
            }
            if (availableMatch) {
                available = parseInt(availableMatch[1], 10) * 1024;
            }
        }

        let used = total - available;
        let percent = total > 0 ? clamp((used / total) * 100, 0, 100) : NaN;
        this._pushHistory("ram", isNaN(percent) ? NaN : percent / 100);

        return {
            key: "ram",
            label: "RAM",
            value: isNaN(percent) ? "--" : percent.toFixed(0) + "%",
            secondary: total > 0 ? this._formatBytes(used) + " / " + this._formatBytes(total) : "--",
            color: this.ramColor,
            history: this._history.ram || [],
            unavailable: isNaN(percent)
        };
    }

    _collectGpu() {
        if (!this._commands.nvidiaSmi) {
            this._pushHistory("gpu", NaN);
            return this._unavailableMetric("gpu", "GPU", this.gpuColor, "nvidia-smi unavailable");
        }

        let output = this._cachedCommandOutput("gpu", [
            this._commands.nvidiaSmi,
            "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw",
            "--format=csv,noheader,nounits"
        ], "nvidia-smi");

        if (!output) {
            if (this._lastGpuMetric) {
                this._pushHistory("gpu", this._lastGpuMetric.normalizedValue);
                return Object.assign({}, this._lastGpuMetric, {history: this._history.gpu || []});
            }

            this._pushHistory("gpu", NaN);
            return this._unavailableMetric("gpu", "GPU", this.gpuColor, "nvidia-smi pending");
        }

        let parts = output.split("\n")[0].split(",").map(part => part.trim());
        let name = parts[0] || "NVIDIA";
        let temp = parseFloat(parts[1]);
        let util = parseFloat(parts[2]);
        let memUsed = parseFloat(parts[3]);
        let memTotal = parseFloat(parts[4]);
        let power = parseFloat(parts[5]);

        this._pushHistory("gpu", isNaN(util) ? NaN : clamp(util / 100, 0, 1));

        let secondaryParts = [];
        if (!isNaN(memUsed) && !isNaN(memTotal)) {
            secondaryParts.push(memUsed.toFixed(0) + " / " + memTotal.toFixed(0) + " MiB");
        }
        if (!isNaN(temp)) {
            secondaryParts.push(temp.toFixed(0) + " C");
        }
        if (!isNaN(power)) {
            secondaryParts.push(power.toFixed(0) + " W");
        }

        let metric = {
            key: "gpu",
            label: this._shortGpuName(name),
            value: isNaN(util) ? "--" : util.toFixed(0) + "%",
            secondary: secondaryParts.length > 0 ? secondaryParts.join("  ") : "--",
            color: this.gpuColor,
            history: this._history.gpu || [],
            unavailable: isNaN(util),
            gpuTemperature: temp,
            gpuName: name,
            normalizedValue: isNaN(util) ? NaN : clamp(util / 100, 0, 1)
        };
        this._lastGpuMetric = metric;
        return metric;
    }

    _collectDisk() {
        let path = this._safeDiskPath();
        if (!this._commands.df) {
            this._pushHistory("disk", NaN);
            return this._unavailableMetric("disk", "Disk", this.diskColor, "df unavailable");
        }

        let output = this._cachedCommandOutput("df:" + path, [
            this._commands.df,
            "-B1",
            "--output=source,size,used,avail,pcent,target",
            path
        ], "df failed");

        if (!output) {
            this._pushHistory("disk", NaN);
            return this._unavailableMetric("disk", "Disk " + this._shortLabel(path), this.diskColor, "path unavailable");
        }

        let lines = output.split("\n");
        let line = lines.length > 1 ? lines[lines.length - 1].trim() : "";
        let match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);

        if (!match) {
            this._pushHistory("disk", NaN);
            return this._unavailableMetric("disk", "Disk " + this._shortLabel(path), this.diskColor, "df parse failed");
        }

        let size = parseInt(match[2], 10);
        let used = parseInt(match[3], 10);
        let percent = parseInt(match[5], 10);
        let target = match[6];

        this._pushHistory("disk", clamp(percent / 100, 0, 1));

        return {
            key: "disk",
            label: "Disk " + this._shortLabel(target),
            value: percent + "%",
            secondary: this._formatBytes(used) + " / " + this._formatBytes(size),
            color: this.diskColor,
            history: this._history.disk || [],
            unavailable: false
        };
    }

    _collectNetwork(elapsedSeconds) {
        let text = readTextFile("/proc/net/dev");
        let selected = this._selectedNetworkInterface();
        let rx = 0;
        let tx = 0;
        let label = selected.display;
        let found = false;

        if (text) {
            let lines = text.split("\n").slice(2);
            for (let line of lines) {
                let split = line.split(":");
                if (split.length !== 2) {
                    continue;
                }

                let iface = split[0].trim();
                if (!iface || iface === "lo") {
                    continue;
                }

                if (selected.iface && iface !== selected.iface) {
                    continue;
                }

                let values = split[1].trim().split(/\s+/).map(v => parseInt(v, 10) || 0);
                rx += values[0] || 0;
                tx += values[8] || 0;
                found = true;
            }
        }

        let down = NaN;
        let up = NaN;
        if (found && this._lastNet && this._lastNet.key === selected.key) {
            down = Math.max(0, (rx - this._lastNet.rx) / elapsedSeconds);
            up = Math.max(0, (tx - this._lastNet.tx) / elapsedSeconds);
        }

        this._lastNet = {key: selected.key, rx: rx, tx: tx};

        let maxSeen = Math.max(down || 0, up || 0, 1024);
        let oldHistory = this._history.networkRaw || [];
        for (let value of oldHistory) {
            if (!isNaN(value)) {
                maxSeen = Math.max(maxSeen, value);
            }
        }

        this._pushHistory("networkRaw", isNaN(down) ? NaN : Math.max(down, up));
        this._pushHistory("network", isNaN(down) ? NaN : clamp(Math.max(down, up) / maxSeen, 0, 1));

        return {
            key: "network",
            label: "Network",
            value: isNaN(down) ? "--" : "Down " + this._formatRate(down),
            secondary: isNaN(up) ? "--" : "Up " + this._formatRate(up) + "  " + label,
            color: this.networkColor,
            history: this._history.network || [],
            unavailable: !found,
            valueSize: 18
        };
    }

    _collectTemperatures(gpuMetric) {
        let output = this._cachedCommandOutput("sensors", [this._commands.sensors], "sensors unavailable");
        let cpu = NaN;
        let gpu = gpuMetric && !isNaN(gpuMetric.gpuTemperature) ? gpuMetric.gpuTemperature : NaN;
        let nvme = NaN;

        if (output) {
            let chip = "";
            let lines = output.split("\n");
            for (let line of lines) {
                if (line.trim() === "") {
                    chip = "";
                    continue;
                }

                if (line.indexOf(":") === -1 && line.trim().length > 0) {
                    chip = line.trim();
                    continue;
                }

                let tempMatch = line.match(/^\s*([^:]+):\s+\+?(-?\d+(?:\.\d+)?)\s*(?:\u00b0)?C/);
                if (!tempMatch) {
                    continue;
                }

                let sensor = tempMatch[1].trim().toLowerCase();
                let value = parseFloat(tempMatch[2]);
                let lowerChip = chip.toLowerCase();

                if (lowerChip.indexOf("k10temp") !== -1 || sensor === "package id 0" || sensor === "tctl" || sensor.indexOf("tccd") === 0) {
                    cpu = isNaN(cpu) ? value : Math.max(cpu, value);
                } else if (lowerChip.indexOf("nvme") !== -1 && (sensor === "composite" || isNaN(nvme))) {
                    nvme = value;
                } else if (lowerChip.indexOf("amdgpu") !== -1 && sensor === "edge" && isNaN(gpu)) {
                    gpu = value;
                }
            }
        }

        let values = [cpu, gpu, nvme].filter(v => !isNaN(v));
        let current = values.length > 0 ? Math.max.apply(null, values) : NaN;
        this._pushHistory("temperatures", isNaN(current) ? NaN : clamp((current - 20) / 80, 0, 1));

        let secondaryParts = [];
        if (!isNaN(cpu)) {
            secondaryParts.push("CPU " + cpu.toFixed(0) + " C");
        }
        if (!isNaN(gpu)) {
            secondaryParts.push("GPU " + gpu.toFixed(0) + " C");
        }
        if (!isNaN(nvme)) {
            secondaryParts.push("NVMe " + nvme.toFixed(0) + " C");
        }

        return {
            key: "temperatures",
            label: "Temps",
            value: isNaN(current) ? "--" : current.toFixed(0) + " C",
            secondary: secondaryParts.length > 0 ? secondaryParts.join("  ") : "--",
            color: this.temperatureColor,
            history: this._history.temperatures || [],
            unavailable: isNaN(current)
        };
    }

    _unavailableMetric(key, label, color, reason) {
        return {
            key: key,
            label: label,
            value: "--",
            secondary: reason || "--",
            color: color,
            history: this._history[key] || [],
            unavailable: true
        };
    }

    _selectedNetworkInterface() {
        let mode = this.networkInterfaceMode || "__auto__";
        if (mode === "__manual__") {
            let manual = this._safeInterfaceName(this.networkInterfaceManual || "");
            return {
                key: "manual:" + manual,
                iface: manual || null,
                display: manual || "manual"
            };
        }

        if (mode === "__auto__" || mode === "__all__") {
            return {key: "all", iface: null, display: "all"};
        }

        return {key: mode, iface: mode, display: mode};
    }

    _cachedCommandOutput(cacheKey, argv, unavailableReason) {
        if (!argv[0]) {
            return null;
        }

        let nowSeconds = GLib.get_monotonic_time() / 1000000;
        let cache = this._commandCache[cacheKey] || {
            timestamp: 0,
            output: null,
            hasResult: false,
            pending: false
        };
        this._commandCache[cacheKey] = cache;

        if (cache.hasResult && nowSeconds - cache.timestamp < SLOW_COMMAND_SECONDS) {
            return cache.output;
        }

        if (!cache.pending) {
            cache.pending = true;
            runCommandAsync(argv, (success, output) => {
                cache.pending = false;
                cache.timestamp = GLib.get_monotonic_time() / 1000000;
                cache.hasResult = true;
                cache.output = success ? output : null;
                cache.reason = success ? null : unavailableReason;

                if (!this._destroyed && this._ready) {
                    this._refresh();
                }
            });
        }

        return cache.output;
    }

    _draw(metrics) {
        let width = clamp(parseInt(this.deskletWidth, 10) || DEFAULT_WIDTH, 360, 1400);
        let tileHeight = clamp(parseInt(this.tileHeight, 10) || DEFAULT_TILE_HEIGHT, 78, 220);
        let padding = 18;
        let gap = 0;
        let columns = width < 560 ? 1 : 2;
        let rows = Math.max(1, Math.ceil(Math.max(1, metrics.length) / columns));
        let gridWidth = width - (padding * 2);
        let cellWidth = (gridWidth - (gap * (columns - 1))) / columns;
        let height = padding * 2 + rows * tileHeight + (rows - 1) * gap;

        let palette = this._palette();
        let background = this._parseColor(palette.background, this.backgroundOpacity);
        let text = this._parseColor(palette.text, 1);
        let muted = [text[0], text[1], text[2], 0.62];
        let grid = this._parseColor(palette.grid, 0.16);

        let canvas = new Clutter.Canvas();
        canvas.set_size(width, height);
        canvas.connect("draw", (canvas, ctx, surfaceWidth, surfaceHeight) => {
            ctx.save();
            ctx.setOperator(Cairo.Operator.CLEAR);
            ctx.paint();
            ctx.restore();
            ctx.setOperator(Cairo.Operator.OVER);

            ctx.setSourceRGBA(background[0], background[1], background[2], background[3]);
            roundRect(ctx, 0.5, 0.5, surfaceWidth - 1, surfaceHeight - 1, 14);
            ctx.fill();

            ctx.setLineWidth(1);
            ctx.setSourceRGBA(grid[0], grid[1], grid[2], grid[3]);
            for (let row = 1; row < rows; row++) {
                let y = padding + row * tileHeight + (row - 0.5) * gap;
                ctx.moveTo(padding, y);
                ctx.lineTo(surfaceWidth - padding, y);
                ctx.stroke();
            }

            if (columns > 1) {
                let x = padding + cellWidth;
                ctx.moveTo(x, padding);
                ctx.lineTo(x, surfaceHeight - padding);
                ctx.stroke();
            }

            if (metrics.length === 0) {
                this._drawText(ctx, "No modules enabled", padding, padding + 34, 18, text, Cairo.FontWeight.BOLD);
            }

            for (let i = 0; i < metrics.length; i++) {
                let metric = metrics[i];
                let row = Math.floor(i / columns);
                let col = i % columns;
                let x = padding + col * (cellWidth + gap);
                let y = padding + row * (tileHeight + gap);
                this._drawMetric(ctx, metric, x, y, cellWidth, tileHeight, text, muted, grid);
            }

            return false;
        });

        canvas.invalidate();
        this._canvasActor.set_content(canvas);
        this._canvasActor.set_size(width, height);
        this._root.set_size(width, height);
    }

    _drawMetric(ctx, metric, x, y, width, height, text, muted, grid) {
        let accent = this._parseColor(metric.color, 1);
        let inner = 14;
        let graphX = x + inner;
        let graphY = y + height - 38;
        let graphW = width - (inner * 2);
        let graphH = 24;

        ctx.setLineWidth(3);
        ctx.setSourceRGBA(accent[0], accent[1], accent[2], metric.unavailable ? 0.35 : 0.95);
        ctx.moveTo(x + inner, y + 15);
        ctx.lineTo(x + inner + 34, y + 15);
        ctx.stroke();

        this._drawText(ctx, metric.label, x + inner, y + 34, 13, muted, Cairo.FontWeight.BOLD, width - inner * 2);
        this._drawTextRight(ctx, metric.value, x + width - inner, y + 38, metric.valueSize || 26, text, Cairo.FontWeight.BOLD, width * 0.55);
        this._drawText(ctx, metric.secondary, x + inner, y + 60, 12, muted, Cairo.FontWeight.NORMAL, width - inner * 2);

        ctx.setLineWidth(1);
        ctx.setSourceRGBA(grid[0], grid[1], grid[2], Math.min(0.18, grid[3] + 0.04));
        ctx.moveTo(graphX, graphY + graphH);
        ctx.lineTo(graphX + graphW, graphY + graphH);
        ctx.stroke();

        this._drawSparkline(ctx, metric.history, graphX, graphY, graphW, graphH, accent, metric.unavailable);
    }

    _drawSparkline(ctx, history, x, y, width, height, color, unavailable) {
        if (!history || history.length < 2) {
            return;
        }

        let valid = history.filter(v => !isNaN(v));
        if (valid.length < 2) {
            return;
        }

        let step = width / Math.max(1, history.length - 1);
        let started = false;

        ctx.setLineWidth(2);
        ctx.setSourceRGBA(color[0], color[1], color[2], unavailable ? 0.35 : 0.9);
        for (let i = 0; i < history.length; i++) {
            let value = history[i];
            if (isNaN(value)) {
                started = false;
                continue;
            }

            let px = x + i * step;
            let py = y + height - clamp(value, 0, 1) * height;
            if (!started) {
                ctx.moveTo(px, py);
                started = true;
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.stroke();
    }

    _drawText(ctx, value, x, baseline, size, color, weight, maxWidth) {
        let text = this._fitText(ctx, value || "--", size, weight, maxWidth || 10000);
        ctx.setSourceRGBA(color[0], color[1], color[2], color[3]);
        ctx.selectFontFace("sans", Cairo.FontSlant.NORMAL, weight || Cairo.FontWeight.NORMAL);
        ctx.setFontSize(size);
        ctx.moveTo(x, baseline);
        ctx.showText(text);
    }

    _drawTextRight(ctx, value, right, baseline, size, color, weight, maxWidth) {
        let text = this._fitText(ctx, value || "--", size, weight, maxWidth || 10000);
        ctx.selectFontFace("sans", Cairo.FontSlant.NORMAL, weight || Cairo.FontWeight.NORMAL);
        ctx.setFontSize(size);
        let ext = ctx.textExtents(text);
        ctx.setSourceRGBA(color[0], color[1], color[2], color[3]);
        ctx.moveTo(right - ext.width, baseline);
        ctx.showText(text);
    }

    _fitText(ctx, value, size, weight, maxWidth) {
        let text = String(value);
        ctx.selectFontFace("sans", Cairo.FontSlant.NORMAL, weight || Cairo.FontWeight.NORMAL);
        ctx.setFontSize(size);

        if (ctx.textExtents(text).width <= maxWidth) {
            return text;
        }

        while (text.length > 2 && ctx.textExtents(text + "...").width > maxWidth) {
            text = text.slice(0, -1);
        }

        return text.length > 2 ? text + "..." : text;
    }

    _parseColor(value, fallbackAlpha) {
        let color = String(value || "").trim();
        let rgba = [1, 1, 1, fallbackAlpha];
        let match = color.match(/^rgba?\(([^)]+)\)$/i);

        if (match) {
            let parts = match[1].split(",").map(part => parseFloat(part.trim()));
            if (parts.length >= 3) {
                rgba = [
                    clamp(parts[0], 0, 255) / 255,
                    clamp(parts[1], 0, 255) / 255,
                    clamp(parts[2], 0, 255) / 255,
                    parts.length >= 4 ? clamp(parts[3], 0, 1) : fallbackAlpha
                ];
            }
        } else if (color[0] === "#" && (color.length === 7 || color.length === 9)) {
            rgba = [
                parseInt(color.substr(1, 2), 16) / 255,
                parseInt(color.substr(3, 2), 16) / 255,
                parseInt(color.substr(5, 2), 16) / 255,
                color.length === 9 ? parseInt(color.substr(7, 2), 16) / 255 : fallbackAlpha
            ];
        }

        return rgba;
    }

    _palette() {
        if (this.lightMode) {
            return {
                background: "rgb(245,247,250)",
                text: "rgb(23,28,34)",
                grid: "rgba(24,32,42,0.16)"
            };
        }

        return {
            background: this.backgroundColor,
            text: this.textColor,
            grid: this.gridLineColor
        };
    }

    _safeDiskPath() {
        let path = String(this.diskPath || "/").trim();
        if (path === "" || path.indexOf("\0") !== -1) {
            return "/";
        }

        return path.length > 512 ? path.slice(0, 512) : path;
    }

    _safeInterfaceName(value) {
        return String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 32);
    }

    _shortLabel(value) {
        let text = String(value || "--");
        if (text.length <= MAX_LABEL_LENGTH) {
            return text;
        }

        return "..." + text.slice(-(MAX_LABEL_LENGTH - 3));
    }

    _formatBytes(bytes) {
        if (isNaN(bytes)) {
            return "--";
        }

        if (bytes >= BYTES_PER_GIB) {
            return (bytes / BYTES_PER_GIB).toFixed(1) + " GiB";
        }

        if (bytes >= BYTES_PER_MIB) {
            return (bytes / BYTES_PER_MIB).toFixed(0) + " MiB";
        }

        return bytes.toFixed(0) + " B";
    }

    _formatRate(bytesPerSecond) {
        return this._formatBytes(bytesPerSecond) + "/s";
    }

    _shortGpuName(name) {
        if (!name) {
            return "GPU";
        }

        return name
            .replace(/^NVIDIA\s+/i, "")
            .replace(/^GeForce\s+/i, "RTX ")
            .replace(/^RTX RTX\s+/i, "RTX ")
            .trim();
    }
}
