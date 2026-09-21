// Wire limits shared by the codec and the transport (WIRE-02, RES-02):
// outgoing commands are bounded to 128 KiB and incoming transport messages
// to 1 MiB.
export const maximumCommandBytes = 128 * 1024;
export const maximumMessageBytes = 1024 * 1024;
