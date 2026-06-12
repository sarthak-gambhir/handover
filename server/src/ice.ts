import { config } from "./config.js";

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/** Build the ICE server list. STUN-only by default; TURN added when configured. */
export function iceServers(): IceServer[] {
  const servers: IceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  if (config.turnUrl) {
    servers.push({
      urls: config.turnUrl,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }
  return servers;
}
