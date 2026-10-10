import * as utils from "@iobroker/adapter-core";
import { errorText } from "./lib/transport";
import { HciTransport } from "./lib/hci";
import { LiteSession } from "./lib/session";
import { type Controls, type LiteState, validateControls } from "./lib/protocol";

class TionLite extends utils.Adapter {
    private session?: LiteSession;
    private pollTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;
    private stopping = false;
    private ready = false;
    private lastState?: LiteState;
    private reconnectDelay = 5000;
    private pendingControls = 0;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "tion_lite" });
        this.on("ready", () => {
            void this.onReady().catch(error => this.log.error(errorText(error)));
        });
        this.on("stateChange", (id, state) => {
            void this.onStateChange(id, state).catch(error => this.log.error(errorText(error)));
        });
        this.on("unload", callback => this.onUnload(callback));
    }

    private async createStates(): Promise<void> {
        for (const id of ["info", "control", "sensors", "diagnostics", "commands"]) {
            await this.setObjectNotExistsAsync(id, { type: "channel", common: { name: id }, native: {} });
        }
        const definitions: [string, ioBroker.StateCommon][] = [
            [
                "info.connection",
                { name: "Device ready", type: "boolean", role: "indicator.connected", read: true, write: false },
            ],
            ["info.address", { name: "Bluetooth address", type: "string", role: "text", read: true, write: false }],
            ["info.name", { name: "Device name", type: "string", role: "text", read: true, write: false }],
            ["info.model", { name: "Configured model", type: "string", role: "text", read: true, write: false }],
            [
                "info.firmwareVersion",
                { name: "Firmware version (raw)", type: "number", role: "value", read: true, write: false },
            ],
            [
                "info.firmwareHex",
                { name: "Firmware version (hex)", type: "string", role: "text", read: true, write: false },
            ],
            [
                "info.lastSeen",
                { name: "Last valid response", type: "number", role: "value.time", read: true, write: false },
            ],
            ["control.power", { name: "Power", type: "boolean", role: "switch.power", read: true, write: true }],
            [
                "control.heaterEnabled",
                { name: "Heater enabled", type: "boolean", role: "switch", read: true, write: true },
            ],
            [
                "control.targetTemperature",
                {
                    name: "Heater target temperature",
                    type: "number",
                    role: "level.temperature",
                    read: true,
                    write: true,
                    unit: "°C",
                    min: 0,
                    max: this.config.maxTemperature,
                    step: 1,
                },
            ],
            [
                "control.fanSpeed",
                { name: "Fan speed", type: "number", role: "level", read: true, write: true, min: 1, max: 6, step: 1 },
            ],
            [
                "sensors.inputTemperature",
                {
                    name: "Inlet temperature",
                    type: "number",
                    role: "value.temperature",
                    read: true,
                    write: false,
                    unit: "°C",
                },
            ],
            [
                "sensors.heaterPresent",
                { name: "Heater installed", type: "boolean", role: "indicator", read: true, write: false },
            ],
            [
                "diagnostics.errorMask",
                { name: "Device error/warning mask", type: "number", role: "value", read: true, write: false },
            ],
            [
                "diagnostics.lastError",
                { name: "Last communication/command error", type: "string", role: "text", read: true, write: false },
            ],
            [
                "diagnostics.commandStatus",
                { name: "Command status", type: "string", role: "text", read: true, write: false },
            ],
            [
                "commands.refresh",
                { name: "Read device state", type: "boolean", role: "button", read: false, write: true },
            ],
        ];
        for (const [id, common] of definitions) {
            await this.extendObjectAsync(id, { type: "state", common, native: {} });
        }
    }

    private async onReady(): Promise<void> {
        // Validate even when config is edited outside the admin UI.
        this.config.maxTemperature = Number(this.config.maxTemperature ?? 25);
        await this.createStates();
        await this.setStateAsync("info.connection", false, true);
        await this.setStateAsync("diagnostics.commandStatus", "idle", true);
        if (
            !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(this.config.address ?? "") ||
            !/^hci\d+$/.test(this.config.hci ?? "") ||
            !Number.isInteger(this.config.pollInterval) ||
            this.config.pollInterval < 5 ||
            this.config.pollInterval > 3600 ||
            !Number.isInteger(this.config.responseTimeout) ||
            this.config.responseTimeout < 1000 ||
            this.config.responseTimeout > 10000 ||
            ![25, 30].includes(this.config.maxTemperature)
        ) {
            await this.reportError(
                "Configure a BLE MAC address, hci adapter, poll interval 5–3600 s, timeout 1000–10000 ms and temperature limit 25 or 30 °C",
            );
            return;
        }
        this.config.address = this.config.address.toUpperCase();
        await this.setStateAsync("info.address", this.config.address, true);
        await this.setStateAsync("info.model", "BR_LITE", true);
        await this.subscribeStatesAsync("control.*");
        await this.subscribeStatesAsync("commands.refresh");
        await this.connectDevice();
    }

    private async reportError(message: string): Promise<void> {
        this.log.warn(message);
        await this.setStateAsync("diagnostics.lastError", message, true);
    }

    private publishState(state: LiteState): void {
        this.lastState = state;
        const values: Record<string, ioBroker.StateValue> = {
            "control.power": state.power,
            "control.heaterEnabled": state.heaterEnabled,
            "control.targetTemperature": state.targetTemperature,
            "control.fanSpeed": state.fanSpeed,
            "sensors.inputTemperature": state.inputTemperature,
            "sensors.heaterPresent": state.heaterPresent,
            "diagnostics.errorMask": state.errorMask,
            "info.lastSeen": Date.now(),
        };
        for (const [id, val] of Object.entries(values)) {
            void this.setStateAsync(id, val, true).catch(error => this.log.error(errorText(error)));
        }
    }

    private async connectDevice(): Promise<void> {
        if (this.stopping || this.session) {
            return;
        }
        const session = new LiteSession(
            new HciTransport(this.config.address, this.config.hci),
            {
                state: state => {
                    if (this.session === session) {
                        this.publishState(state);
                    }
                },
                info: info => {
                    if (this.session === session) {
                        void Promise.all([
                            this.setStateAsync("info.firmwareVersion", info.firmwareVersion, true),
                            this.setStateAsync("info.firmwareHex", info.firmwareHex, true),
                        ]).catch(error => this.log.error(errorText(error)));
                    }
                },
                invalid: error => this.log.debug(`Discarded BLE packet: ${errorText(error)}`),
                disconnected: error => {
                    void this.connectionFailed(session, error).catch(err => this.log.error(errorText(err)));
                },
            },
            this.config.responseTimeout,
        );
        this.session = session;
        try {
            const identity = await session.initialize();
            if (this.session !== session || this.stopping) {
                return;
            }
            this.ready = true;
            this.reconnectDelay = 5000;
            await this.setStateAsync("info.name", identity.name, true);
            await this.setStateAsync("info.connection", true, true);
            await this.setStateAsync("diagnostics.lastError", "", true);
            this.log.info(`Connected to ${identity.name} (${identity.address}) via ${this.config.hci}`);
            this.schedulePoll(session);
        } catch (error) {
            await this.connectionFailed(session, error);
        }
    }

    private async connectionFailed(session: LiteSession, error: unknown): Promise<void> {
        if (this.session !== session) {
            return;
        }
        this.session = undefined;
        this.ready = false;
        this.lastState = undefined;
        clearTimeout(this.pollTimer);
        session.close();
        await this.setStateAsync("info.connection", false, true);
        await this.setStateAsync("diagnostics.commandStatus", "failed", true);
        await this.reportError(errorText(error));
        if (!this.stopping) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
                void this.connectDevice().catch(err => this.log.error(errorText(err)));
            }, this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
        }
    }

    private schedulePoll(session: LiteSession): void {
        clearTimeout(this.pollTimer);
        if (this.stopping || this.session !== session) {
            return;
        }
        this.pollTimer = setTimeout(() => {
            if (this.pendingControls) {
                this.schedulePoll(session);
                return;
            }
            void session
                .refresh()
                .then(() => this.schedulePoll(session))
                .catch(error => this.connectionFailed(session, error))
                .catch(error => this.log.error(errorText(error)));
        }, this.config.pollInterval * 1000);
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || this.stopping) {
            return;
        }
        const local = id.slice(this.namespace.length + 1);
        const refresh = local === "commands.refresh";
        const key = local.startsWith("control.") ? (local.slice(8) as keyof Controls) : undefined;
        if (!refresh && (!key || !["power", "heaterEnabled", "targetTemperature", "fanSpeed"].includes(key))) {
            return;
        }
        if (refresh && state.val !== true) {
            return;
        }
        const session = this.session;
        let executing = false;
        try {
            if (!session || !this.ready) {
                throw new Error("Device is not ready; wait for info.connection=true");
            }
            if (refresh) {
                await session.refresh();
            } else if (key) {
                const patch = { [key]: state.val } as Partial<Controls>;
                validateControls(patch);
                if (key === "targetTemperature" && (state.val as number) > this.config.maxTemperature) {
                    throw new Error(`Configured temperature limit is ${this.config.maxTemperature} °C`);
                }
                // Bound bursts rather than replaying an unlimited backlog of old control changes.
                if (this.pendingControls >= 10) {
                    throw new Error("Too many pending control commands");
                }
                this.pendingControls++;
                executing = true;
                await this.setStateAsync("diagnostics.commandStatus", "pending", true);
                await session.update(patch);
                if (this.session === session) {
                    await this.setStateAsync("diagnostics.lastError", "", true);
                    await this.setStateAsync(
                        "diagnostics.commandStatus",
                        this.pendingControls > 1 ? "pending" : "confirmed",
                        true,
                    );
                }
            }
        } catch (error) {
            if (session && this.session !== session) {
                return;
            }
            await this.reportError(errorText(error));
            if (key && this.lastState) {
                // Restore observed value, never acknowledge an unconfirmed desired value.
                await this.setStateAsync(local, { val: this.lastState[key], ack: true, q: 0x44 });
            }
            await this.setStateAsync("diagnostics.commandStatus", "failed", true);
            if (session && (executing || refresh)) {
                await this.connectionFailed(session, error);
            }
        } finally {
            if (executing) {
                this.pendingControls--;
            }
            if (refresh) {
                await this.setStateAsync("commands.refresh", false, true);
            }
        }
    }

    private onUnload(callback: () => void): void {
        this.stopping = true;
        this.ready = false;
        clearTimeout(this.pollTimer);
        clearTimeout(this.reconnectTimer);
        let called = false;
        const finish = (): void => {
            if (!called) {
                called = true;
                callback();
            }
        };
        const timer = setTimeout(finish, 1000);
        try {
            this.session?.close();
            this.session = undefined;
            void this.setStateAsync("info.connection", false, true)
                .catch(() => {})
                .finally(() => {
                    clearTimeout(timer);
                    finish();
                });
        } catch {
            clearTimeout(timer);
            finish();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new TionLite(options);
} else {
    new TionLite();
}
