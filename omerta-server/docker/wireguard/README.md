# WireGuard VPN-only dashboard

Recommended production setup:

1. Install WireGuard on the VPS.
2. Create a VPN subnet such as `10.8.0.0/24`.
3. Put your creator device on that VPN.
4. Keep Nginx `creator.example.com` locked to the VPN subnet.
5. Do not expose the Creator Dashboard publicly.

This folder is a placeholder for your final WireGuard config. Do not commit private keys.
