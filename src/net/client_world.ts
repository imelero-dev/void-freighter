// Online play: REST auth + WebSocket world mirror (ClientWorld implements
// IWorld). Full implementation lands with the server milestone.

import type { IWorld } from '../world_api';

export async function connectOnline(username: string, password: string, register: boolean): Promise<IWorld> {
  throw new Error('online play: server not implemented yet — coming in the multiplayer milestone');
}
