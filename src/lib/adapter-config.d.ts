declare global {
    namespace ioBroker {
        interface AdapterConfig {
            address: string;
            hci: string;
            pollInterval: number;
            responseTimeout: number;
            maxTemperature: number;
        }
    }
}
export {};
