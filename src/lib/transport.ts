/** Backend contract used by the protocol session and test doubles. */
export interface Transport {
    /** Receives a raw BLE notification including the fragment marker. */
    onData: (data: Buffer) => void;
    /** Reports a lost connection or controller failure. */
    onDisconnect: (reason: Error) => void;
    /** Resolve GATT and subscribe before returning the device identity. */
    connect(): Promise<{
        /** Advertised or cached Bluetooth name. */
        name: string;
        /** Configured device address. */
        address: string;
    }>;
    /**
     * Write one BLE fragment.
     *
     * @param frame Fragment bytes including marker.
     * @param withResponse Use an ATT write request instead of command.
     */
    write(frame: Buffer, withResponse: boolean): Promise<void>;
    /** Cancel this client and release controller resources. */
    close(): void;
}
/**
 * Format unknown failures for ioBroker diagnostics.
 *
 * @param error Caught error or transport failure.
 */
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
