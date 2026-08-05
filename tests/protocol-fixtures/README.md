# Frozen client compatibility fixture

`frozen-client.json` is serialized wire data, not a TypeScript fixture. Keeping
it independent of current client types ensures a server-side parser change
cannot silently rewrite the compatibility evidence it is meant to test.

The initial release is protocol v1. There is no deployed v0 client, so the
fixture is deliberately marked `initial-v1-baseline` and freezes the current v1
client shapes. The compatibility check is active now without inventing a v0
contract.

When protocol N advances:

1. Before changing the client, freeze the complete outgoing N−1 client frame
   set in this file using values produced by that shipped client.
2. For the v1→v2 transition, keep the existing v1 frames unchanged and change
   only the fixture role to `prior-client`; they become the real N−1 fixture.
3. Set `protocolVersion` to N−1. Update the checker’s required case list if the
   outgoing client added or removed frame shapes.
4. Implement the current server parser so it accepts both N and N−1 without
   interpreting any other version. Keep both paths for at least the normal
   10-minute session plus reconnect margin.
5. Run `npm run protocol:compat` and the current protocol/server tests. CI must
   pass both before rollout.
6. On the following version advance, replace the frozen frames with the actual
   outgoing client N data; Git history retains the older fixture.

If backward interpretation is impossible, the authority returns
`UNSUPPORTED_VERSION` with `reloadRequired: true` and closes with WebSocket code
1002. The browser treats either signal as terminal and asks the user to reload;
it must not enter a reconnect loop.
