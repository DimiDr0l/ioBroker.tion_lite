/* eslint-disable @typescript-eslint/require-await -- In-memory adapter methods implement ioBroker's async API. */
import { EventEmitter } from "node:events";
import Module from "node:module";
import { describe, it } from "mocha";
import { expect } from "chai";
import type { Controls, LiteState } from "./protocol";

class MemoryAdapter extends EventEmitter {
    public namespace = "tion_lite.0";
    public config = { address: "", hci: "hci0", pollInterval: 5, responseTimeout: 3000, maxTemperature: 25 };
    public objects = new Map<string, { common: ioBroker.StateCommon }>();
    public states = new Map<string, { val: ioBroker.StateValue; ack: boolean; q?: number }>();
    public log = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
    public async setObjectNotExistsAsync(): Promise<void> {}
    public async extendObjectAsync(id: string, object: { common: ioBroker.StateCommon }): Promise<void> {
        this.objects.set(id, object);
    }
    public async setStateAsync(
        id: string,
        value: ioBroker.StateValue | { val: ioBroker.StateValue; ack: boolean; q?: number },
        ack?: boolean,
    ): Promise<void> {
        this.states.set(id, value && typeof value === "object" ? value : { val: value, ack: !!ack });
    }
    public async subscribeStatesAsync(): Promise<void> {}
}

interface Controller extends MemoryAdapter {
    ready: boolean;
    session?: { update(patch: Partial<Controls>): Promise<void>; refresh(): Promise<void>; close(): void };
    onReady(): Promise<void>;
    onStateChange(id: string, state: Partial<ioBroker.State>): Promise<void>;
    publishState(state: LiteState): void;
    onUnload(callback: () => void): void;
}

function controller(): Controller {
    // Substitute only adapter-core; keep the actual TionLite implementation under test.
    const corePath = require.resolve("@iobroker/adapter-core");
    const mainPath = require.resolve("../main");
    const previousCore = require.cache[corePath];
    const previousMain = require.cache[mainPath];
    const fake = new Module(corePath);
    fake.exports = { Adapter: MemoryAdapter };
    require.cache[corePath] = fake;
    delete require.cache[mainPath];
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load only after installing the adapter-core test double.
        const create = require(mainPath) as () => Controller;
        return create();
    } finally {
        if (previousCore) {
            require.cache[corePath] = previousCore;
        } else {
            delete require.cache[corePath];
        }
        if (previousMain) {
            require.cache[mainPath] = previousMain;
        } else {
            delete require.cache[mainPath];
        }
    }
}

const observed: LiteState = {
    power: false,
    heaterEnabled: false,
    heaterPresent: true,
    targetTemperature: 22,
    fanSpeed: 2,
    inputTemperature: -4,
    sound: true,
    light: false,
    temperaturePresets: [18, 22, 25],
    fanPresets: [1, 3, 6],
    filterRemainingSeconds: 100,
    errorMask: 0,
};

describe("ioBroker control integration", () => {
    it("creates required states and fails clearly without a configured address", async () => {
        const adapter = controller();
        await adapter.onReady();
        expect(adapter.states.get("info.connection")?.val).to.equal(false);
        expect(adapter.states.get("diagnostics.lastError")?.val).to.contain("Configure a BLE MAC");
        expect(adapter.objects.get("control.targetTemperature")?.common).to.include({ min: 0, max: 25, write: true });
        expect(adapter.objects.get("info.firmwareHex")?.common.write).to.equal(false);
    });
    it("ignores acknowledged events and routes each supported command with a readback status", async () => {
        const adapter = controller();
        const patches: Partial<Controls>[] = [];
        adapter.ready = true;
        adapter.session = {
            update: async patch => {
                patches.push(patch);
                adapter.publishState({ ...observed, ...patch });
            },
            refresh: async () => {},
            close: () => {},
        };
        await adapter.onStateChange("tion_lite.0.control.power", { val: true, ack: true });
        expect(patches).to.have.length(0);
        for (const [key, val] of Object.entries({
            power: true,
            heaterEnabled: true,
            targetTemperature: 25,
            fanSpeed: 6,
        })) {
            await adapter.onStateChange(`tion_lite.0.control.${key}`, { val, ack: false });
            expect(adapter.states.get(`control.${key}`)).to.include({ val, ack: true });
            expect(adapter.states.get("diagnostics.commandStatus")?.val).to.equal("confirmed");
        }
        expect(patches).to.deep.equal([
            { power: true },
            { heaterEnabled: true },
            { targetTemperature: 25 },
            { fanSpeed: 6 },
        ]);
        await new Promise<void>(resolve => adapter.onUnload(resolve));
    });
    it("rejects wrong types/ranges and does not acknowledge a failed desired value", async () => {
        const adapter = controller();
        adapter.ready = true;
        let calls = 0;
        adapter.session = {
            update: async () => {
                calls++;
                throw new Error("readback mismatch");
            },
            refresh: async () => {},
            close: () => {},
        };
        adapter.publishState(observed);
        for (const [key, val] of [
            ["power", "true"],
            ["fanSpeed", 0],
            ["targetTemperature", 26],
        ] as const) {
            await adapter.onStateChange(`tion_lite.0.control.${key}`, { val, ack: false });
        }
        expect(calls).to.equal(0);
        await adapter.onStateChange("tion_lite.0.control.power", { val: true, ack: false });
        expect(adapter.states.get("control.power")).to.include({ val: false, ack: true });
        expect(adapter.states.get("diagnostics.commandStatus")?.val).to.equal("failed");
        expect(adapter.states.get("info.connection")?.val).to.equal(false);
        await new Promise<void>(resolve => adapter.onUnload(resolve));
    });
});
